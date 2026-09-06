/**
 * `agent-operator/steps/run-etl-preset` — the `run-preset` workload: the
 * second policy-gated `agent-operator` operation, running the two-phase
 * `run_preset` tool (`steps/build-etl-tools.ts`) through the real Bedrock
 * tool loop against exactly one ETL-shaped fleet script.
 *
 * @remarks
 * Shares the operation-agnostic AUTHORIZATION setup —
 * accessor, policy load, runtime resolution, ledger + recorder, daily-counter
 * seed, CLI surface, metered invoker construction, and the decision-log
 * preflight — with `steps/run-health-check.ts` via
 * `steps/prepare-gated-operation.ts`'s `prepareGatedOperation`. What differs
 * here: the declared action, a fail-closed `aws.profile` inspection of the
 * target script, and a registry offering exactly one tool.
 *
 * ## The preflight action is read-only, not mutating
 *
 * {@link runPresetAction} declares `kind: "read-only"`. This describes
 * *running the agent*, not the child mutation `run_preset` itself performs —
 * that per-tool action is declared separately by `steps/build-etl-tools.ts`'s
 * `describeAction` and gated per call by `gateTwoPhaseToolSpec`. A `mutating`
 * operation-level action would reach `decideMutation`, which demands a
 * `target` and `dryRunFirst` semantics this run-level action does not carry,
 * and `assertConclusionAutoApproved` would throw before the operation could
 * ever start.
 *
 * ## `scriptDeclaresAwsProfile` must fail closed
 *
 * `surface.inspect(scriptName)` is awaited directly, with no surrounding
 * `try`/`catch`: a rejection propagates as-is. `false` — "the target script
 * declares no `aws.profile` of its own" — is the value that lets
 * `buildEtlTools` construct the mutating tool at all, so silently falling
 * back to `false` on a swallowed inspection failure would risk registering a
 * mutating tool whose judged `target` grades the wrong AWS account. This
 * exact fail-open polarity has already been found and fixed twice elsewhere
 * in this programme.
 *
 * ## The target script has no dedicated config parameter
 *
 * `run-preset` declares no `scriptName` parameter (`config.ts`'s
 * `AGENT_OPERATOR_COMMAND_DECLARATIONS`): the one target script this
 * operation names is read off the same `scripts` list `health-check` uses for
 * its fleet sweep — but unlike that sweep, a MUTATING operation must never let
 * array ordering decide the target, so {@link resolveTargetScript} requires
 * `scripts` to hold EXACTLY ONE entry and refuses otherwise. See its own doc
 * for the constraint.
 *
 * @packageDocumentation
 */

import { AWS, Core } from "@m3l-automation/m3l-common";

import { assertAllowedScriptName } from "../lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { buildEtlTools } from "./build-etl-tools.js";
import { buildAgentToolRegistry } from "./build-tool-registry.js";
import type { AgentDailyInvocationCounter } from "./daily-counter.js";
import type { AgentDecisionRecorder } from "./decision-recorder.js";
import { runPresetSystemPrompt, runPresetUserPrompt } from "./etl-prompt.js";
import { reconcileMeteredCost } from "./metering-invoker.js";
import { prepareGatedOperation } from "./prepare-gated-operation.js";
import type { GatedOperationSetup } from "./prepare-gated-operation.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";
import type { AgentRunLedger } from "./run-ledger.js";

/** Everything {@link runEtlPreset} needs, injected rather than reached for. */
export interface RunEtlPresetDeps {
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
 * The action the *run itself* submits for judgement in the preflight — see
 * the module remarks for why this is `read-only` rather than `mutating`.
 */
function runPresetAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "run-preset",
    kind: "read-only",
    parameterNames: [
      "command",
      "policyFile",
      "decisionLogDir",
      "agentName",
      "modelId",
      Core.AWS_PROFILE_PARAM_NAME,
      "scripts",
      "presetAllowlist",
    ],
  };
}

/**
 * Reads the one target script this operation names off `runtime.scripts`.
 *
 * @remarks
 * `scripts` is a general-purpose fleet list shared with
 * `steps/run-health-check.ts`, which legitimately declares many entries for
 * its sweep. This is a MUTATING operation, so its target must never be
 * decided by array ordering — `scripts[0]` silently accepting a multi-entry
 * list would let an operator's `scripts: ["s3-objects", "json-etl"]` run this
 * operation against `s3-objects` by accident of position. `scripts` must
 * therefore hold EXACTLY ONE entry, or the run refuses outright.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `scripts` does not hold exactly one entry.
 */
