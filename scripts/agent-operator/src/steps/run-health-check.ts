/**
 * `agent-operator/steps/run-health-check` — the fleet health-check workload:
 * a real, policy-gated, read-only pass over the `m3l` fleet through the
 * Bedrock tool loop, ending in an anomaly summary and an exit code a
 * scheduler can act on.
 *
 * @packageDocumentation
 *
 * ## An unhealthy fleet exits 6, not 0 and not a throw
 *
 * | Condition                                   | Outcome       | Exit |
 * | ------------------------------------------- | ------------- | ---- |
 * | Loop completed, zero anomalies              | `success`     | 0    |
 * | 1+ fleet anomaly, gated refusal, or ceiling | `partial`     | 6    |
 * | Ctrl-C / `signal`                           | `interrupted` | 5    |
 * | A Bedrock transport/API failure             | `failure`     | 3    |
 * | Every declared model exhausted              | `failure`     | 2    |
 *
 * The last two rows differ, and the split is the library's, not this
 * module's: `core/errors/catalog.ts` classifies
 * `ERR_BEDROCK_RUNTIME_OPERATION` as `origin: "external"` (exit 3) but
 * `ERR_BEDROCK_RUNTIME_NO_MODEL` as `origin: "caller"` (exit 2) — "every
 * model you declared is unavailable" is your model list being wrong, not an
 * external fault. Both are pinned by a `test.each` through the real
 * `deriveCommandOutcome` then `mapCommandOutcomeToExitCode`, because the
 * distinction is easy to assume the other way round.
 *
 * **Exit 0 would be wrong.** `core/script/run-script.ts` states the governing
 * principle: *"the exit code is the only thing a scheduler reads."* This
 * workload exists for unattended monitoring; exiting 0 on a blocking `doctor`
 * failure means cron sees green while the fleet is broken.
 *
 * **Throwing would be wrong twice.** ADR-0049 classifies exit 1–4 by *fault
 * origin*, and a fleet script reporting a failing status is none of them —
 * the health check *worked*. Exit 3 would make "Bedrock is unreachable" and
 * "the fleet is unhealthy" indistinguishable, destroying the one
 * discrimination this workload exists to provide. And mechanically, throwing
 * from `mainFn` means the anomaly summary — the deliverable — is never
 * written.
 *
 * `partial` is defined for exactly this: *"the run completed with absorbed
 * per-item failures — neither success nor failure"*. `steps/gate-tool`
 * already calls `reportRecovery` on every refusal, so a policy refusal lands
 * on the same 6, coherently.
 *
 * Note the CLI seam's documented asymmetry is scoped to the **tool** —
 * `doctor` exiting 1 must *resolve* `surface.doctor()`. That says nothing
 * about this script's own exit code, and the two must not be conflated.
 *
 * ## Three ordering constraints
 *
 * 1. **`createMeteredInvoker` is constructed BEFORE the preflight.** It seeds
 *    `observeSpend({tokens: 0, loopIterations: 0, cost: 0})` at construction,
 *    because zero spend must be an *observed* fact. Built after the
 *    preflight, the preflight escalates on
 *    `budget.tokens-per-run.unobservable` and the run dies before a single
 *    tool exists. Constructing the client makes no network call, so this
 *    costs nothing on a run the preflight then refuses.
 * 2. **`modelRates` must cover `modelId` and every `fallbackModelIds`
 *    entry.** `sumObservedCost` returns `undefined` the moment a served model
 *    lacks a rate, which makes `snapshot()` omit `costThisRun`, which makes
 *    *every subsequent gated call* escalate on
 *    `budget.cost-per-run.unobservable` and get refused. The seeded `0`
 *    covers turn 0 only.
 * 3. **The same `rates` map object goes to both `createMeteredInvoker` and
 *    `runBedrockToolLoop`.** A conditional spread on one side only creates a
 *    divergence `reconcileMeteredCost` would then correctly, confusingly,
 *    throw on.
 *
 * Plus: **one shared recorder instance** across the preflight and the gate
 * deps, or the audit trail splits across two identities.
 */

