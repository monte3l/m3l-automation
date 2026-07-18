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
}

/** The dependencies every dispatched operation needs, once `config` has resolved. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly operations: AWS.M3LLambdaOperations;
  readonly prompt: Core.M3LPrompt;
}

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces this
 * at config-load time in the real script; this defensive re-check protects a
 * caller (e.g. a test) that builds a `Core.M3LConfig` directly, bypassing
 * that validation.
 */
function readOperation(config: Core.M3LConfig): LambdaOperation {
  const value: unknown = config.get("operation");
  if (
    typeof value === "string" &&
    (LAMBDA_OPERATIONS as readonly string[]).includes(value)
  ) {
    return value as LambdaOperation;
  }
  throw new Core.M3LError(
    `'operation' must be one of: ${LAMBDA_OPERATIONS.join(", ")}`,
    { code: "ERR_LAMBDA_OPS_CONFIG" },
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
      code: "ERR_LAMBDA_OPS_CONFIG",
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
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
  }
  return value;
}

/** Returns `value`, throwing `ERR_LAMBDA_OPS_CONFIG` when it is `undefined` — the per-operation cross-parameter guard. */
function requireString(
  value: string | undefined,
  name: string,
  operation: LambdaOperation,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `'${name}' is required for operation '${operation}'`,
      { code: "ERR_LAMBDA_OPS_CONFIG" },
    );
  }
  return value;
}

/** Reads the file at `paths.resolveInput(name)` as raw text — the one place either `zipFilePath` or `input` is ever read. */
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
      code: "ERR_LAMBDA_OPS_CONFIG",
      cause,
    });
  }
}

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
 * Reads and JSON-parses `input` under `M3L_INPUT_DIR`, for
 * `create`/`update-configuration`/`invoke`. The read and the parse are two
 * genuinely distinct fallible operations (a missing file vs. malformed JSON),
 * so each is wrapped in its own narrow `try`/`catch`.
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
      code: "ERR_LAMBDA_OPS_CONFIG",
      cause,
    });
  }
}

/** Narrows an already-parsed JSON value to a plain object, for `create`/`update-configuration`'s `input`. */
function asInputRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Core.M3LError(`'${name}' must decode to a JSON object`, {
      code: "ERR_LAMBDA_OPS_CONFIG",
    });
  }
  return value as Record<string, unknown>;
}

/** Builds the human-readable description `destructive-gate` prints/prompts with. */
function buildGateDescription(
  operation: LambdaOperation,
  functionName: string,
): string {
  return `${operation} function '${functionName}'`;
}

/** Dynamic-imports and runs `destructive-gate` — every mutating operation routes through this before dispatch. */
async function runGate(
  operation: LambdaOperation,
  functionName: string,
  yes: boolean,
  deps: Pick<DispatchDeps, "prompt" | "logger">,
): Promise<void> {
  const { destructiveGate } = await import("./destructive-gate.js");
  await destructiveGate({
    prompt: deps.prompt,
    logger: deps.logger,
    description: buildGateDescription(operation, functionName),
    yes,
  });
}

/** The four mutating operations dispatched through `write-function` — mirrors that module's own (unexported) union. */
type WriteOperation =
  "create" | "update-code" | "update-configuration" | "delete";

/** The three dispatch families `lambda-ops` routes operations into. */
type DispatchGroup = "read" | "invoke" | "write";

/**
 * Which dispatch family each operation belongs to. Keyed as a
 * `Record<LambdaOperation, …>` so a new operation added to
 * {@link LAMBDA_OPERATIONS} without a corresponding entry here is a compile
 * error — the same exhaustiveness an explicit `switch` would give, without
 * the per-case line/complexity cost.
 */
const DISPATCH_GROUP: Record<LambdaOperation, DispatchGroup> = {
  list: "read",
  describe: "read",
  invoke: "invoke",
  create: "write",
  "update-code": "write",
  "update-configuration": "write",
  delete: "write",
};

/** Narrows `operation` to `list`/`describe`, matching {@link DISPATCH_GROUP}'s `"read"` entries. */
function isReadOperation(
  operation: LambdaOperation,
): operation is "list" | "describe" {
  return operation === "list" || operation === "describe";
}

/** Narrows `operation` to {@link WriteOperation}, matching {@link DISPATCH_GROUP}'s `"write"` entries. */
function isWriteOperation(
  operation: LambdaOperation,
): operation is WriteOperation {
  return (
    operation === "create" ||
    operation === "update-code" ||
    operation === "update-configuration" ||
    operation === "delete"
  );
}

