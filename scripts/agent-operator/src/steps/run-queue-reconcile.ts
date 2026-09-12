/**
 * `agent-operator/steps/run-queue-reconcile` — the `queue-reconcile`
 * workload: the fourth policy-gated `agent-operator` operation, verifying an
 * operator-declared `flowAllowlist` (`lib/flow-definitions.ts`'s
 * `verifyFlowNames`) and then offering the model exactly one tool,
 * `reconcile_queue` (`steps/build-flow-tools.ts`), through the real Bedrock
 * tool loop.
 *
 * @remarks
 * Near-twin of `steps/run-log-triage.ts`: shares the operation-agnostic
 * AUTHORIZATION setup via `steps/prepare-gated-operation.ts`'s
 * `prepareGatedOperation`. What differs: the declared action, a fixed
 * flow-family target (`"flow"`, never a specific fleet script), a
 * flow-verification seam in place of preset verification, a registry
 * offering exactly one MUTATING tool, and — the reason this module exists —
 * explicit handling of one specific rejection shape from that tool.
 *
 * ## The preflight action is read-only, not mutating
 *
 * {@link queueReconcileAction} declares `kind: "read-only"`, mirroring every
 * sibling runner's own outer action: it describes *running the agent*, not
 * the child `reconcile_queue` tool's own `kind: "mutating"` action
 * (`build-flow-tools.ts`'s `describeAction`), which is graded per call by
 * `gateToolSpec`.
 *
 * ## The target is a command FAMILY, never a specific script
 *
 * `verifyFlowNames` needs no fixed target script the way `triage-logs` does:
 * a flow file names its own steps. What IS fixed is the `m3l` subcommand
 * family this operation drives — `"flow"`, `build-flow-tools.ts`'s own
 * {@link RECONCILE_TARGET_COMMAND} — so {@link resolveTargetScript} still
 * requires `runtime.scripts` to hold EXACTLY ONE entry (array ordering must
 * never decide a target) and requires that entry to equal
 * {@link RECONCILE_TARGET_COMMAND}.
 *
 * ## `verifyFlowNames` must run before the registry is built, and may reject
 *
 * No surrounding `try`/`catch`: a rejection propagates unchanged, before
 * anything is built — a verifier that ran after registry construction would
 * leave a tool existing for an unverified flow. It needs a workspace root to
 * resolve flow-definition paths against, so {@link requireWorkspaceRoot}
 * refuses outright in standalone mode rather than handing it an unusable
 * input.
 *
 * ## The INDETERMINATE rule lives in `build-flow-tools.ts`'s `execute`
 *
 * When `surface.flowRun` rejects with a `"timed-out"` disposition, the run's
 * effects are UNKNOWN and possibly still in flight — see
 * `steps/build-flow-tools.ts`'s module remarks for the full mechanism. That
 * classification and its decision-log recording do NOT live here: this
 * module's own tool loop converts a handler rejection into an error
 * toolResult and keeps running (`AWS.runBedrockToolLoop`'s tool-dispatch
 * layer), and `steps/gate-tool.ts`'s `runApprovedExecution` re-wraps the
 * rejection before this function's `catch` would ever see it — so a
 * classifier placed at this runner's `catch` is unreachable dead code.
 * `build-flow-tools.ts`'s `execute` is the one point in the call chain that
 * still holds the original rejection, so that is where the recording and the
 * structural no-retry guard both live now.
 *
 * The teardown half of the timeout is not this module's either: it lives in
 * `lib/cli-process.ts`, which spawns `flowRun`'s child `detached` and
 * signals the whole process group on expiry (`CliTeardownScope`), so the
 * flow step spawned as `m3l`'s grandchild is killed with it. That scope is
 * opted into per method by `lib/cli-surface.ts`'s `CliInvocationSpec`, so
 * the other six `AgentCliSurface` methods keep child-only signalling.
 * Teardown bounds the flow; it does not make the run's effects known, which
 * is why the INDETERMINATE recording below stays exactly as it is.
 *
 * @packageDocumentation
 */