import { dirname } from "node:path";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { AGENT_NAME_DEFAULT, POLICY_FILE_DEFAULT } from "../config.js";
import { createAgentCliSurface } from "../lib/cli-surface.js";
import type { AgentCliSurface } from "../lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { buildAgentToolRegistry } from "./build-tool-registry.js";
import { buildHealthTools } from "./build-health-tools.js";
import { createInvoker } from "./create-invoker.js";
import { openDailyInvocationCounter } from "./daily-counter.js";
import type { AgentDailyInvocationCounter } from "./daily-counter.js";
import { AgentDecisionRecorder, agentIdentity } from "./decision-recorder.js";
import { AgentHealthObservations } from "./health-observations.js";
import {
  healthCheckSystemPrompt,
  healthCheckUserPrompt,
} from "./health-prompt.js";
import { buildHealthReport, writeHealthReport } from "./health-report.js";
import type { AgentHealthAnomaly } from "./health-report.js";
import { loadAgentPolicy } from "./load-policy.js";
import {
  createMeteredInvoker,
  reconcileMeteredCost,
} from "./metering-invoker.js";
import type { MeteredInvoker } from "./metering-invoker.js";
import { runDecisionLogPreflight } from "./preflight-log.js";
import { resolveAgentOperatorRuntime } from "./resolve-runtime.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";
import { AgentRunLedger } from "./run-ledger.js";

/** Everything {@link runHealthCheck} needs, injected rather than reached for. */
export interface RunHealthCheckDeps {
  /** The resolved configuration store. */
  readonly config: Core.M3LConfig;
  /** The script's logger. */
  readonly logger: Core.M3LLogger;
  /** The script's paths port. */
  readonly paths: Core.M3LPaths;
  /** The script's cooperative-cancellation signal. */
  readonly signal: AbortSignal;
  /** Bound from `script.reportRecovery` — what demotes the run to `partial`. */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
  /** The provisioned AWS facade from `script.aws`. */
  readonly aws: Core.M3LScript["aws"];
}

/**
 * The action the *run itself* submits for judgement in the preflight — the
 * same shape the audit-spine slice established. Per-tool actions are
 * declared by `steps/build-health-tools` instead.
 */
function healthCheckAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: [
      "command",
      "policyFile",
      "decisionLogDir",
      "agentName",
      "modelId",
    ],
  };
}

/**
 * Resolves the host workspace root for the model-safety scrub, degrading to
 * `undefined` (scrub off) only on the documented standalone-mode signal, and
 * warning loudly when it does — with the scrub off, absolute host paths in
 * CLI output reach the model unmasked, and an operator reading the run log
 * must be able to see that.
 */
function deriveWorkspaceRoot(
  paths: Core.M3LPaths,
  logger: Core.M3LLogger,
): string | undefined {
  try {
    return paths.getProjectRoot();
  } catch (cause) {
    if (!(cause instanceof Core.M3LPathResolutionError)) throw cause;
    logger.warning(
      "workspace-root scrub disabled: the project root could not be resolved (standalone mode), so absolute host paths in CLI output are no longer masked before the model reads them",
      { scrub: "workspace-root", enabled: false },
    );
    return undefined;
  }
}