function resolveTargetScript(runtime: AgentOperatorRuntimeSettings): string {
  if (runtime.scripts.length !== 1) {
    throw new M3LAgentOperatorCliError(
      "'run-preset' requires 'scripts' to declare EXACTLY ONE entry: the target script this mutating operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  const [target] = runtime.scripts;
  if (target === undefined) {
    // Unreachable given the length check above; narrows the type for
    // `noUncheckedIndexedAccess` without a non-null assertion.
    throw new M3LAgentOperatorCliError(
      "'run-preset' requires 'scripts' to declare EXACTLY ONE entry: the target script this mutating operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return target;
}

/**
 * Resolves whether the target script declares its own `aws.profile`
 * configuration parameter.
 *
 * @remarks
 * **Fails closed.** No `try`/`catch` here — a rejected `surface.inspect` call
 * propagates unchanged. See the module remarks for why defaulting to `false`
 * on a swallowed failure would be unsafe.
 */
async function scriptDeclaresAwsProfile(
  setup: GatedOperationSetup,
  scriptName: string,
): Promise<boolean> {
  const descriptors = await setup.surface.inspect(scriptName);
  return descriptors.some(
    (descriptor) => descriptor.name === Core.AWS_PROFILE_PARAM_NAME,
  );
}

/**
 * Builds the registry offering exactly one tool: the two-phase `run_preset`
 * spec from `steps/build-etl-tools.ts`. The single-phase `specs` array is
 * deliberately empty — keeping the model-reachable surface minimal is
 * intentional, and the allowed preset names reach the model through the
 * prompt instead.
 */
function buildRegistry(
  deps: RunEtlPresetDeps,
  setup: GatedOperationSetup,
  scriptName: string,
  declaresAwsProfile: boolean,
): AWS.M3LBedrockToolRegistry {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  const tools = buildEtlTools({
    surface: setup.surface,
    scriptName: assertAllowedScriptName(scriptName),
    operatorProfile: accessor.requiredString(
      Core.AWS_PROFILE_PARAM_NAME,
      "run-preset",
    ),
    presetAllowlist: setup.runtime.presetAllowlist,
    scriptDeclaresAwsProfile: declaresAwsProfile,
  });
  return buildAgentToolRegistry(
    [],
    {
      policy: setup.policy,
      ledger: setup.ledger,
      recorder: setup.recorder,
      // The gate samples its own instant per call — a gated pass must not
      // straddle a clock tick, and it may run minutes after `setup.now`.
      now: () => Date.now(),
      logger: deps.logger,
      reportRecovery: deps.reportRecovery,
    },
    tools,
  );
}

/**
 * Drives `runBedrockToolLoop` over a conversation offering only `run_preset`.
 *
 * @remarks
 * Unlike `steps/run-health-check.ts`'s `runLoop`, nothing here is absorbed:
 * this workload has no anomaly summary to preserve across a ceiling breach,
 * so every failure — a declared ceiling, model unavailability, or an abort —
 * propagates unchanged to {@link runEtlPreset}'s caller.
 */
async function runLoop(
  invoker: AWS.M3LBedrockToolLoopInvoker,
  tools: AWS.M3LBedrockToolRegistry,
  runtime: AgentOperatorRuntimeSettings,
  deps: RunEtlPresetDeps,
  scriptName: string,
): Promise<AWS.M3LBedrockToolLoopOutcome> {
  const conversation = AWS.createBedrockConversation({
    system: runPresetSystemPrompt(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: runPresetUserPrompt({
              scriptName,
              presetNames: [...runtime.presetAllowlist.keys()],
            }),
          },
        ],
      },
    ],
  });

  return AWS.runBedrockToolLoop(invoker, conversation, {
    tools,
    maxIterations: runtime.maxIterations,
    maxToolsPerTurn: runtime.maxToolsPerTurn,
    signal: deps.signal,
    // THE SAME map object the metered invoker was built with — see
    // `prepare-gated-operation.ts`'s ordering constraint 3.
    rates: runtime.modelRates,
    inferenceConfig: { maxTokens: runtime.maxOutputTokens },
  });
}

/**
 * Persists the run's invocation count onto the cross-run daily counter.
 *
 * @remarks
 * Called from a `finally`, so it runs whether the loop completed or threw —
 * a crash mid-loop must not forget invocations that were already made and
 * already billed. A failure to write is logged and reported as an absorbed
 * failure rather than rethrown: letting it escape from a `finally` would
 * REPLACE whatever the loop was already throwing, discarding the original
 * failure's classification. This is not swallowing — it still reaches the
 * logger and `reportRecovery`, so the run cannot report a silent success.
 */
async function recordConsumption(
  counter: AgentDailyInvocationCounter,
  ledger: AgentRunLedger,
  deps: RunEtlPresetDeps,
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

/**
 * Writes the run's concluding decision-log entry: what the authorized run
 * actually cost.
 *
 * @remarks
 * Mirrors `steps/run-health-check.ts`'s own `recordConclusion` exactly — same
 * shape, same identifying fields (`decision` carries `operation: "run-preset"`
 * / `script: "agent-operator"` / `verdict: "auto-approved"` from
 * {@link runPresetAction}'s judged action). JSONL is append-only, so
 * this is a further entry rather than an amendment of the preflight's own
 * bootstrap entry, which never carries `tokens`/`cost`. `cost` is spread
 * conditionally: an unpriceable run must leave the key absent, not present
 * holding `undefined`.
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

/**
 * Everything after the loop: reconcile the metered cost against the loop's
 * own reported cost, then record the concluding audit entry.
 *
 * @remarks
 * Mirrors `steps/run-health-check.ts`'s own `concludeHealthCheck` for the
 * cost-reconciliation and conclusion-record halves; this operation has no
 * report artifact or anomaly demotion of its own. `reconcileMeteredCost` runs
 * unconditionally here (unlike `run-health-check.ts`, whose loop can absorb a
 * ceiling breach into an `outcome: undefined`): {@link runLoop} above never
 * absorbs a failure, so reaching this function at all means the loop
 * produced a genuine `outcome`, refusal or not — see `steps/gate-tool.ts`'s
 * documented "a refusal never throws" contract for why a per-call refusal
 * still lands here.
 */
async function concludeEtlPreset(
  setup: GatedOperationSetup,
  outcome: AWS.M3LBedrockToolLoopOutcome,
): Promise<void> {
  const iterations = setup.metered.observedIterations();
  const tokens = iterations.reduce(
    (total, iteration) => total + iteration.usage.totalTokens,
    0,
  );
  // THIS script's own figure, not the library's — see `runLoop`'s ordering-
  // constraint-3 remarks and `steps/metering-invoker.ts`'s own header on why
  // `sumObservedCost` is a deliberate local re-implementation of
  // `AWS.computeCost` that `reconcileMeteredCost` is what makes safe.
  const cost = setup.ledger.snapshot(setup.now).costThisRun;
  reconcileMeteredCost({ metered: cost, reported: outcome.cost });

  await recordConclusion(
    setup.recorder,
    setup.decision,
    setup.now,
    tokens,
    cost,
  );
}

/**
 * Runs the `run-preset` workload end to end: prepare, resolve the target
 * script's `aws.profile` declaration (fail closed), build a registry
 * offering exactly one tool, drive the Bedrock tool loop, and conclude.
 *
 * @param deps - See {@link RunEtlPresetDeps}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 *   `ERR_AGENT_OPERATOR_CONFIG` (including when `scripts` does not declare
 *   exactly one entry — see {@link resolveTargetScript}),
 *   `ERR_AGENT_OPERATOR_BUDGET_STATE`, `ERR_AGENT_OPERATOR_DECISION_LOG`, or
 *   `ERR_AGENT_OPERATOR_ESCALATED`; and `Core.M3LOperationAbortedError`
 *   (propagated `instanceof`-intact, so ADR-0049 classifies Ctrl-C as exit 5)
 *   or an `AWS.M3LBedrockRuntime*Error` when the model itself is unreachable.
 *
 * @example
 * ```ts
 * import type { RunEtlPresetDeps } from "./run-etl-preset.js";
 * import { runEtlPreset } from "./run-etl-preset.js";
 *
 * declare const deps: RunEtlPresetDeps;
 * await runEtlPreset(deps);
 * ```
 */
export async function runEtlPreset(deps: RunEtlPresetDeps): Promise<void> {
  const setup = await prepareGatedOperation({
    ...deps,
    action: runPresetAction(),
  });
  const { runtime, ledger, counter } = setup;
  const targetScript = resolveTargetScript(runtime);

  // Fail closed — see the module remarks and `scriptDeclaresAwsProfile`'s own
  // doc. This must run, and must be allowed to reject, BEFORE the registry is
  // ever built.
  const declaresAwsProfile = await scriptDeclaresAwsProfile(
    setup,
    targetScript,
  );

  const registry = buildRegistry(deps, setup, targetScript, declaresAwsProfile);

  let outcome: AWS.M3LBedrockToolLoopOutcome;
  try {
    outcome = await runLoop(
      setup.metered.invoker,
      registry,
      runtime,
      deps,
      targetScript,
    );
  } finally {
    // Whether the loop completed or threw.
    await recordConsumption(counter, ledger, deps, setup.now);
  }

  await concludeEtlPreset(setup, outcome);
}
