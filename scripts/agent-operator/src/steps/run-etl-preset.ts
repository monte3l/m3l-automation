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
// The consumption/conclusion tail now has one owner: `./conclusion-tail.js`.
import {
  concludeGatedOperation,
  recordConsumption,
} from "./conclusion-tail.js";
import { runPresetSystemPrompt, runPresetUserPrompt } from "./etl-prompt.js";
import { prepareGatedOperation } from "./prepare-gated-operation.js";
import type { GatedOperationSetup } from "./prepare-gated-operation.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";

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

  await concludeGatedOperation(setup, outcome);
}