/** Builds the typed `m3l` CLI adapter the four tools drive. */
function buildSurface(
  deps: RunHealthCheckDeps,
  runtime: AgentOperatorRuntimeSettings,
  workspaceRoot: string | undefined,
): AgentCliSurface {
  return createAgentCliSurface({
    entrypoint: runtime.cliEntrypoint,
    cwd: dirname(runtime.cliEntrypoint),
    nodeExecPath: process.execPath,
    cliTimeoutMs: runtime.cliTimeoutMs,
    dryRunTimeoutMs: runtime.dryRunTimeoutMs,
    maxOutputBytes: runtime.maxOutputBytes,
    // Layer two of `script_dry_run`'s two independent fail-closed layers (the
    // first being that its spec is not built at all): an unset or false flag
    // hands the surface an EMPTY set, so a `dryRunAllowlist` left in config —
    // or added ahead of the flag — can never silently arm the probe.
    dryRunAllowlist: runtime.includeDryRunProbes
      ? new Set(runtime.dryRunAllowlist)
      : new Set<string>(),
    signal: deps.signal,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
}

/**
 * Opens the cross-run daily counter and seeds the ledger's per-day baseline.
 *
 * Must run **before** the preflight: `runDecisionLogPreflight` snapshots the
 * ledger twice, and budgets are evaluator step 3 while the decision-log rule
 * is step 3b — so against a policy declaring `invocationsPerDay` an unseeded
 * ledger escalates at *both* phases and the two-phase bootstrap can never
 * resolve.
 */
async function seedDailyCounter(
  deps: RunHealthCheckDeps,
  ledger: AgentRunLedger,
  now: number,
): Promise<AgentDailyInvocationCounter> {
  const counter = await openDailyInvocationCounter({ paths: deps.paths, now });
  counter.seed(ledger);
  deps.logger.info("cross-run daily invocation baseline loaded", {
    step: "daily-counter-loaded",
    priorToday: counter.priorToday,
  });
  return counter;
}

/** Loads the declared policy and logs the milestone. */
async function loadPolicy(
  deps: RunHealthCheckDeps,
  accessor: Core.M3LConfigAccessor,
): Promise<Core.M3LAgentPolicy> {
  const policy = await loadAgentPolicy({
    paths: deps.paths,
    policyFile: accessor.optionalString("policyFile") ?? POLICY_FILE_DEFAULT,
  });
  deps.logger.info("agent policy loaded", { step: "policy-loaded" });
  return policy;
}

/** Builds the decision recorder — ONE instance, shared by preflight and gate. */
function buildRecorder(
  accessor: Core.M3LConfigAccessor,
): AgentDecisionRecorder {
  const directory = accessor.optionalString("decisionLogDir");
  const writer =
    directory === undefined
      ? new Core.M3LAgentDecisionLog()
      : new Core.M3LAgentDecisionLog({ directory });
  return new AgentDecisionRecorder({
    identity: agentIdentity({
      name: accessor.optionalString("agentName") ?? AGENT_NAME_DEFAULT,
      modelId: accessor.optionalString("modelId"),
    }),
    writer,
  });
}

/**
 * Fails the run when the preflight's concluding verdict is not an
 * auto-approval, so a run the policy declined can never reach the model.
 *
 * The gate is `Core.isAgentActionAutoApproved`, never a literal comparison:
 * the closed verdict set is `auto-approved | escalate | denied`, so
 * `verdict !== "denied"` would wave every escalation through. Only the
 * library-authored `verdict`/`rule` are surfaced — no config value reaches
 * the message or the context.
 */
function assertConclusionAutoApproved(decision: Core.M3LAgentDecision): void {
  if (Core.isAgentActionAutoApproved(decision)) return;
  throw new M3LAgentOperatorCliError(
    "the run concluded without an auto-approved verdict: the deployment policy declined to auto-approve this action, so it requires human escalation",
    "ERR_AGENT_OPERATOR_ESCALATED",
    { context: { verdict: decision.verdict, rule: decision.rule } },
  );
}

/**
 * Persists the run's invocation count onto the cross-run daily counter.
 *
 * @remarks
 * Called from a `finally`, so it runs whether the loop completed, breached a
 * ceiling, or threw — a crash mid-loop must not forget invocations that were
 * already made and already billed. A failure to write is logged and reported
 * as an absorbed failure rather than rethrown, for the reason
 * `steps/gate-tool`'s `recordExecutionFailure` documents: letting it escape
 * from a `finally` would REPLACE whatever the loop was already throwing,
 * discarding the original failure's classification. This is not swallowing —
 * it reaches the logger and `reportRecovery`, so the run cannot report a
 * silent `success`.
 */
async function recordConsumption(
  counter: AgentDailyInvocationCounter,
  ledger: AgentRunLedger,
  deps: RunHealthCheckDeps,
  now: number,
): Promise<void> {
  try {
    await counter.record(ledger.invocationCount);
  } catch (cause) {
    deps.logger.error(
      "the cross-run daily invocation counter could not be updated; today's recorded spend is now behind by this run's invocations",
      { invocations: ledger.invocationCount },
    );
    deps.reportRecovery({
      item: "daily-invocation-counter",
      error: Core.serializeErrorChain(cause, { redact: true }),
      recordedAt: new Date(now).toISOString(),
    });
  }
}

/** What {@link runLoop} produced, with a ceiling breach already absorbed. */
interface HealthLoopResult {
  /** The loop's outcome, or `undefined` when a ceiling cut the run short. */
  readonly outcome: AWS.M3LBedrockToolLoopOutcome | undefined;
  /** The absorbed ceiling breach, when there was one. */
  readonly ceilingBreach: string | undefined;
}

/**
 * Drives `runBedrockToolLoop`, absorbing **only** a ceiling breach.
 *
 * @remarks
 * The catch is narrow and class-discriminated on purpose:
 *
 * - A ceiling breach is absorbed into an anomaly. Destroying already-collected
 *   fleet findings because the model was chatty is the wrong trade.
 * - Model unavailability is **not** absorbed. No turn happened, and a
 *   scheduler must be able to tell a `partial` 6 from a hard failure.
 * - A widened `instanceof Core.M3LError` would swallow
 *   `M3LOperationAbortedError` and break Ctrl-C → 5. Do not widen it.
 */
async function runLoop(
  invoker: AWS.M3LBedrockToolLoopInvoker,
  tools: AWS.M3LBedrockToolRegistry,
  runtime: AgentOperatorRuntimeSettings,
  deps: RunHealthCheckDeps,
  includeDryRunProbe: boolean,
): Promise<HealthLoopResult> {
  const conversation = AWS.createBedrockConversation({
    system: healthCheckSystemPrompt(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: healthCheckUserPrompt({
              scripts: runtime.scripts,
              dryRunProbesEnabled: includeDryRunProbe,
            }),
          },
        ],
      },
    ],
  });

  try {
    const outcome = await AWS.runBedrockToolLoop(invoker, conversation, {
      tools,
      maxIterations: runtime.maxIterations,
      maxToolsPerTurn: runtime.maxToolsPerTurn,
      signal: deps.signal,
      // THE SAME map object the metered invoker was built with — see
      // ordering constraint 3 on this module.
      rates: runtime.modelRates,
      inferenceConfig: { maxTokens: runtime.maxOutputTokens },
    });
    return { outcome, ceilingBreach: undefined };
  } catch (cause) {
    if (!(cause instanceof AWS.M3LBedrockToolLoopError)) throw cause;
    deps.logger.warning(
      "the agent loop hit a declared ceiling before the model finished; every finding collected so far is still reported",
      { step: "loop-ceiling" },
    );
    return {
      outcome: undefined,
      // The library's own message names the ceiling and carries no model
      // text or host path — see `M3LBedrockToolLoopError`.
      ceilingBreach: cause.message,
    };
  }
}

