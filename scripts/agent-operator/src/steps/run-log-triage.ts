/**
 * `agent-operator/steps/run-log-triage` — the `triage-logs` workload: the
 * third policy-gated `agent-operator` operation, running the single-phase
 * `triage_logs` tool (`steps/build-triage-tools.ts`) through the real
 * Bedrock tool loop against exactly one fixed target script,
 * `cloudwatch-logs-analysis`.
 *
 * @remarks
 * Near-twin of `steps/run-etl-preset.ts`: shares the operation-agnostic
 * AUTHORIZATION setup — accessor, policy load, runtime resolution, ledger +
 * recorder, daily-counter seed, CLI surface, metered invoker construction,
 * and the decision-log preflight — via
 * `steps/prepare-gated-operation.ts`'s `prepareGatedOperation`. What differs
 * here: the declared action, a fixed single-script target (never a
 * per-config parameter), a preset-verification seam in place of an
 * `aws.profile` inspection, and a registry offering exactly one single-phase
 * tool.
 *
 * ## The preflight action is read-only, not mutating
 *
 * {@link triageLogsAction} declares `kind: "read-only"`. As with
 * `run-preset`'s own `runPresetAction`, this describes *running the agent*,
 * not the child work `triage_logs` itself performs — that per-tool action is
 * declared separately by `steps/build-triage-tools.ts`'s `describeAction` and
 * gated per call by `gateToolSpec`. Here the child work is genuinely
 * read-only too: `triage_logs` is single-phase, never mutates anything, and
 * `lib/triage-presets.ts`'s `verifyTriagePresets` refuses any allowlisted
 * preset naming an operation outside its closed read-only set.
 *
 * ## No `surface.inspect` call, no `scriptDeclaresAwsProfile`
 *
 * `cloudwatch-logs-analysis` legitimately declares its own `aws.profile`
 * configuration parameter — that is exactly why `run-preset`'s
 * `buildEtlTools` refusal excludes it as a target, and exactly why this
 * operation needs its own builder rather than reusing that one. This module
 * therefore never calls `surface.inspect` and never computes a
 * `scriptDeclaresAwsProfile` boolean: {@link verifyTriagePresets} is what
 * replaces that check, closing the same hole from the preset side instead of
 * the target-script side. This is a decision, not an omission — see
 * `lib/triage-presets.ts`'s own module remarks for the full rationale.
 *
 * ## The target script is fixed, never a config parameter
 *
 * `triage-logs` declares no `scriptName` parameter. The one target script
 * this operation supports is read off the same `scripts` list `run-preset`
 * and `health-check` use, but — like `run-preset` — array ordering must
 * never decide the target, so {@link resolveTargetScript} requires `scripts`
 * to hold EXACTLY ONE entry, and that entry must equal
 * {@link TRIAGE_TARGET_SCRIPT}. See its own doc for both constraints.
 *
 * ## `verifyTriagePresets` must run before anything is built, and must be
 * allowed to reject
 *
 * Unlike `scriptDeclaresAwsProfile`'s own fail-closed `try`/`catch`-free
 * await, {@link verifyTriagePresets} here is called the same way: no
 * surrounding `try`/`catch`, so a rejection propagates unchanged, before the
 * registry is ever built. It needs a workspace root to resolve preset paths
 * against — when {@link GatedOperationSetup.workspaceRoot} is `undefined`
 * (standalone mode; see `prepare-gated-operation.ts`'s `deriveWorkspaceRoot`),
 * there is no anchor to resolve a preset path against, so the operation
 * refuses outright rather than handing `verifyTriagePresets` an unusable
 * input.
 *
 * @packageDocumentation
 */

import { AWS, Core } from "@m3l-automation/m3l-common";

