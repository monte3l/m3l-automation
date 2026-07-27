import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  ABANDON_DEFAULT,
  CODEPIPELINE_OPS_OPERATIONS,
  STAGE_TRANSITION_TYPES,
  WAIT_MAX_ATTEMPTS_DEFAULT,
  WAIT_INTERVAL_SECONDS_DEFAULT,
  YES_DEFAULT,
} from "../config.js";
import { FAILED_STATUSES } from "./watch-execution.js";

/** The closed union of `codepipeline-ops`'s declared `operation` values. */
type CodepipelineOperation = (typeof CODEPIPELINE_OPS_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-codepipeline-ops` resolves once, up front. */
interface RawSettings {
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
  readonly waitMaxAttempts: number;
  readonly waitIntervalSeconds: number;
}

/** The dependencies every dispatched operation needs, once `config` has resolved. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly prompt: Core.M3LPrompt;
}

/** The union of result shapes any dispatched operation can resolve. `void` for `delete-pipeline`/both stage-transition operations. */
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

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces this
 * at config-load time in the real script; this defensive re-check protects a
 * caller (e.g. a test) that builds a `Core.M3LConfig` directly, bypassing
 * that validation.
 */
function readOperation(config: Core.M3LConfig): CodepipelineOperation {
  const value: unknown = config.get("operation");
  if (
    typeof value === "string" &&
    (CODEPIPELINE_OPS_OPERATIONS as readonly string[]).includes(value)
  ) {
    return value as CodepipelineOperation;
  }
  throw new Core.M3LError(
    `'operation' must be one of: ${CODEPIPELINE_OPS_OPERATIONS.join(", ")}`,
    { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
  );
}

/** Reads an optional string parameter, defensively re-checking its type (`undefined` when unset). */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Core.M3LError(`'${name}' must be a string`, {
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
  }
  return value;
}

/** Reads an optional number parameter, defensively re-checking its type (`undefined` when unset). */
function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
  }
  return value;
}

/**
 * Reads a boolean parameter, falling back to `defaultValue` when unset. A
 * `Core.M3LConfig` built directly (as tests do) never applies a declared
 * parameter's `defaultValue` — only `M3LScript.getConfiguration()` does — so
 * this reproduces that default at the read site.
 */
function readBoolWithDefault(
  config: Core.M3LConfig,
  name: string,
  defaultValue: boolean,
): boolean {
  const value: unknown = config.get(name);
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Core.M3LError(`'${name}' must be a boolean`, {
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
  }
  return value;
}

/** Reads a number parameter, falling back to `defaultValue` when unset — the numeric counterpart to {@link readBoolWithDefault}. */
function readNumberWithDefault(
  config: Core.M3LConfig,
  name: string,
  defaultValue: number,
): number {
  const value: unknown = config.get(name);
  if (value === undefined) return defaultValue;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_CODEPIPELINE_OPS_CONFIG",
    });
  }
  return value;
}

/** Returns `value`, throwing `ERR_CODEPIPELINE_OPS_CONFIG` when it is `undefined` — the per-operation cross-parameter guard. */
function requireString(
  value: string | undefined,
  name: string,
  operation: CodepipelineOperation,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `'${name}' is required for operation '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return value;
}

