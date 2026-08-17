import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  ABANDON_DEFAULT,
  CODEPIPELINE_OPS_OPERATIONS,
  STAGE_TRANSITION_TYPES,
  WAIT_INTERVAL_SECONDS_DEFAULT,
  WAIT_MAX_ATTEMPTS_DEFAULT,
  YES_DEFAULT,
} from "../config.js";
import { FAILED_STATUSES } from "./watch-execution.js";

/** The closed union of `codepipeline-ops`'s declared `operation` values. */
type CodepipelineOperation = (typeof CODEPIPELINE_OPS_OPERATIONS)[number];

/**
 * The resolved, per-run config values — carries `operation` so `finalize`
 * can identify `watch-execution` results without a structurally distinct
 * type (`describe-execution` and `watch-execution` both return
 * `AWS.M3LCodePipelineExecution`, so a structural guard would mismatch).
 */
interface RunSettings {
  readonly operation: CodepipelineOperation;
  readonly pipeline: string | undefined;
  readonly executionId: string | undefined;
  readonly stage: string | undefined;
  readonly transitionType: string | undefined;
  readonly reason: string | undefined;
  readonly input: string | undefined;
  readonly version: number | undefined;
  readonly maxResults: number | undefined;
  readonly clientRequestToken: string | undefined;
  readonly abandon: boolean;
  readonly yes: boolean;
  readonly output: string | undefined;
  readonly waitMaxAttempts: number;
  readonly waitIntervalSeconds: number;
}

/** The full dependency bag `runCodepipelineOps` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  readonly operations: AWS.M3LCodePipelineOperations;
}

/**
 * The union of result shapes any dispatched operation can resolve.
 * `undefined` for `delete-pipeline` and both stage-transition operations.
 */
type DispatchResult =
  | AWS.M3LCodePipelineListPipelinesResult
  | AWS.M3LCodePipelineDefinition
  | AWS.M3LCodePipelineState
  | AWS.M3LCodePipelineListExecutionsResult
  | AWS.M3LCodePipelineExecution
  | AWS.M3LCodePipelineDeclaration
  | AWS.M3LCodePipelineStartExecutionResult
  | AWS.M3LCodePipelineStopExecutionResult
  | undefined;

/** The per-write-operation description/declaration resolved before gating. */
interface WriteDispatchPlan {
  readonly description: string;
  readonly declaration: Record<string, unknown> | undefined;
}

/** Builds `delete-pipeline`'s gate description from the `pipeline` config value. */
function buildDeleteGateDescription(pipelineName: string): string {
  return `delete-pipeline pipeline '${pipelineName}'`;
}

/**
 * A generic phrase used when the parsed `create-pipeline`/`update-pipeline`
 * input record carries no recognizable pipeline name.
 */
const UNKNOWN_TARGET_PHRASE = "(see input file)";

/**
 * Builds `create-pipeline`/`update-pipeline`'s gate description from a
 * best-effort read of the already-parsed input record's `name` field —
 * informational only, not a validation step (full required-field
 * enforcement happens inside `write-pipeline` after confirmation). The
 * description also carries the replace-not-patch warning for
 * `update-pipeline`, since `UpdatePipeline` replaces the whole declaration
 * and silently drops every field the wrapper does not model.
 */
function buildRecordGateDescription(
  operation: "create-pipeline" | "update-pipeline",
  record: Record<string, unknown>,
): string {
  const nameValue = record["name"];
  const name = typeof nameValue === "string" ? nameValue : undefined;
  const target = name ?? UNKNOWN_TARGET_PHRASE;

  if (operation === "update-pipeline") {
    return `update-pipeline pipeline '${target}' (REPLACES the whole live declaration — any field not in the input file, e.g. triggers/artifactStores/stage conditions, is silently deleted)`;
  }
  return `create-pipeline pipeline '${target}'`;
}

/**
 * Narrows an already-guarded optional settings field to its defined value,
 * throwing a defensive `ERR_CODEPIPELINE_OPS_CONFIG` otherwise. The
 * pipeline's `requiredFields` guard (phase 4) has already enforced presence
 * for every field callers read this way before those callers are ever
 * invoked — this is a type-narrowing safety net, not an expected runtime
 * path.
 */