/**
 * Writes the run's **third** decision-log entry: what the authorized run
 * actually cost.
 *
 * @remarks
 * JSONL is append-only, so this is a third entry rather than an amendment of
 * the second. It re-records `decision` rather than re-evaluating: the
 * question it answers is *"what did the authorized run cost"*, not *"would
 * it be authorized now"* — those are different questions, and re-evaluating
 * would answer the second while looking like the first. **A reviewer should
 * check this trade explicitly.**
 *
 * It is the first caller ever to populate the `tokens`/`cost` fields
 * ADR-0061 added. `cost` is spread conditionally: an unpriceable run must
 * leave the key absent, not present holding `undefined`.
 */
async function recordConclusion(
  recorder: AgentDecisionRecorder,
  decision: Core.M3LAgentDecision,
  now: number,
  tokens: number,
  cost: number | undefined,
): Promise<void> {
  await recorder.record({
    decision,
    now,
    outcome: { dryRun: false, exitCode: 0 },
    tokens,
    ...(cost === undefined ? {} : { cost }),
  });
}

/** Reports every anomaly as an absorbed failure, demoting the run to `partial`. */
function reportAnomalies(
  anomalies: readonly AgentHealthAnomaly[],
  deps: RunHealthCheckDeps,
  now: number,
): void {
  const recordedAt = new Date(now).toISOString();
  for (const anomaly of anomalies) {
    deps.reportRecovery({
      item: anomaly.subject,
      error: [{ name: anomaly.kind, message: anomaly.detail }],
      recordedAt,
    });
  }
}

