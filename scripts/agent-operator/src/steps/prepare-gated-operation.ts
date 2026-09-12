/**
 * `agent-operator/steps/prepare-gated-operation` — the operation-agnostic
 * AUTHORIZATION setup shared by every policy-gated `agent-operator` workload:
 * config accessor, policy load, runtime resolution, ledger + recorder,
 * daily-counter seed, workspace-root scrub, CLI surface, metered invoker, and
 * the decision-log preflight itself.
 *
 * Extracted out of `steps/run-health-check.ts` (V9 slice 3b): that module's
 * `prepareHealthCheck` was ~95% operation-agnostic, and a second gated
 * operation (`run-preset`) built as a standalone runner would duplicate the
 * entire preflight — two decision-log preflights, two ledger constructions,
 * two budget seedings — with no gate to catch the two drifting apart. The
 * only piece that differs per operation is the {@link Core.M3LAgentAction}
 * submitted for judgement, so that is the one parameter this module takes
 * that a fixed `prepareHealthCheck` did not.
 *
 * @packageDocumentation
 *
 * ## The same ordering constraints as before, now enforced in one place
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
 *    the caller's own `runBedrockToolLoop` call.** A conditional spread on
 *    one side only creates a divergence `reconcileMeteredCost` would then
 *    correctly, confusingly, throw on — the caller reads `runtime.modelRates`
 *    back off {@link GatedOperationSetup} for exactly this reason.
 *
 * Plus: **one shared recorder instance** across the preflight and the gate
 * deps, or the audit trail splits across two identities.
 */

import { dirname } from "node:path";

import { Core } from "@monte3l/m3l-common";

import { AGENT_NAME_DEFAULT, POLICY_FILE_DEFAULT } from "../config.js";
import { createAgentCliSurface } from "../lib/cli-surface.js";
import type { AgentCliSurface } from "../lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { createInvoker } from "./create-invoker.js";
import { openDailyInvocationCounter } from "./daily-counter.js";
import type { AgentDailyInvocationCounter } from "./daily-counter.js";
import { AgentDecisionRecorder, agentIdentity } from "./decision-recorder.js";
import { loadAgentPolicy } from "./load-policy.js";
import { createMeteredInvoker } from "./metering-invoker.js";
import type { MeteredInvoker } from "./metering-invoker.js";
import { runDecisionLogPreflight } from "./preflight-log.js";
import { resolveAgentOperatorRuntime } from "./resolve-runtime.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";
import { AgentRunLedger } from "./run-ledger.js";

/**
 * Everything {@link prepareGatedOperation} needs, injected rather than
 * reached for.
 *
 * A structural superset of a caller's own deps type (e.g.
 * `RunHealthCheckDeps`) is expected to satisfy this shape, plus `action` —
 * the one field the caller must supply that the shared setup cannot derive
 * on its own.
 */
export interface PrepareGatedOperationDeps {
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
  /**
   * The action the *run itself* submits for judgement in the preflight — the
   * one piece that differs per gated operation. Per-tool actions are
   * declared separately by each operation's own tool-registry step.
   */
  readonly action: Core.M3LAgentAction;
}