/** `list`/`describe`: dispatches to `read-functions`, guard-checking `functionName` for `describe`. */
async function dispatchRead(
  operation: "list" | "describe",
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<unknown> {
  const { readFunctions } = await import("./read-functions.js");
  if (operation === "list") {
    return readFunctions({
      operations: deps.operations,
      operation: "list",
      marker: raw.marker,
      functionName: undefined,
    });
  }
  const functionName = requireString(
    raw.functionName,
    "functionName",
    operation,
  );
  return readFunctions({
    operations: deps.operations,
    operation: "describe",
    marker: undefined,
    functionName,
  });
}

/** `invoke`: guard-checks `functionName`, gates, resolves the optional payload, then dispatches to `invoke-function`. */
async function dispatchInvoke(
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<unknown> {
  const functionName = requireString(
    raw.functionName,
    "functionName",
    "invoke",
  );
  await runGate("invoke", functionName, raw.yes, deps);
  const payload =
    raw.input === undefined
      ? undefined
      : await readJSONFile(deps.paths, raw.input);
  const { invokeFunction } = await import("./invoke-function.js");
  return invokeFunction({ operations: deps.operations, functionName, payload });
}

/** The per-write-operation cross-parameter fields, guard-checked before any gate or AWS call. */
interface WriteFields {
  readonly functionName: string;
  readonly zipFilePath: string | undefined;
  readonly inputName: string | undefined;
}

/**
 * Guard-checks the cross-parameter requirements each write operation
 * declares — `zipFilePath` for `create`/`update-code`, `input` for
 * `create`/`update-configuration` — entirely before any gate or AWS call.
 */
function requireWriteFields(
  operation: WriteOperation,
  raw: RawSettings,
): WriteFields {
  const functionName = requireString(
    raw.functionName,
    "functionName",
    operation,
  );
  const zipFilePath =
    operation === "create" || operation === "update-code"
      ? requireString(raw.zipFilePath, "zipFilePath", operation)
      : undefined;
  const inputName =
    operation === "create" || operation === "update-configuration"
      ? requireString(raw.input, "input", operation)
      : undefined;
  return { functionName, zipFilePath, inputName };
}

/**
 * `create`/`update-code`/`update-configuration`/`delete`: guard-checks the
 * operation's cross-parameter requirements, gates, resolves `zipFilePath`/
 * `input` into raw bytes/parsed JSON when the operation declares them, then
 * dispatches to `write-function`.
 */
async function dispatchWrite(
  operation: WriteOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<unknown> {
  const fields = requireWriteFields(operation, raw);
  await runGate(operation, fields.functionName, raw.yes, deps);

  const zipFile =
    fields.zipFilePath === undefined
      ? undefined
      : await readZipFileBytes(deps.paths, fields.zipFilePath);
  const input =
    fields.inputName === undefined
      ? undefined
      : asInputRecord(
          await readJSONFile(deps.paths, fields.inputName),
          fields.inputName,
        );

  const { writeFunction } = await import("./write-function.js");
  return writeFunction({
    operations: deps.operations,
    operation,
    functionName: fields.functionName,
    zipFile,
    input,
  });
}

/**
 * Dispatches to the operation-appropriate step, dynamic-importing it at
 * dispatch time (not a top-level static import) — the same reason
 * `api-gateway-client`'s dispatcher does: so `steps/*.test.ts` can `vi.mock`
 * a step module before dispatch resolves it. Routes through
 * {@link DISPATCH_GROUP} into {@link dispatchRead}/{@link dispatchInvoke}/
 * {@link dispatchWrite}, each of which guard-checks its own per-operation
 * cross-parameter requirements before any gate or AWS call, then — for every
 * operation except `list`/`describe` — runs `destructive-gate`.
 */
async function dispatchOperation(
  operation: LambdaOperation,
  raw: RawSettings,
  deps: DispatchDeps,
): Promise<unknown> {
  const group = DISPATCH_GROUP[operation];
  switch (group) {
    case "read": {
      if (!isReadOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a read operation`,
          { code: "ERR_LAMBDA_OPS_CONFIG" },
        );
      }
      return dispatchRead(operation, raw, deps);
    }
    case "invoke":
      return dispatchInvoke(raw, deps);
    case "write": {
      if (!isWriteOperation(operation)) {
        throw new Core.M3LError(
          `internal: '${operation}' miscategorized as a write operation`,
          { code: "ERR_LAMBDA_OPS_CONFIG" },
        );
      }
      return dispatchWrite(operation, raw, deps);
    }
    default: {
      const exhaustive: never = group;
      throw new Core.M3LError(
        `unhandled dispatch group: ${String(exhaustive)}`,
        { code: "ERR_LAMBDA_OPS_CONFIG" },
      );
    }
  }
}

/**
 * Composes the `lambda-ops` pipeline end to end: resolves + guard-checks
 * config, runs `destructive-gate` for every mutating operation, dispatches to
 * the operation-appropriate step, persists the result to `output` (when
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
export async function runLambdaOps(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly operations: AWS.M3LLambdaOperations;
  readonly prompt: Core.M3LPrompt;
}): Promise<void> {
  const operation = readOperation(deps.config);
  const raw: RawSettings = {
    functionName: readOptionalString(deps.config, "functionName"),
    marker: readOptionalString(deps.config, "marker"),
    zipFilePath: readOptionalString(deps.config, "zipFilePath"),
    input: readOptionalString(deps.config, "input"),
    yes: readBoolWithDefault(deps.config, "yes", YES_DEFAULT),
  };
  const output = readOptionalString(deps.config, "output");

  const result = await dispatchOperation(operation, raw, {
    paths: deps.paths,
    logger: deps.logger,
    operations: deps.operations,
    prompt: deps.prompt,
  });

  if (output !== undefined && result !== undefined) {
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(output),
    });
    await exporter.export(result);
  }

  const invokeResult =
    operation === "invoke" ? (result as AWS.M3LLambdaInvokeResult) : undefined;

  if (invokeResult !== undefined && invokeResult.functionError !== undefined) {
    throw new Core.M3LError(
      `lambda-ops run ${deps.correlationId}: invoke returned a function error`,
      {
        code: "ERR_LAMBDA_OPS_FUNCTION_ERROR",
        context: { functionError: invokeResult.functionError },
      },
    );
  }

  deps.logger.step(`lambda-ops run ${deps.correlationId} complete`, {
    operation,
    ...(raw.functionName !== undefined && { functionName: raw.functionName }),
    // Only the numeric statusCode — never payload/logResult/functionError,
    // which may carry caller data the library never logs by default.
    ...(invokeResult !== undefined && { statusCode: invokeResult.statusCode }),
  });
}