import { assertAllowedScriptName } from "../lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { verifyTriagePresets } from "../lib/triage-presets.js";
import type { VerifiedTriagePresets } from "../lib/triage-presets.js";
import {
  buildTriageTools,
  TRIAGE_TARGET_SCRIPT,
} from "./build-triage-tools.js";
import { buildAgentToolRegistry } from "./build-tool-registry.js";
// The consumption/conclusion tail now has one owner: `./conclusion-tail.js`.
import {
  concludeGatedOperation,
  recordConsumption,
} from "./conclusion-tail.js";
import { prepareGatedOperation } from "./prepare-gated-operation.js";
import type { GatedOperationSetup } from "./prepare-gated-operation.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";
import {
  triageLogsSystemPrompt,
  triageLogsUserPrompt,
} from "./triage-prompt.js";

/** Everything {@link runLogTriage} needs, injected rather than reached for. */
export interface RunLogTriageDeps {
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
function triageLogsAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "triage-logs",
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
 * Reads the one target script this operation names off `runtime.scripts`,
 * and confirms it is the one script this operation supports.
 *
 * @remarks
 * `scripts` is a general-purpose fleet list shared with `run-preset` and
 * `steps/run-health-check.ts`. Array ordering must never decide the target,
 * so `scripts` must hold EXACTLY ONE entry, or the run refuses outright.
 * That sole entry must then equal {@link TRIAGE_TARGET_SCRIPT} — the one
 * script `steps/build-triage-tools.ts`'s read-only claim is sound for.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `scripts` does not hold exactly one entry, or when its sole entry
 *   is not {@link TRIAGE_TARGET_SCRIPT}.
 */
function resolveTargetScript(runtime: AgentOperatorRuntimeSettings): string {
  if (runtime.scripts.length !== 1) {
    throw new M3LAgentOperatorCliError(
      "'triage-logs' requires 'scripts' to declare EXACTLY ONE entry: the target script this operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  const [target] = runtime.scripts;
  if (target === undefined) {
    // Unreachable given the length check above; narrows the type for
    // `noUncheckedIndexedAccess` without a non-null assertion.
    throw new M3LAgentOperatorCliError(
      "'triage-logs' requires 'scripts' to declare EXACTLY ONE entry: the target script this operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (target !== TRIAGE_TARGET_SCRIPT) {
    // Fixed, non-interpolated message — the offending script is never
    // echoed: the operator can see which value they configured from their
    // own config, not from this text.
    throw new M3LAgentOperatorCliError(
      "'triage-logs' requires 'scripts' to name the one target script this operation supports",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return target;
}

/**
 * Resolves the workspace root {@link verifyTriagePresets} needs to anchor
 * preset paths against, refusing outright when none is available.
 *
 * @remarks
 * `setup.workspaceRoot` degrades to `undefined` only in standalone mode
 * (`prepare-gated-operation.ts`'s `deriveWorkspaceRoot`, which already
 * warns when that happens). Without an anchor there is no way to resolve a
 * preset path, so this operation refuses rather than handing
 * `verifyTriagePresets` an unusable input.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `setup.workspaceRoot` is `undefined`.
 */
function requireWorkspaceRoot(setup: GatedOperationSetup): string {
  if (setup.workspaceRoot === undefined) {
    throw new M3LAgentOperatorCliError(
      "'triage-logs' requires a resolvable workspace root to anchor preset paths against; it is not supported in standalone mode",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return setup.workspaceRoot;
}

/**
 * Builds the registry offering exactly one tool: the single-phase
 * `triage_logs` spec from `steps/build-triage-tools.ts`.
 */
function buildRegistry(
  deps: RunLogTriageDeps,
  setup: GatedOperationSetup,
  scriptName: string,
  presetAllowlist: VerifiedTriagePresets,
): AWS.M3LBedrockToolRegistry {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  const tools = buildTriageTools({
    surface: setup.surface,
    scriptName: assertAllowedScriptName(scriptName),
    operatorProfile: accessor.requiredString(
      Core.AWS_PROFILE_PARAM_NAME,
      "triage-logs",
    ),
    presetAllowlist,
  });
  return buildAgentToolRegistry(tools, {
    policy: setup.policy,
    ledger: setup.ledger,
    recorder: setup.recorder,
    // The gate samples its own instant per call — a gated pass must not
    // straddle a clock tick, and it may run minutes after `setup.now`.
    now: () => Date.now(),
    logger: deps.logger,
    reportRecovery: deps.reportRecovery,
  });
}

/**
 * Drives `runBedrockToolLoop` over a conversation offering only
 * `triage_logs`.
 *
 * @remarks
 * Mirrors `steps/run-etl-preset.ts`'s own `runLoop`: nothing here is
 * absorbed, so every failure — a declared ceiling, model unavailability, or
 * an abort — propagates unchanged to {@link runLogTriage}'s caller.
 */
async function runLoop(
  invoker: AWS.M3LBedrockToolLoopInvoker,
  tools: AWS.M3LBedrockToolRegistry,
  runtime: AgentOperatorRuntimeSettings,
  deps: RunLogTriageDeps,
  scriptName: string,
  presetAllowlist: VerifiedTriagePresets,
): Promise<AWS.M3LBedrockToolLoopOutcome> {
  const conversation = AWS.createBedrockConversation({
    system: triageLogsSystemPrompt(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: triageLogsUserPrompt({
              scriptName,
              presetNames: [...presetAllowlist.keys()],
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
 * Runs the `triage-logs` workload end to end: prepare, resolve the one fixed
 * target script, require a resolvable workspace root, verify the operator's
 * declared triage presets, build a registry offering exactly one tool, drive
 * the Bedrock tool loop, and conclude.
 *
 * @param deps - See {@link RunLogTriageDeps}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 *   `ERR_AGENT_OPERATOR_CONFIG` (including when `scripts` does not name
 *   exactly one entry equal to `cloudwatch-logs-analysis` — see
 *   {@link resolveTargetScript} — or when no workspace root can be resolved —
 *   see {@link requireWorkspaceRoot}), `ERR_AGENT_OPERATOR_PRESET` (from
 *   `verifyTriagePresets`), `ERR_AGENT_OPERATOR_BUDGET_STATE`,
 *   `ERR_AGENT_OPERATOR_DECISION_LOG`, or `ERR_AGENT_OPERATOR_ESCALATED`; and
 *   `Core.M3LOperationAbortedError` (propagated `instanceof`-intact, so
 *   ADR-0049 classifies Ctrl-C as exit 5) or an `AWS.M3LBedrockRuntime*Error`
 *   when the model itself is unreachable.
 *
 * @example
 * ```ts
 * import type { RunLogTriageDeps } from "./run-log-triage.js";
 * import { runLogTriage } from "./run-log-triage.js";
 *
 * declare const deps: RunLogTriageDeps;
 * await runLogTriage(deps);
 * ```
 */
export async function runLogTriage(deps: RunLogTriageDeps): Promise<void> {
  const setup = await prepareGatedOperation({
    ...deps,
    action: triageLogsAction(),
  });
  const { runtime, ledger, counter } = setup;
  const targetScript = resolveTargetScript(runtime);
  const workspaceRoot = requireWorkspaceRoot(setup);

  // BEFORE the registry is built, and allowed to reject — see the module
  // remarks. Wired to the resolved runtime's own presetAllowlist and the
  // derived workspaceRoot, never a hardcoded pair.
  const presetAllowlist = await verifyTriagePresets({
    presetAllowlist: runtime.presetAllowlist,
    workspaceRoot,
    readProvider: (absolutePath) =>
      new Core.M3LYAMLConfigProvider(absolutePath),
  });

  const registry = buildRegistry(deps, setup, targetScript, presetAllowlist);

  let outcome: AWS.M3LBedrockToolLoopOutcome;
  try {
    outcome = await runLoop(
      setup.metered.invoker,
      registry,
      runtime,
      deps,
      targetScript,
      presetAllowlist,
    );
  } finally {
    // Whether the loop completed or threw.
    await recordConsumption(counter, ledger, deps, setup.now);
  }

  await concludeGatedOperation(setup, outcome);
}