/** Guard-checks and narrows `transitionType` to the wrapper's closed `"Inbound" | "Outbound"` union. */
function requireTransitionType(
  value: string | undefined,
  operation: CodepipelineOperation,
): AWS.M3LCodePipelineStageTransitionType {
  const raw = requireString(value, "transitionType", operation);
  if ((STAGE_TRANSITION_TYPES as readonly string[]).includes(raw) === false) {
    throw new Core.M3LError(
      `'transitionType' must be one of: ${STAGE_TRANSITION_TYPES.join(", ")}`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return raw as AWS.M3LCodePipelineStageTransitionType;
}

/** Reads the file at `paths.resolveInput(name)` as raw text — the one place `input` is ever read. */
async function readInputFileText(
  paths: Core.M3LPaths,
  name: string,
): Promise<string> {
  const resolved = paths.resolveInput(name);
  try {
    return (await fsp.readFile(resolved)).toString("utf8");
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading input file '${name}'`, {
      code: "ERR_CODEPIPELINE_OPS_INPUT",
      cause,
    });
  }
}

/**
 * Reads and JSON-parses `input` under `M3L_INPUT_DIR`, for
 * `create-pipeline`/`update-pipeline`. The read and the parse are two
 * genuinely distinct fallible operations (a missing file vs. malformed
 * JSON), so each is wrapped in its own narrow `try`/`catch`.
 */
async function readJSONFile(
  paths: Core.M3LPaths,
  name: string,
): Promise<unknown> {
  const raw = await readInputFileText(paths, name);
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Core.M3LError(`'${name}' must be valid JSON`, {
      code: "ERR_CODEPIPELINE_OPS_INPUT",
      cause,
    });
  }
}

/** Narrows an already-parsed JSON value to a plain object, for `create-pipeline`/`update-pipeline`'s `input`. */
function asInputRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Core.M3LError(`'${name}' must decode to a JSON object`, {
      code: "ERR_CODEPIPELINE_OPS_INPUT",
    });
  }
  return value as Record<string, unknown>;
}

/** Runs `Core.confirmDestructive` — every mutating pipeline operation routes through this before dispatch. */
async function runGate(
  description: string,
  yes: boolean,
  deps: Pick<DispatchDeps, "prompt" | "logger">,
): Promise<void> {
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description,
    yes,
    code: "ERR_CODEPIPELINE_OPS_ABORTED",
  });
}

/** Builds `delete-pipeline`'s gate description from the `pipeline` config value. */
function buildDeleteGateDescription(pipeline: string): string {
  return `delete-pipeline pipeline '${pipeline}'`;
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

/** `list-pipelines`/`describe-pipeline`: guard-checks cross-parameter requirements, then dispatches to `read-pipelines`. */
async function dispatchReadPipelines(
  operation: "list-pipelines" | "describe-pipeline",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (operation === "describe-pipeline") {
    requireString(raw.pipeline, "pipeline", operation);
  }
  const { readPipelines } = await import("./read-pipelines.js");
  return readPipelines({
    operations: deps.operations,
    operation,
    pipeline: raw.pipeline,
    version: raw.version,
    nextToken: undefined,
    maxResults: raw.maxResults,
  });
}

/** `get-pipeline-state`: guard-checks `pipeline`, then dispatches to `read-state`. */
async function dispatchReadState(
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const pipeline = requireString(
    raw.pipeline,
    "pipeline",
    "get-pipeline-state",
  );
  const { readState } = await import("./read-state.js");
  return readState({ operations: deps.operations, pipeline });
}

/** `list-executions`/`describe-execution`: guard-checks cross-parameter requirements, then dispatches to `read-executions`. */
async function dispatchReadExecutions(
  operation: "list-executions" | "describe-execution",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const pipeline = requireString(raw.pipeline, "pipeline", operation);
  if (operation === "describe-execution") {
    requireString(raw.executionId, "executionId", operation);
  }
  const { readExecutions } = await import("./read-executions.js");
  return readExecutions({
    operations: deps.operations,
    operation,
    pipeline,
    executionId: raw.executionId,
    nextToken: undefined,
    maxResults: raw.maxResults,
  });
}

/** The per-write-operation description/declaration resolved before gating. */
interface WriteDispatchPlan {
  readonly description: string;
  readonly declaration: Record<string, unknown> | undefined;
}

/** Resolves `delete-pipeline`'s gate description directly from config, or reads+parses `create-pipeline`/`update-pipeline`'s `input` file. */
async function planWriteDispatch(
  operation: "create-pipeline" | "update-pipeline" | "delete-pipeline",
  raw: RawSettings,
  paths: Core.M3LPaths,
): Promise<WriteDispatchPlan> {
  if (operation === "delete-pipeline") {
    const pipeline = requireString(raw.pipeline, "pipeline", operation);
    return {
      description: buildDeleteGateDescription(pipeline),
      declaration: undefined,
    };
  }

  const inputName = requireString(raw.input, "input", operation);
  const parsed = asInputRecord(await readJSONFile(paths, inputName), inputName);
  return {
    description: buildRecordGateDescription(operation, parsed),
    declaration: parsed,
  };
}

/** `create-pipeline`/`update-pipeline`/`delete-pipeline`: resolves the operation's plan, gates, then dispatches to `write-pipeline`. */
async function dispatchWritePipeline(
  operation: "create-pipeline" | "update-pipeline" | "delete-pipeline",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const plan = await planWriteDispatch(operation, raw, deps.paths);
  await runGate(plan.description, raw.yes, deps);

  const { writePipeline } = await import("./write-pipeline.js");
  return writePipeline({
    operations: deps.operations,
    operation,
    declaration: plan.declaration,
    pipeline: raw.pipeline,
  });
}

/** `start-execution`/`stop-execution`: guard-checks cross-parameter requirements, then dispatches to `execute`. Never gated. */
async function dispatchExecute(
  operation: "start-execution" | "stop-execution",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const pipeline = requireString(raw.pipeline, "pipeline", operation);
  if (operation === "stop-execution") {
    requireString(raw.executionId, "executionId", operation);
  }
  const { execute } = await import("./execute.js");
  return execute({
    operations: deps.operations,
    operation,
    pipeline,
    executionId: raw.executionId,
    clientRequestToken: raw.clientRequestToken,
    abandon: raw.abandon,
    reason: raw.reason,
  });
}

/** `enable-stage-transition`/`disable-stage-transition`: guard-checks cross-parameter requirements, then dispatches to `transitions`. Never gated. */
async function dispatchTransitions(
  operation: "enable-stage-transition" | "disable-stage-transition",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const pipeline = requireString(raw.pipeline, "pipeline", operation);
  const stage = requireString(raw.stage, "stage", operation);
  const transitionType = requireTransitionType(raw.transitionType, operation);
  if (operation === "disable-stage-transition") {
    requireString(raw.reason, "reason", operation);
  }
  const { transitions } = await import("./transitions.js");
  await transitions({
    operations: deps.operations,
    operation,
    pipeline,
    stage,
    transitionType,
    reason: raw.reason,
  });
  return undefined;
}

/** `watch-execution`: guard-checks `pipeline`/`executionId`, then dispatches to `watch-execution`'s step module. Never gated. */
async function dispatchWatch(
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const pipeline = requireString(raw.pipeline, "pipeline", "watch-execution");
  const executionId = requireString(
    raw.executionId,
    "executionId",
    "watch-execution",
  );
  const { watchExecution } = await import("./watch-execution.js");
  return watchExecution({
    operations: deps.operations,
    logger: deps.logger,
    pipeline,
    executionId,
    waitMaxAttempts: raw.waitMaxAttempts,
    waitIntervalSeconds: raw.waitIntervalSeconds,
  });
}

/** Narrows `operation` to `list-pipelines`/`describe-pipeline`. */
function isReadPipelinesOperation(
  operation: CodepipelineOperation,
): operation is "list-pipelines" | "describe-pipeline" {
  return operation === "list-pipelines" || operation === "describe-pipeline";
}

/** Narrows `operation` to `list-executions`/`describe-execution`. */
function isReadExecutionsOperation(
  operation: CodepipelineOperation,
): operation is "list-executions" | "describe-execution" {
  return operation === "list-executions" || operation === "describe-execution";
}

/** Narrows `operation` to the three mutating pipeline operations. */
function isWriteOperation(
  operation: CodepipelineOperation,
): operation is "create-pipeline" | "update-pipeline" | "delete-pipeline" {
  return (
    operation === "create-pipeline" ||
    operation === "update-pipeline" ||
    operation === "delete-pipeline"
  );
}

/** Narrows `operation` to `start-execution`/`stop-execution`. */
function isExecuteOperation(
  operation: CodepipelineOperation,
): operation is "start-execution" | "stop-execution" {
  return operation === "start-execution" || operation === "stop-execution";
}

/** Narrows `operation` to the two stage-transition operations. */
function isTransitionsOperation(
  operation: CodepipelineOperation,
): operation is "enable-stage-transition" | "disable-stage-transition" {
  return (
    operation === "enable-stage-transition" ||
    operation === "disable-stage-transition"
  );
}

/**
 * The eight {@link CodepipelineOperation} members {@link dispatchOperation}
 * hands off to {@link dispatchMutatingOperation} — every operation that is
 * not one of the five read-only ones handled directly in
 * `dispatchOperation`. Declaring this as its own literal union (rather than
 * accepting the full {@link CodepipelineOperation}) is what makes the
 * `exhaustive: never` check below actually exhaustive: TypeScript does not
 * carry narrowing across a function boundary, so a parameter typed
 * `CodepipelineOperation` would leave the five excluded read operations
 * unnarrowed inside this function's own body.
 */
type MutatingOperation = Exclude<
  CodepipelineOperation,
  | "list-pipelines"
  | "describe-pipeline"
  | "get-pipeline-state"
  | "list-executions"
  | "describe-execution"
>;

/**
 * The second half of {@link dispatchOperation}'s exhaustive narrowing chain —
 * split into its own function to stay under the per-function line/complexity
 * caps (ADR-0022 §2). Routes the four mutating/execution-control/watch
 * families; the final `operation === "watch-execution"` check leaves nothing
 * unnarrowed, so a {@link CODEPIPELINE_OPS_OPERATIONS} member added without a
 * branch here fails to compile (`exhaustive: never` below) rather than
 * falling through silently at runtime.
 */
async function dispatchMutatingOperation(
  operation: MutatingOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (isWriteOperation(operation)) {
    return dispatchWritePipeline(operation, raw, deps);
  }
  if (isExecuteOperation(operation)) {
    return dispatchExecute(operation, raw, deps);
  }
  if (isTransitionsOperation(operation)) {
    return dispatchTransitions(operation, raw, deps);
  }
  if (operation === "watch-execution") {
    return dispatchWatch(raw, deps);
  }
  const exhaustive: never = operation;
  throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
    code: "ERR_CODEPIPELINE_OPS_CONFIG",
  });
}

/**
 * Dispatches to the operation-appropriate step, dynamic-importing it at
 * dispatch time (not a top-level static import) — so `steps/*.test.ts` can
 * `vi.mock` a step module before dispatch resolves it. An exhaustive
 * type-predicate chain (continued in {@link dispatchMutatingOperation}) routes
 * into the seven per-family dispatchers, each of which guard-checks its own
 * per-operation cross-parameter requirements before any gate or AWS call,
 * then — for every mutating pipeline operation — runs
 * `Core.confirmDestructive`.
 */
async function dispatchOperation(
  operation: CodepipelineOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (isReadPipelinesOperation(operation)) {
    return dispatchReadPipelines(operation, raw, deps);
  }
  if (operation === "get-pipeline-state") {
    return dispatchReadState(raw, deps);
  }
  if (isReadExecutionsOperation(operation)) {
    return dispatchReadExecutions(operation, raw, deps);
  }
  return dispatchMutatingOperation(operation, raw, deps);
}

/** Resolves the raw, per-operation-optional config values `run-codepipeline-ops` reads once, up front. */
function readRawSettings(config: Core.M3LConfig): RawSettings {
  return {
    pipeline: readOptionalString(config, "pipeline"),
    executionId: readOptionalString(config, "executionId"),
    stage: readOptionalString(config, "stage"),
    transitionType: readOptionalString(config, "transitionType"),
    reason: readOptionalString(config, "reason"),
    input: readOptionalString(config, "input"),
    version: readOptionalNumber(config, "version"),
    maxResults: readOptionalNumber(config, "maxResults"),
    clientRequestToken: readOptionalString(config, "clientRequestToken"),
    abandon: readBoolWithDefault(config, "abandon", ABANDON_DEFAULT),
    yes: readBoolWithDefault(config, "yes", YES_DEFAULT),
    waitMaxAttempts: readNumberWithDefault(
      config,
      "waitMaxAttempts",
      WAIT_MAX_ATTEMPTS_DEFAULT,
    ),
    waitIntervalSeconds: readNumberWithDefault(
      config,
      "waitIntervalSeconds",
      WAIT_INTERVAL_SECONDS_DEFAULT,
    ),
  };
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
 * Throws `ERR_CODEPIPELINE_OPS_WATCH_FAILED` when `operation` is
 * `watch-execution` and the resolved `M3LCodePipelineExecution.status` is one
 * of the three failed terminal statuses (`Failed`/`Stopped`/`Cancelled`) —
 * called *after* {@link persistOutput}, so the terminal execution record
 * survives on disk even though the run then fails. `Succeeded` and
 * `Superseded` both pass through without throwing — a superseded execution
 * is routine under CodePipeline's default execution mode, not a failure.
 */
function assertWatchSucceeded(
  operation: CodepipelineOperation,
  result: DispatchResult,
  correlationId: string,
): void {
  if (operation !== "watch-execution") return;
  const execution = result as AWS.M3LCodePipelineExecution;
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
 * Composes the `codepipeline-ops` pipeline end to end: resolves +
 * guard-checks config, runs `Core.confirmDestructive` for every mutating
 * pipeline operation, dispatches to the operation-appropriate step, persists
 * the result to `output` (when configured) via `Core.M3LJSONFileExporter`,
 * and — for `watch-execution` — throws once the result has had a chance to
 * be persisted first.
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
export async function runCodepipelineOps(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const operation = readOperation(deps.config);
  const raw = readRawSettings(deps.config);
  const output = readOptionalString(deps.config, "output");

  const result = await dispatchOperation(operation, raw, {
    paths: deps.paths,
    logger: deps.logger,
    operations: deps.operations,
    prompt: deps.prompt,
  });

  await persistOutput(deps.paths, output, result);
  assertWatchSucceeded(operation, result, deps.correlationId);

  deps.logger.step(`codepipeline-ops run ${deps.correlationId} complete`, {
    operation,
    ...(raw.pipeline !== undefined && { pipeline: raw.pipeline }),
    ...(raw.executionId !== undefined && { executionId: raw.executionId }),
  });
}