import { AWS, Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { verifyFlowNames } from "../lib/flow-definitions.js";
import type { VerifiedFlowTarget } from "../lib/flow-definitions.js";
import {
  buildFlowTools,
  RECONCILE_TARGET_COMMAND,
} from "./build-flow-tools.js";
import { buildAgentToolRegistry } from "./build-tool-registry.js";
// The consumption/conclusion tail has one owner: `./conclusion-tail.js`.
import {
  concludeGatedOperation,
  recordConsumption,
} from "./conclusion-tail.js";
import {
  queueReconcileSystemPrompt,
  queueReconcileUserPrompt,
} from "./flow-prompt.js";
import { prepareGatedOperation } from "./prepare-gated-operation.js";
import type { GatedOperationSetup } from "./prepare-gated-operation.js";
import type { AgentOperatorRuntimeSettings } from "./resolve-runtime.js";

/** Everything {@link runQueueReconcile} needs, injected rather than reached for. */
export interface RunQueueReconcileDeps {
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
function queueReconcileAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "reconcile-queue",
    kind: "read-only",
    parameterNames: [
      "command",
      "policyFile",
      "decisionLogDir",
      "agentName",
      "modelId",
      Core.AWS_PROFILE_PARAM_NAME,
      "scripts",
      "flowAllowlist",
    ],
  };
}

/**
 * Confirms `runtime.scripts` names exactly the one `m3l` subcommand family
 * this operation drives — see the module remarks' "target is a command
 * family" section.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `scripts` does not hold exactly one entry, or when its sole entry
 *   is not {@link RECONCILE_TARGET_COMMAND}.
 */