function requireDefined<T>(
  value: T | undefined,
  name: string,
  operation: string,
): T {
  if (value === undefined) {
    throw new Core.M3LError(
      `'${name}' is required for operation '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return value;
}

/**
 * Guard-checks and narrows `transitionType` to the wrapper's closed
 * `"Inbound" | "Outbound"` union. Presence is already enforced by the
 * engine's Guards phase (via {@link REQUIRED_FIELDS}); the `requireDefined`
 * call here is a defensive type-narrowing safety net. The value-set check
 * defends against a bypass of the config-level `oneOf` validator.
 */
function requireTransitionType(
  value: string | undefined,
  operation: CodepipelineOperation,
): AWS.M3LCodePipelineStageTransitionType {
  const raw = requireDefined(value, "transitionType", operation);
  if (!(STAGE_TRANSITION_TYPES as readonly string[]).includes(raw)) {
    throw new Core.M3LError(
      `'transitionType' must be one of: ${STAGE_TRANSITION_TYPES.join(", ")}`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return raw as AWS.M3LCodePipelineStageTransitionType;
}

/**
 * Narrows `prepare`'s `WriteDispatchPlan | undefined` context to a defined
 * plan. `TContext` is uniform across every handler table entry, but `prepare`
 * only ever produces a defined plan for the three write operations — an
 * `undefined` context reaching a write handler or the destructive `describe`
 * callback is unreachable except via caller misuse of the engine, guarded
 * here defensively.
 */
function requireWritePlan(
  context: WriteDispatchPlan | undefined,
  operation: CodepipelineOperation,
): WriteDispatchPlan {
  if (context === undefined) {
    throw new Core.M3LError(
      `internal: no write-dispatch plan resolved for '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return context;
}

/**
 * Which of the settings fields each operation requires, checked by the
 * engine's Guards phase before `prepare`, the destructive gate, or any
 * handler runs. Keyed as a `Record<CodepipelineOperation, …>` so a new
 * operation added to {@link CODEPIPELINE_OPS_OPERATIONS} without a
 * corresponding entry here is a compile error.
 */
const REQUIRED_FIELDS: Record<
  CodepipelineOperation,
  readonly Core.M3LGuardableKey<RunSettings>[]
> = {
  "list-pipelines": [],
  "describe-pipeline": ["pipeline"],
  "get-pipeline-state": ["pipeline"],
  "list-executions": ["pipeline"],
  "describe-execution": ["pipeline", "executionId"],
  "create-pipeline": ["input"],
  "update-pipeline": ["input"],
  "delete-pipeline": ["pipeline"],
  "start-execution": ["pipeline"],
  "stop-execution": ["pipeline", "executionId"],
  "enable-stage-transition": ["pipeline", "stage", "transitionType"],
  "disable-stage-transition": ["pipeline", "stage", "transitionType", "reason"],
  "watch-execution": ["pipeline", "executionId"],
};

/**
 * Resolves the raw, per-operation-optional config values the pipeline reads
 * once, up front. Receives `operation` directly from the engine (phase 2)
 * and stores it in `RunSettings` for `finalize`'s operation-identity check.
 * Must not re-read `"operation"` from the accessor or apply its own
 * required-field guards — those are owned by the engine's own "Operation"
 * and "Guards" phases.
 */
function resolveSettings(
  accessor: Core.M3LConfigAccessor,
  operation: CodepipelineOperation,
): RunSettings {
  return {
    operation,
    pipeline: accessor.optionalString("pipeline"),
    executionId: accessor.optionalString("executionId"),
    stage: accessor.optionalString("stage"),
    transitionType: accessor.optionalString("transitionType"),
    reason: accessor.optionalString("reason"),
    input: accessor.optionalString("input"),
    version: accessor.optionalNumber("version"),
    maxResults: accessor.optionalNumber("maxResults"),
    clientRequestToken: accessor.optionalString("clientRequestToken"),
    abandon: accessor.booleanWithDefault("abandon", ABANDON_DEFAULT),
    yes: accessor.booleanWithDefault("yes", YES_DEFAULT),
    output: accessor.optionalString("output"),
    waitMaxAttempts: accessor.numberWithDefault(
      "waitMaxAttempts",
      WAIT_MAX_ATTEMPTS_DEFAULT,
    ),
    waitIntervalSeconds: accessor.numberWithDefault(
      "waitIntervalSeconds",
      WAIT_INTERVAL_SECONDS_DEFAULT,
    ),
  };
}

/**
 * The pipeline's `prepare` phase: runs once per run, before the destructive
 * gate, for every operation. Resolves `delete-pipeline`'s gate description
 * directly from config, or reads+parses `create-pipeline`/`update-pipeline`'s
 * `input` file (the one place either file is ever read). Presence of
 * `pipeline`/`input` is already enforced by the engine's "Guards" phase
 * before `prepare` ever runs — the {@link requireDefined} calls below are a
 * defensive type-narrowing safety net. Every non-write operation resolves
 * `undefined`.
 */
async function prepare(
  operation: CodepipelineOperation,
  settings: RunSettings,
  deps: Deps,
): Promise<WriteDispatchPlan | undefined> {
  if (operation === "delete-pipeline") {
    const pipelineName = requireDefined(
      settings.pipeline,
      "pipeline",
      operation,
    );
    return {
      description: buildDeleteGateDescription(pipelineName),
      declaration: undefined,
    };
  }
  if (operation === "create-pipeline" || operation === "update-pipeline") {
    const inputName = requireDefined(settings.input, "input", operation);
    const reader = new Core.M3LInputFileReader({
      paths: deps.paths,
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    });
    const parsed = await reader.readJSONRecord(inputName);
    return {
      description: buildRecordGateDescription(operation, parsed),
      declaration: parsed,
    };
  }
  return undefined;
}

/** `list-pipelines`/`describe-pipeline`: dispatches to `read-pipelines`. */
async function dispatchReadPipelines(
  operation: "list-pipelines" | "describe-pipeline",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const { readPipelines } = await import("./read-pipelines.js");
  return readPipelines({
    operations: deps.operations,
    operation,
    pipeline: settings.pipeline,
    version: settings.version,
    nextToken: undefined,
    maxResults: settings.maxResults,
  });
}

/** `get-pipeline-state`: dispatches to `read-state`. */
async function dispatchReadState(
  _operation: "get-pipeline-state",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const pipelineName = requireDefined(
    settings.pipeline,
    "pipeline",
    "get-pipeline-state",
  );
  const { readState } = await import("./read-state.js");
  return readState({ operations: deps.operations, pipeline: pipelineName });
}

/** `list-executions`/`describe-execution`: dispatches to `read-executions`. */
async function dispatchReadExecutions(
  operation: "list-executions" | "describe-execution",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const pipelineName = requireDefined(settings.pipeline, "pipeline", operation);
  const { readExecutions } = await import("./read-executions.js");
  return readExecutions({
    operations: deps.operations,
    operation,
    pipeline: pipelineName,
    executionId: settings.executionId,
    nextToken: undefined,
    maxResults: settings.maxResults,
  });
}

/**
 * `create-pipeline`/`update-pipeline`/`delete-pipeline`: dispatches to
 * `write-pipeline` using the plan `prepare` resolved before the gate.
 */
async function dispatchWrite(
  operation: "create-pipeline" | "update-pipeline" | "delete-pipeline",
  settings: RunSettings,
  ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const plan = requireWritePlan(ctx, operation);
  const { writePipeline } = await import("./write-pipeline.js");
  return writePipeline({
    operations: deps.operations,
    reader: new Core.M3LInputFileReader({
      paths: deps.paths,
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    }),
    operation,
    declaration: plan.declaration,
    pipeline: settings.pipeline,
  });
}

/** `start-execution`/`stop-execution`: dispatches to `execute`. Never gated. */
async function dispatchExecute(
  operation: "start-execution" | "stop-execution",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const pipelineName = requireDefined(settings.pipeline, "pipeline", operation);
  const { execute } = await import("./execute.js");
  return execute({
    operations: deps.operations,
    operation,
    pipeline: pipelineName,
    executionId: settings.executionId,
    clientRequestToken: settings.clientRequestToken,
    abandon: settings.abandon,
    reason: settings.reason,
  });
}

/**
 * `enable-stage-transition`/`disable-stage-transition`: dispatches to
 * `transitions`. Never gated. Presence of `pipeline`/`stage`/`transitionType`
 * (and `reason` for `disable-stage-transition`) is enforced by the engine's
 * Guards phase — see {@link REQUIRED_FIELDS}.
 */
async function dispatchTransitions(
  operation: "enable-stage-transition" | "disable-stage-transition",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<undefined> {
  const pipelineName = requireDefined(settings.pipeline, "pipeline", operation);
  const stage = requireDefined(settings.stage, "stage", operation);
  const transitionType = requireTransitionType(
    settings.transitionType,
    operation,
  );
  const { transitions } = await import("./transitions.js");
  await transitions({
    operations: deps.operations,
    operation,
    pipeline: pipelineName,
    stage,
    transitionType,
    reason: settings.reason,
  });
  return undefined;
}

/** `watch-execution`: dispatches to `watch-execution`'s step module. Never gated. */
async function dispatchWatch(
  _operation: "watch-execution",
  settings: RunSettings,
  _ctx: WriteDispatchPlan | undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const pipelineName = requireDefined(
    settings.pipeline,
    "pipeline",
    "watch-execution",
  );
  const executionId = requireDefined(
    settings.executionId,
    "executionId",
    "watch-execution",
  );
  const { watchExecution } = await import("./watch-execution.js");
  return watchExecution({
    operations: deps.operations,
    logger: deps.logger,
    pipeline: pipelineName,
    executionId,
    waitMaxAttempts: settings.waitMaxAttempts,
    waitIntervalSeconds: settings.waitIntervalSeconds,
  });
}

/** Persists `result` to `output` (when configured and non-`undefined`) via `Core.M3LJSONFileExporter`. */
async function persistOutput(
  paths: Core.M3LPaths,
  output: string | undefined,
  result: DispatchResult,
): Promise<void> {
  if (output === undefined || result === undefined) return;
  const exporter = new Core.M3LJSONFileExporter({
    filePath: paths.resolveOutput(output),
  });
  await exporter.export(result);
}

/**
 * Throws `ERR_CODEPIPELINE_OPS_WATCH_FAILED` when the resolved
 * `M3LCodePipelineExecution.status` is one of the three failed terminal
 * statuses (`Failed`/`Stopped`/`Cancelled`) — called *after*
 * {@link persistOutput}, so the terminal execution record survives on disk
 * even though the run then fails. `Succeeded` and `Superseded` both pass
 * through without throwing — a superseded execution is routine under
 * CodePipeline's default execution mode, not a failure.
 */
function assertWatchSucceeded(
  execution: AWS.M3LCodePipelineExecution,
  correlationId: string,
): void {
  if (!FAILED_STATUSES.has(execution.status)) return;
  throw new Core.M3LError(
    `codepipeline-ops run ${correlationId}: watch-execution resolved '${execution.status}'`,
    {
      code: "ERR_CODEPIPELINE_OPS_WATCH_FAILED",
      context: { status: execution.status },
    },
  );
}

/**
 * The `codepipeline-ops` pipeline: resolve settings → (for every operation)
 * plan a write dispatch → (for `create-pipeline`/`update-pipeline`/
 * `delete-pipeline`) the destructive-operation gate → the
 * operation-appropriate step → persist the result to `output` (when
 * configured) → assert `watch-execution` resolved successfully, all owned by
 * `Core.M3LOperationPipeline`. Built once at module load — a pipeline
 * instance is stateless across `run()` calls.
 *
 * A declined destructive-operation gate (`ERR_CODEPIPELINE_OPS_ABORTED`)
 * propagates to the caller unmodified (`onDecline: { kind: "throw" }`) — a
 * decline here aborts the whole run rather than soft-landing an empty result.
 */
const pipeline = new Core.M3LOperationPipeline<
  CodepipelineOperation,
  RunSettings,
  Deps,
  DispatchResult,
  WriteDispatchPlan | undefined
>({
  operations: CODEPIPELINE_OPS_OPERATIONS,
  configCode: "ERR_CODEPIPELINE_OPS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  prepare,
  destructive: {
    operations: new Set([
      "create-pipeline",
      "update-pipeline",
      "delete-pipeline",
    ] as const),
    describe: (operation, _settings, context, _deps) =>
      requireWritePlan(context, operation).description,
    yes: (settings) => settings.yes,
    abortCode: "ERR_CODEPIPELINE_OPS_ABORTED",
    onDecline: { kind: "throw" },
  },
  handlers: {
    "list-pipelines": dispatchReadPipelines,
    "describe-pipeline": dispatchReadPipelines,
    "get-pipeline-state": dispatchReadState,
    "list-executions": dispatchReadExecutions,
    "describe-execution": dispatchReadExecutions,
    "create-pipeline": dispatchWrite,
    "update-pipeline": dispatchWrite,
    "delete-pipeline": dispatchWrite,
    "start-execution": dispatchExecute,
    "stop-execution": dispatchExecute,
    "enable-stage-transition": dispatchTransitions,
    "disable-stage-transition": dispatchTransitions,
    "watch-execution": dispatchWatch,
  },
  persist: async (result, settings, deps) => {
    await persistOutput(deps.paths, settings.output, result);
  },
  finalize: (result, settings, deps) => {
    if (settings.operation !== "watch-execution") return;
    // `describe-execution` and `watch-execution` both resolve
    // `AWS.M3LCodePipelineExecution` — branching on `settings.operation`
    // (not a structural type predicate) avoids a false positive when
    // `describe-execution` resolves a Failed/Stopped/Cancelled execution.
    assertWatchSucceeded(
      result as AWS.M3LCodePipelineExecution,
      deps.correlationId,
    );
  },
});

/**
 * Composes the `codepipeline-ops` pipeline end to end via
 * `Core.M3LOperationPipeline`: resolves + guard-checks config, runs
 * `Core.confirmDestructive` for every mutating pipeline operation, dispatches
 * to the operation-appropriate step, persists the result to `output` (when
 * configured) via `Core.M3LJSONFileExporter`, and — for `watch-execution` —
 * throws once the result has had a chance to be persisted first.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LCodePipelineOperations`, and the interactive-prompt
 *   facade.
 * @returns A promise that resolves once the run completes successfully.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when a
 *   guard-checked per-operation requirement is unmet, or `operation` is
 *   outside the declared set (unreachable through the config schema's
 *   `oneOf` validator, guarded here defensively).
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_INPUT"` when
 *   `input` fails to read, fails to parse as JSON, or does not decode to a
 *   JSON object.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_NOT_FOUND"` when
 *   a read operation resolves `undefined` (the wrapper's not-found signal).
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_ABORTED"` when
 *   the destructive-operation confirmation is declined.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_WATCH_FAILED"`
 *   when `watch-execution` resolves a `M3LCodePipelineExecution` whose
 *   `status` is `Failed`/`Stopped`/`Cancelled` — thrown *after* the result
 *   has been persisted to `output`, when configured, so the terminal status
 *   is still on disk for diagnosis.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runCodepipelineOps } from "./run-codepipeline-ops.js";
 *
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * await runCodepipelineOps({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "codepipeline-ops", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   operations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function runCodepipelineOps(deps: Deps): Promise<void> {
  const outcome = await pipeline.run(deps);

  // Re-reads `pipeline`/`executionId` from config after the engine's `run()`
  // resolves — `M3LOperationPipeline`'s outcome doesn't carry the resolved
  // settings, and this stays a pure config read with no side effect, so
  // recomputing here (after `run()` resolves, so it never fires when
  // `finalize` throws) preserves the completion log's shape.
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_CODEPIPELINE_OPS_CONFIG",
  });
  const pipelineName = accessor.optionalString("pipeline");
  const executionId = accessor.optionalString("executionId");

  deps.logger.step(`codepipeline-ops run ${deps.correlationId} complete`, {
    operation: outcome.operation,
    ...(pipelineName !== undefined && { pipeline: pipelineName }),
    ...(executionId !== undefined && { executionId }),
  });
}