/**
 * Runs the fleet health check end to end.
 *
 * @param deps - See {@link RunHealthCheckDeps}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 *   `ERR_AGENT_OPERATOR_CONFIG`, `ERR_AGENT_OPERATOR_BUDGET_STATE`,
 *   `ERR_AGENT_OPERATOR_DECISION_LOG`, or `ERR_AGENT_OPERATOR_ESCALATED`; and
 *   `Core.M3LOperationAbortedError` (propagated `instanceof`-intact, so
 *   ADR-0049 classifies Ctrl-C as exit 5) or an
 *   `AWS.M3LBedrockRuntime*Error` when the model itself is unreachable.
 *
 * @example
 * ```ts
 * import type { RunHealthCheckDeps } from "./run-health-check.js";
 * import { runHealthCheck } from "./run-health-check.js";
 *
 * declare const deps: RunHealthCheckDeps;
 * await runHealthCheck(deps);
 * ```
 */
export async function runHealthCheck(deps: RunHealthCheckDeps): Promise<void> {
  const setup = await prepareHealthCheck(deps);
  const { runtime, ledger, recorder, counter, observations, now } = setup;

  const registry = buildAgentToolRegistry(
    buildHealthTools({
      surface: setup.surface,
      observations,
      includeDryRunProbe: setup.includeDryRunProbe,
    }),
    {
      policy: setup.policy,
      ledger,
      recorder,
      // The gate samples its own instant per call — a gated pass must not
      // straddle a clock tick, and it may run minutes after `now`.
      now: () => Date.now(),
      logger: deps.logger,
      reportRecovery: deps.reportRecovery,
    },
  );

  let loop: HealthLoopResult;
  try {
    loop = await runLoop(
      setup.metered.invoker,
      registry,
      runtime,
      deps,
      setup.includeDryRunProbe,
    );
  } finally {
    // Whether the loop completed, breached a ceiling, or threw.
    await recordConsumption(counter, ledger, deps, now);
  }

  await concludeHealthCheck(deps, setup, loop);
}

/** Everything {@link prepareHealthCheck} assembles, in dependency order. */
interface HealthCheckSetup {
  readonly policy: Core.M3LAgentPolicy;
  readonly runtime: AgentOperatorRuntimeSettings;
  readonly ledger: AgentRunLedger;
  readonly recorder: AgentDecisionRecorder;
  readonly counter: AgentDailyInvocationCounter;
  readonly observations: AgentHealthObservations;
  readonly surface: AgentCliSurface;
  readonly metered: MeteredInvoker;
  readonly decision: Core.M3LAgentDecision;
  readonly includeDryRunProbe: boolean;
  readonly workspaceRoot: string | undefined;
  readonly now: number;
}

/**
 * Everything before the loop, in the one order that works: policy, runtime,
 * recorder + ledger, daily seed, CLI surface, metered invoker, preflight,
 * auto-approval gate.
 *
 * Split from {@link runHealthCheck} to stay inside the scripts zone's
 * `max-lines-per-function` budget, not because the two halves are
 * independent — every ordering constraint on this module lives here.
 */