/** Everything {@link prepareGatedOperation} assembles, in dependency order. */
export interface GatedOperationSetup {
  /** The loaded agent policy. */
  readonly policy: Core.M3LAgentPolicy;
  /** The resolved, validated runtime settings. */
  readonly runtime: AgentOperatorRuntimeSettings;
  /** The run's budget ledger, seeded from the daily counter. */
  readonly ledger: AgentRunLedger;
  /** The shared decision recorder — ONE instance across preflight and gate. */
  readonly recorder: AgentDecisionRecorder;
  /** The cross-run daily invocation counter, already seeded onto `ledger`. */
  readonly counter: AgentDailyInvocationCounter;
  /** The typed `m3l` CLI adapter the operation's tools drive. */
  readonly surface: AgentCliSurface;
  /** The cost/usage-observing invoker decorator, built before the preflight. */
  readonly metered: MeteredInvoker;
  /** The preflight's concluding, already-auto-approved decision. */
  readonly decision: Core.M3LAgentDecision;
  /** The scrubbed workspace root, or `undefined` with the scrub disabled. */
  readonly workspaceRoot: string | undefined;
  /** The single `Date.now()` sample the whole run reads. */
  readonly now: number;
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

/** Builds the typed `m3l` CLI adapter the operation's tools drive. */
function buildSurface(
  deps: PrepareGatedOperationDeps,
  runtime: AgentOperatorRuntimeSettings,
  workspaceRoot: string | undefined,
): AgentCliSurface {
  return createAgentCliSurface({
    entrypoint: runtime.cliEntrypoint,
    cwd: dirname(runtime.cliEntrypoint),
    nodeExecPath: process.execPath,
    cliTimeoutMs: runtime.cliTimeoutMs,
    dryRunTimeoutMs: runtime.dryRunTimeoutMs,
    flowTimeoutMs: runtime.flowTimeoutMs,
    maxOutputBytes: runtime.maxOutputBytes,
    // Layer two of `script_dry_run`'s two independent fail-closed layers (the
    // first being that its spec is not built at all): an unset or false flag
    // hands the surface an EMPTY set, so a `dryRunAllowlist` left in config —
    // or added ahead of the flag — can never silently arm the probe.
    dryRunAllowlist: runtime.includeDryRunProbes
      ? new Set(runtime.dryRunAllowlist)
      : new Set<string>(),
    // Forwarded verbatim: `resolve-runtime` has already validated every
    // entry's name and workspace-relative path, and this map is the ONLY
    // input the surface's `run` consults. Dropping it (or passing an empty
    // map) leaves the operator's declared grant inert: every mutating call
    // rejects with `cli-surface.ts`'s fixed `PRESET_NAME_REJECTION_MESSAGE`,
    // which is identical across all of its rejection arms (each arm's real
    // reason rides as an operator-only `cause`), so the wiring defect is
    // indistinguishable from an undeclared preset — hence the required option.
    presetAllowlist: runtime.presetAllowlist,
    // Populated from RAW config: the surface's own `flowRun` gate enforces
    // shape and allowlist membership only, at this call site. Definition-level
    // verification (`verifyFlowNames` — one agreed `aws.profile`, no
    // `yesSensitive` step) happens downstream in the `reconcile-queue`
    // runner, and no other operation built from this surface can reach
    // `flowRun`.
    flowAllowlist: runtime.flowAllowlist,
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
  deps: PrepareGatedOperationDeps,
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
  deps: PrepareGatedOperationDeps,
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
 * Assembles everything a policy-gated `agent-operator` operation needs before
 * it may touch the model: policy, runtime, recorder + ledger, daily seed, CLI
 * surface, metered invoker, preflight, auto-approval gate — in the one order
 * that works.
 *
 * @param deps - See {@link PrepareGatedOperationDeps}. `deps.action` is the
 *   only per-operation input; everything else is genuinely shared.
 * @returns The assembled {@link GatedOperationSetup}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 *   `ERR_AGENT_OPERATOR_CONFIG`, `ERR_AGENT_OPERATOR_BUDGET_STATE`,
 *   `ERR_AGENT_OPERATOR_DECISION_LOG`, or `ERR_AGENT_OPERATOR_ESCALATED`.
 *
 * @example
 * ```ts
 * import type { PrepareGatedOperationDeps } from "./prepare-gated-operation.js";
 * import { prepareGatedOperation } from "./prepare-gated-operation.js";
 *
 * declare const deps: PrepareGatedOperationDeps;
 * const setup = await prepareGatedOperation(deps);
 * ```
 */
export async function prepareGatedOperation(
  deps: PrepareGatedOperationDeps,
): Promise<GatedOperationSetup> {
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
    action: deps.action,
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
    surface,
    metered,
    decision: preflight.decision,
    workspaceRoot,
    now,
  };
}
