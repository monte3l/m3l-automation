import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import { S3_OBJECTS_OPERATIONS } from "../config.js";
import { destructiveGate } from "./destructive-gate.js";
import { runDeleteBatch } from "./delete-batch.js";
import { runListObjects } from "./list-objects.js";
import { runSingleObjectOp } from "./single-object-ops.js";

/** The closed union of `s3-objects`'s declared `operation` values. */
type S3ObjectsOperation = (typeof S3_OBJECTS_OPERATIONS)[number];

/** Operations that route through {@link destructiveGate} before proceeding. */
const DESTRUCTIVE_OPERATIONS: ReadonlySet<S3ObjectsOperation> = new Set([
  "put",
  "copy",
  "delete",
  "delete-batch",
]);

/** The run summary `run-s3-objects` reports: objects/keys processed and failed. */
export interface RunS3ObjectsSummary {
  /**
   * Total object summaries listed (`list`), `1` per invocation for
   * `describe`/`get`/`put`/`copy`/`delete` regardless of hit/miss, or the
   * confirmed-deleted count for `delete-batch`.
   */
  readonly processed: number;
  /** Always `0` except for `delete-batch`, where it is the per-key failure count. */
  readonly failed: number;
}

/** The resolved, guard-checked settings a run needs. */
interface RunSettings {
  readonly operation: S3ObjectsOperation;
  readonly bucket: string;
  readonly key: string | undefined;
  readonly prefix: string | undefined;
  readonly pageSize: number | undefined;
  readonly sourceBucket: string | undefined;
  readonly sourceKey: string | undefined;
  readonly contentType: string | undefined;
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly yes: boolean;
}

/**
 * Reads the `operation` parameter, validating it against the declared set.
 * The declared `M3LConfigParameter`'s `oneOf` validator already enforces this
 * at config-load time in the real script; this defensive re-check protects a
 * caller (e.g. a test) that builds a `Core.M3LConfig` directly, bypassing
 * that validation.
 */
function readOperation(config: Core.M3LConfig): S3ObjectsOperation {
  const value: unknown = config.get("operation");
  if (
    typeof value === "string" &&
    (S3_OBJECTS_OPERATIONS as readonly string[]).includes(value)
  ) {
    return value as S3ObjectsOperation;
  }
  throw new Core.M3LError(
    `'operation' must be one of: ${S3_OBJECTS_OPERATIONS.join(", ")}`,
    { code: "ERR_S3_OBJECTS_CONFIG" },
  );
}