async function prepareHealthCheck(
  deps: RunHealthCheckDeps,
): Promise<HealthCheckSetup> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  // Sampled once for the whole run: the counter's rollover, the ledger's
  // `todayCountedAt`, the preflight's two evaluator calls, and the report's
  // `completedAt` all read the clock this line hands them.
  const now = Date.now();
  const policy = await loadPolicy(deps, accessor);
  const runtime = resolveAgentOperatorRuntime({
    config: deps.config,
    policy,
    paths: deps.paths,
  });

  const ledger = new AgentRunLedger();
  const recorder = buildRecorder(accessor);
  const counter = await seedDailyCounter(deps, ledger, now);

  const workspaceRoot = deriveWorkspaceRoot(deps.paths, deps.logger);
  const includeDryRunProbe =
    runtime.includeDryRunProbes && runtime.dryRunAllowlist.length > 0;
  const surface = buildSurface(deps, runtime, workspaceRoot);

  // BEFORE the preflight — ordering constraint 1. Constructing the client
  // makes no network call, and this is what seeds the observed zero spend
  // that keeps `budget.tokens-per-run` from escalating at the preflight.
  const metered = createMeteredInvoker({
    inner: createInvoker({
      aws: deps.aws,
      models: [runtime.modelId, ...runtime.fallbackModelIds],
    }),
    ledger,
    rates: runtime.modelRates,
  });

  const preflight = await runDecisionLogPreflight({
    policy,
    ledger,
    recorder,
    action: healthCheckAction(),
    now,
  });
  deps.logger.info("decision-log preflight complete", {
    step: "preflight-complete",
    bootstrapVerdict: preflight.bootstrapDecision.verdict,
    bootstrapRule: preflight.bootstrapDecision.rule,
    verdict: preflight.decision.verdict,
    rule: preflight.decision.rule,
  });
  assertConclusionAutoApproved(preflight.decision);

  return {
    policy,
    runtime,
    ledger,
    recorder,
    counter,
    observations: new AgentHealthObservations(),
    surface,
    metered,
    decision: preflight.decision,
    includeDryRunProbe,
    workspaceRoot,
    now,
  };
}

/**
 * Everything after the loop: reconcile cost, record the concluding audit
 * entry, write the artifact, then demote the run.
 *
 * The artifact is written **before** `reportRecovery` fires, so no later
 * branch can cost the deliverable on the unhealthy path — the path it exists
 * for.
 */
async function concludeHealthCheck(
  deps: RunHealthCheckDeps,
  setup: HealthCheckSetup,
  loop: HealthLoopResult,
): Promise<void> {
  const iterations = setup.metered.observedIterations();
  const tokens = iterations.reduce(
    (total, iteration) => total + iteration.usage.totalTokens,
    0,
  );
  // THIS script's own figure, not the library's: `createMeteredInvoker` pushes
  // `sumObservedCost(...)` onto the ledger through `observeSpend`, so the
  // ledger's `costThisRun` IS the locally computed cost — omitted (and so read
  // as `undefined`) exactly when a served model had no declared rate.
  //
  // Reading it back from `loop.outcome.cost` instead would compare the
  // library's figure to itself: the check could never fail, and the local
  // re-implementation of `AWS.computeCost` that `steps/metering-invoker`
  // documents as "made safe by `reconcileMeteredCost`" would be unguarded.
  const cost = setup.ledger.snapshot(setup.now).costThisRun;
  // Only meaningful when the loop actually completed: a ceiling breach has no
  // library-side figure to reconcile against.
  if (loop.outcome !== undefined) {
    reconcileMeteredCost({ metered: cost, reported: loop.outcome.cost });
  }

  await recordConclusion(
    setup.recorder,
    setup.decision,
    setup.now,
    tokens,
    cost,
  );

  const report = buildHealthReport({
    snapshot: setup.observations.snapshot(),
    message: loop.outcome?.message,
    iterations: iterations.length,
    tokens,
    cost,
    stopReason: loop.outcome?.stopReason,
    now: setup.now,
    workspaceRoot: setup.workspaceRoot,
  });
  await writeHealthReport({
    report,
    paths: deps.paths,
    output: setup.runtime.output,
  });
  deps.logger.info("health-check complete", {
    step: "report-written",
    blocking: report.blocking,
    anomalies: report.anomalies.length,
  });

  // After the artifact, never before.
  reportAnomalies(report.anomalies, deps, setup.now);
  if (loop.ceilingBreach !== undefined) {
    deps.reportRecovery({
      item: "agent-loop",
      error: [{ name: "M3LBedrockToolLoopError", message: loop.ceilingBreach }],
      recordedAt: new Date(setup.now).toISOString(),
    });
  }
}