function resolveTargetScript(runtime: AgentOperatorRuntimeSettings): void {
  if (runtime.scripts.length !== 1) {
    throw new M3LAgentOperatorCliError(
      "'queue-reconcile' requires 'scripts' to declare EXACTLY ONE entry: the flow-family target this operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  const [target] = runtime.scripts;
  if (target === undefined) {
    // Unreachable given the length check above; narrows the type for
    // `noUncheckedIndexedAccess` without a non-null assertion.
    throw new M3LAgentOperatorCliError(
      "'queue-reconcile' requires 'scripts' to declare EXACTLY ONE entry: the flow-family target this operation names",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (target !== RECONCILE_TARGET_COMMAND) {
    // Fixed, non-interpolated message — the offending value is never echoed:
    // the operator can see what they configured from their own config.
    throw new M3LAgentOperatorCliError(
      "'queue-reconcile' requires 'scripts' to name the flow-family target this operation supports",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
}

/**
 * Resolves the workspace root {@link verifyFlowNames} needs to anchor flow
 * definition paths against, refusing outright when none is available.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `setup.workspaceRoot` is `undefined`.
 */
function requireWorkspaceRoot(setup: GatedOperationSetup): string {
  if (setup.workspaceRoot === undefined) {
    throw new M3LAgentOperatorCliError(
      "'queue-reconcile' requires a resolvable workspace root to anchor flow definition paths against; it is not supported in standalone mode",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return setup.workspaceRoot;
}

/**
 * Builds the `declaredParameters` reader `verifyFlowNames` needs — backed by
 * `surface.inspect` in production, per that dependency's own contract.
 */
function declaredParameters(
  setup: GatedOperationSetup,
): (scriptName: string) => Promise<readonly string[]> {
  return async (scriptName) => {
    const descriptors = await setup.surface.inspect(scriptName);
    return descriptors.map((descriptor) => descriptor.name);
  };
}

/**
 * Builds the registry offering exactly one tool: the single-phase, MUTATING
 * `reconcile_queue` spec from `steps/build-flow-tools.ts`, wired from
 * `verifyFlowNames`' own returned brand and graded profile — never
 * re-derived from the raw allowlist a second time.
 */
function buildRegistry(
  deps: RunQueueReconcileDeps,
  setup: GatedOperationSetup,
  target: VerifiedFlowTarget,
): AWS.M3LBedrockToolRegistry {
  const tools = buildFlowTools({
    surface: setup.surface,
    flowAllowlist: target.flows,
    gradedProfile: target.gradedProfile,
    // The INDETERMINATE rule now records from inside `execute` itself — see
    // `build-flow-tools.ts`'s module remarks. `setup.decision`/`setup.now`
    // are threaded straight through, never re-derived: they are the SAME
    // preflight decision and sampled instant this run's other audit writes
    // use.
    decisionRecorder: setup.recorder,
    decision: setup.decision,
    now: setup.now,
    // A failed INDETERMINATE decision-log write must still be observable —
    // same `deps.logger`/`deps.reportRecovery` ports `recordConsumption`
    // below uses for its own absorbed-failure reporting.
    logger: deps.logger,
    reportRecovery: deps.reportRecovery,
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
 * `reconcile_queue`.
 *
 * @remarks
 * Nothing here is absorbed: every failure — a declared ceiling, model
 * unavailability, an abort, or the tool's own rejection — propagates
 * unchanged to {@link runQueueReconcile}'s caller (after that caller's own
 * indeterminate-timeout classification runs).
 */
async function runLoop(
  invoker: AWS.M3LBedrockToolLoopInvoker,
  tools: AWS.M3LBedrockToolRegistry,
  runtime: AgentOperatorRuntimeSettings,
  deps: RunQueueReconcileDeps,
  target: VerifiedFlowTarget,
): Promise<AWS.M3LBedrockToolLoopOutcome> {
  const conversation = AWS.createBedrockConversation({
    system: queueReconcileSystemPrompt(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: queueReconcileUserPrompt([...target.flows]),
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
    // THE SAME map object the metered invoker was built with.
    rates: runtime.modelRates,
    inferenceConfig: { maxTokens: runtime.maxOutputTokens },
  });
}

/**
 * Runs the `queue-reconcile` workload end to end: prepare, resolve the
 * flow-family target, require a resolvable workspace root, verify the
 * operator's declared flow allowlist, build a registry offering exactly one
 * mutating tool, and drive the Bedrock tool loop to conclusion.
 *
 * @remarks
 * A `flowRun` timeout is no longer classified here — see the module
 * remarks' "INDETERMINATE rule lives in `build-flow-tools.ts`'s `execute`"
 * section for why this runner's own `catch` can never observe that
 * rejection shape.
 *
 * @param deps - See {@link RunQueueReconcileDeps}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 *   `ERR_AGENT_OPERATOR_CONFIG` (see {@link resolveTargetScript} and
 *   {@link requireWorkspaceRoot}), `ERR_AGENT_OPERATOR_FLOW` (from
 *   `verifyFlowNames`), `ERR_AGENT_OPERATOR_BUDGET_STATE`,
 *   `ERR_AGENT_OPERATOR_DECISION_LOG`, or `ERR_AGENT_OPERATOR_ESCALATED`
 *   (the policy's own decline); and `Core.M3LOperationAbortedError`
 *   (propagated `instanceof`-intact, so ADR-0049 classifies Ctrl-C as exit
 *   5) or an `AWS.M3LBedrockRuntime*Error` when the model itself is
 *   unreachable.
 *
 * @example
 * ```ts
 * import type { RunQueueReconcileDeps } from "./run-queue-reconcile.js";
 * import { runQueueReconcile } from "./run-queue-reconcile.js";
 *
 * declare const deps: RunQueueReconcileDeps;
 * await runQueueReconcile(deps);
 * ```
 */
export async function runQueueReconcile(
  deps: RunQueueReconcileDeps,
): Promise<void> {
  const setup = await prepareGatedOperation({
    ...deps,
    action: queueReconcileAction(),
  });
  const { runtime, ledger, counter } = setup;
  resolveTargetScript(runtime);
  const workspaceRoot = requireWorkspaceRoot(setup);

  // BEFORE the registry is built, and allowed to reject — see the module
  // remarks. Wired to the resolved runtime's own flowAllowlist and the
  // derived workspaceRoot, never a hardcoded pair.
  const target = await verifyFlowNames({
    flowAllowlist: runtime.flowAllowlist,
    workspaceRoot,
    readProvider: (absolutePath) =>
      new Core.M3LYAMLConfigProvider(absolutePath),
    declaredParameters: declaredParameters(setup),
    policy: setup.policy,
  });

  const registry = buildRegistry(deps, setup, target);

  let outcome: AWS.M3LBedrockToolLoopOutcome;
  try {
    outcome = await runLoop(
      setup.metered.invoker,
      registry,
      runtime,
      deps,
      target,
    );
  } finally {
    // Whether the loop completed or threw — this run's invocations are
    // counted regardless.
    await recordConsumption(counter, ledger, deps, setup.now);
  }

  await concludeGatedOperation(setup, outcome);
}