/** Reads a required non-empty string parameter, defensively re-checking its type. */
function readString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' must be a non-empty string`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** Reads an optional string parameter (`undefined` when unset). */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Core.M3LError(`'${name}' must be a string`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** Reads an optional numeric parameter (`undefined` when unset). */
function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError(`'${name}' must be a number`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** Reads a required boolean parameter, defensively re-checking its type. */
function readBool(config: Core.M3LConfig, name: string): boolean {
  const value: unknown = config.get(name);
  if (typeof value !== "boolean") {
    throw new Core.M3LError(`'${name}' must be a boolean`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** The five cross-parameter fields an operation's requirements are drawn from. */
type GuardedFieldName =
  "key" | "output" | "input" | "sourceBucket" | "sourceKey";

/**
 * Which of `key`/`output`/`input`/`sourceBucket`/`sourceKey` each operation
 * requires (see the contract's per-operation requirement table). Keyed as a
 * `Record<S3ObjectsOperation, …>` so a new operation added to
 * {@link S3_OBJECTS_OPERATIONS} without a corresponding entry here is a
 * compile error.
 */
const REQUIRED_FIELDS: Record<S3ObjectsOperation, readonly GuardedFieldName[]> =
  {
    list: ["output"],
    describe: ["key", "output"],
    get: ["key", "output"],
    put: ["key", "input"],
    copy: ["key", "sourceBucket", "sourceKey"],
    delete: ["key"],
    "delete-batch": ["input"],
  };

/**
 * Applies the cross-parameter requirements `M3LConfigParameter` cannot
 * express on its own (e.g. `key` is required for `describe` but not `list`),
 * throwing before any AWS call.
 */
function applyOperationGuards(
  operation: S3ObjectsOperation,
  fields: Record<GuardedFieldName, string | undefined>,
): void {
  for (const name of REQUIRED_FIELDS[operation]) {
    if (fields[name] === undefined) {
      throw new Core.M3LError(
        `'${name}' is required for operation '${operation}'`,
        { code: "ERR_S3_OBJECTS_CONFIG" },
      );
    }
  }
}

/**
 * Resolves and guard-checks every declared parameter this run needs,
 * throwing before any AWS call. `operation`/`bucket`/`aws.profile` presence
 * is enforced by the declared config schema at config-load time in the real
 * script; the type re-checks here are defensive (a caller building
 * `Core.M3LConfig` directly bypasses that validation), and the
 * cross-parameter requirements (e.g. `key` for `describe`) are genuinely
 * only checkable here.
 */
function resolveSettings(config: Core.M3LConfig): RunSettings {
  const operation = readOperation(config);
  const bucket = readString(config, "bucket");
  const key = readOptionalString(config, "key");
  const prefix = readOptionalString(config, "prefix");
  const pageSize = readOptionalNumber(config, "pageSize");
  const sourceBucket = readOptionalString(config, "sourceBucket");
  const sourceKey = readOptionalString(config, "sourceKey");
  const contentType = readOptionalString(config, "contentType");
  const input = readOptionalString(config, "input");
  const output = readOptionalString(config, "output");
  const yes = readBool(config, "yes");

  applyOperationGuards(operation, {
    key,
    output,
    input,
    sourceBucket,
    sourceKey,
  });

  return {
    operation,
    bucket,
    key,
    prefix,
    pageSize,
    sourceBucket,
    sourceKey,
    contentType,
    input,
    output,
    yes,
  };
}

/** Builds the human-readable description shown to the destructive-gate confirmation prompt. */
function describeDestructiveOp(settings: RunSettings): string {
  switch (settings.operation) {
    case "put":
      return `put object ${settings.bucket}/${String(settings.key)}`;
    case "copy":
      return `copy ${String(settings.sourceBucket)}/${String(settings.sourceKey)} to ${settings.bucket}/${String(settings.key)}`;
    case "delete":
      return `delete object ${settings.bucket}/${String(settings.key)}`;
    case "delete-batch":
      return `delete-batch keys listed in '${String(settings.input)}' against bucket ${settings.bucket}`;
    case "list":
    case "describe":
    case "get":
      // Guarded by DESTRUCTIVE_OPERATIONS.has(...) before this function is
      // ever called — reaching here means the gate was invoked for a
      // non-destructive operation, which is an internal miscall.
      throw new Core.M3LError(
        `internal: describeDestructiveOp called for non-destructive operation '${settings.operation}'`,
        { code: "ERR_S3_OBJECTS_CONFIG" },
      );
    default: {
      const exhaustive: never = settings.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_S3_OBJECTS_CONFIG",
      });
    }
  }
}

/** The dependencies `dispatch` needs once `config` has resolved to `settings`. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly s3: Parameters<typeof AWS.listObjects>[0];
}

/**
 * Narrows an optional field to its defined value, throwing a defensive
 * config error otherwise. `applyOperationGuards` has already enforced
 * presence for every field `dispatch` reads this way before `dispatch` is
 * ever called — this is a type-narrowing safety net, not an expected runtime
 * path.
 */
function requireDefined(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** `list`: streams the bucket listing to `output`, translating `runListObjects`'s summary. */
async function dispatchList(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const summary = await runListObjects({
    client: deps.s3,
    bucket: settings.bucket,
    ...(settings.prefix !== undefined && { prefix: settings.prefix }),
    ...(settings.pageSize !== undefined && {
      pageSize: settings.pageSize,
    }),
    outputPath: deps.paths.resolveOutput(
      requireDefined(settings.output, "output"),
    ),
    logger: deps.logger,
  });
  return { processed: summary.processed, failed: 0 };
}

/** The single-object operations `dispatchSingleObject` routes to `runSingleObjectOp`. */
type SingleObjectDispatchOperation = Exclude<
  S3ObjectsOperation,
  "list" | "delete-batch"
>;

/** `describe`/`get`: routes to `runSingleObjectOp`, reading the object to `output`. */
async function dispatchDescribeOrGet(
  operation: "describe" | "get",
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const summary = await runSingleObjectOp({
    client: deps.s3,
    operation,
    bucket: settings.bucket,
    key: requireDefined(settings.key, "key"),
    outputPath: deps.paths.resolveOutput(
      requireDefined(settings.output, "output"),
    ),
    logger: deps.logger,
  });
  return { processed: summary.processed, failed: 0 };
}

/** `put`: routes to `runSingleObjectOp`, uploading `input`'s bytes as the object body. */
async function dispatchPutObject(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const summary = await runSingleObjectOp({
    client: deps.s3,
    operation: "put",
    bucket: settings.bucket,
    key: requireDefined(settings.key, "key"),
    inputPath: deps.paths.resolveInput(requireDefined(settings.input, "input")),
    ...(settings.contentType !== undefined && {
      contentType: settings.contentType,
    }),
    logger: deps.logger,
  });
  return { processed: summary.processed, failed: 0 };
}

/** `copy`: routes to `runSingleObjectOp`, copying `sourceBucket`/`sourceKey` into `bucket`/`key`. */
async function dispatchCopyObject(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const summary = await runSingleObjectOp({
    client: deps.s3,
    operation: "copy",
    bucket: settings.bucket,
    key: requireDefined(settings.key, "key"),
    sourceBucket: requireDefined(settings.sourceBucket, "sourceBucket"),
    sourceKey: requireDefined(settings.sourceKey, "sourceKey"),
    logger: deps.logger,
  });
  return { processed: summary.processed, failed: 0 };
}

/** `delete`: routes to `runSingleObjectOp`, deleting `bucket`/`key`. */
async function dispatchDeleteObject(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const summary = await runSingleObjectOp({
    client: deps.s3,
    operation: "delete",
    bucket: settings.bucket,
    key: requireDefined(settings.key, "key"),
    logger: deps.logger,
  });
  return { processed: summary.processed, failed: 0 };
}

/**
 * `describe`/`get`/`put`/`copy`/`delete`: routes to the operation-appropriate
 * `runSingleObjectOp` dispatcher above.
 */
async function dispatchSingleObject(
  operation: SingleObjectDispatchOperation,
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  switch (operation) {
    case "describe":
    case "get":
      return dispatchDescribeOrGet(operation, settings, deps);
    case "put":
      return dispatchPutObject(settings, deps);
    case "copy":
      return dispatchCopyObject(settings, deps);
    case "delete":
      return dispatchDeleteObject(settings, deps);
    default: {
      const exhaustive: never = operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_S3_OBJECTS_CONFIG",
      });
    }
  }
}

/** `delete-batch`: deletes every key listed in `input`, translating `runDeleteBatch`'s result. */
async function dispatchDeleteBatch(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  const result = await runDeleteBatch({
    client: deps.s3,
    bucket: settings.bucket,
    inputPath: deps.paths.resolveInput(requireDefined(settings.input, "input")),
    failedOutputPath: deps.paths.resolveOutput("failed.jsonl"),
    logger: deps.logger,
  });
  return { processed: result.deleted, failed: result.errors.length };
}

/**
 * Dispatches to the operation-appropriate step, translating each step's own
 * result shape into the shared `{ processed, failed }` run summary.
 */
async function dispatch(
  settings: RunSettings,
  deps: DispatchDeps,
): Promise<RunS3ObjectsSummary> {
  switch (settings.operation) {
    case "list":
      return dispatchList(settings, deps);
    case "describe":
    case "get":
    case "put":
    case "copy":
    case "delete":
      return dispatchSingleObject(settings.operation, settings, deps);
    case "delete-batch":
      return dispatchDeleteBatch(settings, deps);
    default: {
      const exhaustive: never = settings.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_S3_OBJECTS_CONFIG",
      });
    }
  }
}

