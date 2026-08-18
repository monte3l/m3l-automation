import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { LAMBDA_OPERATIONS, YES_DEFAULT } from "../config.js";

/** The closed union of `lambda-ops`'s declared `operation` values. */
type LambdaOperation = (typeof LAMBDA_OPERATIONS)[number];

/** The raw, per-operation-optional config values `run-lambda-ops` resolves once, up front. */
interface RawSettings {
  readonly functionName: string | undefined;
  readonly marker: string | undefined;
  readonly zipFilePath: string | undefined;
  readonly input: string | undefined;
  readonly yes: boolean;
  readonly output: string | undefined;
}

/** The full dependency bag `runLambdaOps` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  readonly operations: AWS.M3LLambdaOperations;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AWS.M3LLambdaListFunctionsResult
  | AWS.M3LLambdaFunctionConfiguration
  | AWS.M3LLambdaInvokeResult
  | undefined;

/** Reads `zipFilePath` under `M3L_INPUT_DIR` as raw bytes, for `create`/`update-code`. */
async function readZipFileBytes(
  paths: Core.M3LPaths,
  zipFilePath: string,
): Promise<Uint8Array> {
  const resolved = paths.resolveInput(zipFilePath);
  try {
    return await fsp.readFile(resolved);
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading zip file '${zipFilePath}'`, {
      code: "ERR_LAMBDA_OPS_CONFIG",
      cause,
    });
  }
}

/**
 * Builds a fresh `Core.M3LConfigAccessor` over `deps.config`, coded
 * `ERR_LAMBDA_OPS_CONFIG`. `M3LOperationHandlers` only receive the pipeline's
 * `deps` bag — not the engine's own internal accessor — so the one remaining
 * site that still needs a config read outside the engine's own phases (the
 * completion-log re-read in {@link runLambdaOps}) builds its own.
 * `M3LConfigAccessor` is a stateless read-through wrapper, so constructing a
 * fresh one per call is behaviorally identical to sharing one instance.
 */
function buildAccessor(deps: Deps): Core.M3LConfigAccessor {
  return new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_LAMBDA_OPS_CONFIG",
  });
}

/** Builds a fresh `Core.M3LInputFileReader` over `deps.paths`, coded `ERR_LAMBDA_OPS_CONFIG` — see {@link buildAccessor}. */
function buildReader(deps: Deps): Core.M3LInputFileReader {
  return new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_LAMBDA_OPS_CONFIG",
  });
}

/**
 * Narrows an already-guarded optional settings field to its defined value,
 * throwing a defensive `ERR_LAMBDA_OPS_CONFIG` otherwise. The pipeline's
 * `requiredFields` guard (phase 4) has already enforced presence for every
 * field callers read this way before those callers are ever invoked — this
 * is a type-narrowing safety net, not an expected runtime path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
  }
  return value;
}

/**
 * Resolves the raw, per-operation-optional config values the pipeline reads
 * once, up front. Must not re-read `"operation"` or apply its own
 * required-field guards — those are owned by the engine's own "Operation"
 * and "Guards" phases (the latter driven by {@link REQUIRED_FIELDS}).
 */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    functionName: accessor.optionalString("functionName"),
    marker: accessor.optionalString("marker"),
    zipFilePath: accessor.optionalString("zipFilePath"),
    input: accessor.optionalString("input"),
    yes: accessor.booleanWithDefault("yes", YES_DEFAULT),
    output: accessor.optionalString("output"),
  };
}

/**
 * Which of `functionName`/`zipFilePath`/`input` each operation requires,
 * checked via `Core.M3LConfigAccessor.requiredFor` in the engine's own
 * "Guards" phase (phase 4) — before the destructive gate or any handler
 * ever runs. Keyed as a `Record<LambdaOperation, …>` so a new operation
 * added to {@link LAMBDA_OPERATIONS} without a corresponding entry here is a
 * compile error. `invoke`'s `input` is deliberately excluded — a missing
 * `input` means "invoke with an empty payload", not a config error.
 */
const REQUIRED_FIELDS: Record<
  LambdaOperation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  list: [],
  describe: ["functionName"],
  invoke: ["functionName"],
  create: ["functionName", "zipFilePath", "input"],
  "update-code": ["functionName", "zipFilePath"],
  "update-configuration": ["functionName", "input"],
  delete: ["functionName"],
};

/**
 * `list`: dispatches to `read-functions` with the resolved marker. Never
 * gated — `list` is a read-only operation.
 */
async function dispatchList(
  _operation: "list",
  settings: RawSettings,
  _context: undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const { readFunctions } = await import("./read-functions.js");
  return readFunctions({
    operations: deps.operations,
    operation: "list",
    marker: settings.marker,
    functionName: undefined,
  });
}

/**
 * `describe`: dispatches to `read-functions` with the resolved `functionName`.
 * Cross-parameter presence is enforced by the engine's Guards phase before
 * this runs — see {@link REQUIRED_FIELDS}. Never gated.
 */
async function dispatchDescribe(
  _operation: "describe",
  settings: RawSettings,
  _context: undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const { readFunctions } = await import("./read-functions.js");
  return readFunctions({
    operations: deps.operations,
    operation: "describe",
    functionName: requireDefined(settings.functionName, "functionName"),
    marker: undefined,
  });
}

/**
 * `invoke`: resolves the optional payload from `input` (a missing `input`
 * means "invoke with an empty payload"), then dispatches to `invoke-function`.
 * Presence of `functionName` is enforced by the engine's Guards phase before
 * this runs — see {@link REQUIRED_FIELDS}.
 */
async function dispatchInvoke(
  _operation: "invoke",
  settings: RawSettings,
  _context: undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const reader = buildReader(deps);
  const payload =
    settings.input !== undefined
      ? await reader.readJSON(settings.input)
      : undefined;
  const { invokeFunction } = await import("./invoke-function.js");
  return invokeFunction({
    operations: deps.operations,
    functionName: requireDefined(settings.functionName, "functionName"),
    payload,
  });
}

/**
 * `create`/`update-code`/`update-configuration`/`delete`: resolves zip bytes
 * and/or parses the input JSON when the operation declares them, then
 * dispatches to `write-function`. Cross-parameter presence is enforced by the
 * engine's Guards phase before this runs — see {@link REQUIRED_FIELDS}.
 */
async function dispatchWrite(
  operation: "create" | "update-code" | "update-configuration" | "delete",
  settings: RawSettings,
  _context: undefined,
  deps: Deps,
): Promise<DispatchResult> {
  const zipFile =
    settings.zipFilePath !== undefined
      ? await readZipFileBytes(
          deps.paths,
          requireDefined(settings.zipFilePath, "zipFilePath"),
        )
      : undefined;
  const input =
    settings.input !== undefined
      ? await buildReader(deps).readJSONRecord(
          requireDefined(settings.input, "input"),
        )
      : undefined;
  const { writeFunction } = await import("./write-function.js");
  return writeFunction({
    operations: deps.operations,
    reader: buildReader(deps),
    operation,
    functionName: requireDefined(settings.functionName, "functionName"),
    zipFile,
    input,
  });
}

/**
 * The `lambda-ops` pipeline: resolve settings → (for `invoke`/`create`/
 * `update-code`/`update-configuration`/`delete`) the destructive-operation
 * gate → the operation-appropriate step → persist the result to `output`
 * (when configured) → throw on a populated `invoke` `functionError`, all
 * owned by `Core.M3LOperationPipeline`. Built once at module load — a
 * pipeline instance is stateless across `run()` calls.
 *
 * A declined destructive-operation gate (`ERR_LAMBDA_OPS_ABORTED`) propagates
 * to the caller unmodified (`onDecline: { kind: "throw" }`).
 */
const pipeline = new Core.M3LOperationPipeline<
  LambdaOperation,
  RawSettings,
  Deps,
  DispatchResult
>({
  operations: LAMBDA_OPERATIONS,
  configCode: "ERR_LAMBDA_OPS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  destructive: {
    operations: new Set([
      "invoke",
      "create",
      "update-code",
      "update-configuration",
      "delete",
    ] as const),
    describe: (operation, settings) =>
      `${operation} function '${requireDefined(settings.functionName, "functionName")}'`,
    yes: (settings) => settings.yes,
    abortCode: "ERR_LAMBDA_OPS_ABORTED",
    onDecline: { kind: "throw" },
  },
  handlers: {
    list: dispatchList,
    describe: dispatchDescribe,
    invoke: dispatchInvoke,
    create: dispatchWrite,
    "update-code": dispatchWrite,
    "update-configuration": dispatchWrite,
    delete: dispatchWrite,
  },
  persist: async (result, settings, deps) => {
    if (settings.output === undefined || result === undefined) return;
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(settings.output),
    });
    await exporter.export(result);
  },
  finalize: (result, _settings, deps, operation) => {
    if (operation !== "invoke") return;
    const invokeResult = result as AWS.M3LLambdaInvokeResult;
    if (invokeResult.functionError === undefined) return;
    throw new Core.M3LError(
      `lambda-ops run ${deps.correlationId}: invoke returned a function error`,
      {
        code: "ERR_LAMBDA_OPS_FUNCTION_ERROR",
        context: { functionError: invokeResult.functionError },
      },
    );
  },
});

/**
 * Composes the `lambda-ops` pipeline end to end via
 * `Core.M3LOperationPipeline`: resolves + guard-checks config, runs
 * `Core.confirmDestructive` for every mutating operation, dispatches to the
 * operation-appropriate step, persists the result to `output` (when
 * configured) via `Core.M3LJSONFileExporter`, and — for `invoke` — throws
 * once a populated `functionError` has had a chance to be persisted first.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   injected `AWS.M3LLambdaOperations`, and the interactive-prompt facade.
 * @returns A promise that resolves once the run completes successfully.
 * @throws {@link Core.M3LError} coded `"ERR_LAMBDA_OPS_CONFIG"` when a
 *   guard-checked per-operation requirement is unmet, or `operation` is
 *   outside the declared set (unreachable through the config schema's
 *   `oneOf` validator, guarded here defensively).
 * @throws {@link Core.M3LError} coded `"ERR_LAMBDA_OPS_ABORTED"` when the
 *   destructive-operation confirmation is declined.
 * @throws {@link Core.M3LError} coded `"ERR_LAMBDA_OPS_FUNCTION_ERROR"` when
 *   `invoke` returns a populated `functionError` (the handler threw or timed
 *   out) — thrown *after* the result has been persisted to `output`, when
 *   configured, so the payload/`logResult` is still on disk for diagnosis.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runLambdaOps } from "./run-lambda-ops.js";
 *
 * declare const operations: AWS.M3LLambdaOperations;
 *
 * await runLambdaOps({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "lambda-ops", version: "0.0.0" },
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
export async function runLambdaOps(deps: Deps): Promise<void> {
  const outcome = await pipeline.run(deps);

  // Re-read functionName for the completion log. The engine's outcome doesn't
  // carry resolved settings, so re-derive from config (pure read, no side
  // effect — same as ecs-ops's post-run accessor pattern).
  const accessor = buildAccessor(deps);
  const functionName = accessor.optionalString("functionName");
  const invokeResult =
    outcome.operation === "invoke"
      ? (outcome.result as AWS.M3LLambdaInvokeResult)
      : undefined;

  deps.logger.step(`lambda-ops run ${deps.correlationId} complete`, {
    operation: outcome.operation,
    ...(functionName !== undefined && { functionName }),
    // Only the numeric statusCode — never payload/logResult/functionError,
    // which may carry caller data the library never logs by default.
    ...(invokeResult !== undefined && { statusCode: invokeResult.statusCode }),
  });
}