/**
 * Composes the `s3-objects` pipeline end to end — the only module that knows
 * operation dispatch order: resolve + guard-check config → (the
 * destructive-operation gate, for `put`/`copy`/`delete`/`delete-batch`) →
 * the operation-appropriate step → the run summary.
 *
 * An operator declining the destructive-operation gate (`confirm` resolving
 * `false`, surfacing as `ERR_S3_OBJECTS_ABORTED`) soft-lands: this function
 * logs a warning and resolves an all-zero summary rather than throwing. Any
 * other gate failure propagates unmodified. This mirrors `dynamodb-crud`'s
 * `ERR_DYNAMO_CRUD_ABORTED` handling, not `sqs-etl`'s.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, the provisioned `s3` client, and `script.prompt`.
 * @returns The run summary: objects/keys processed and failed.
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_CONFIG` when a required
 *   parameter is missing/malformed for the requested operation.
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_FAILED_KEYS` when the
 *   run completes but leaves one or more `delete-batch` keys failed — a
 *   partial batch failure must never be silent.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runS3Objects } from "./run-s3-objects.js";
 *
 * const summary = await runS3Objects({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "s3-objects", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   s3: script.aws?.clients.s3,
 *   prompt: script.prompt,
 * });
 * console.log(summary.processed, summary.failed);
 * ```
 */
export async function runS3Objects(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly s3: Parameters<typeof AWS.listObjects>[0];
  readonly prompt: Core.M3LPrompt;
}): Promise<RunS3ObjectsSummary> {
  const settings = resolveSettings(deps.config);

  if (DESTRUCTIVE_OPERATIONS.has(settings.operation)) {
    try {
      await destructiveGate({
        prompt: deps.prompt,
        logger: deps.logger,
        description: describeDestructiveOp(settings),
        yes: settings.yes,
      });
    } catch (cause) {
      if (
        cause instanceof Core.M3LError &&
        cause.code === "ERR_S3_OBJECTS_ABORTED"
      ) {
        deps.logger.warning(
          `s3-objects run ${deps.correlationId} aborted before '${settings.operation}' on bucket '${settings.bucket}'`,
        );
        return { processed: 0, failed: 0 };
      }
      throw cause;
    }
  }

  const summary = await dispatch(settings, {
    paths: deps.paths,
    logger: deps.logger,
    s3: deps.s3,
  });

  deps.logger.step(`s3-objects run ${deps.correlationId} complete`, {
    processed: summary.processed,
    failed: summary.failed,
  });

  // A partial delete-batch failure must never be silent: this is the domain
  // decision that a non-zero `failed` count fails the whole run, so it lives
  // here (not in `main.ts`, which stays pure composition/propagation per
  // ADR-0022 — see main.ts's own header comment).
  if (summary.failed > 0) {
    throw new Core.M3LError(
      `s3-objects run ${deps.correlationId} left ${String(summary.failed)} key(s) failed`,
      { code: "ERR_S3_OBJECTS_FAILED_KEYS", context: { ...summary } },
    );
  }

  return summary;
}
