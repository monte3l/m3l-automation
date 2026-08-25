import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import { S3_OBJECTS_OPERATIONS } from "../config.js";
import { runDeleteBatch } from "./delete-batch.js";
import { runListObjects } from "./list-objects.js";
import { runSingleObjectOp } from "./single-object-ops.js";

/** The closed union of `s3-objects`'s declared `operation` values. */
type S3ObjectsOperation = (typeof S3_OBJECTS_OPERATIONS)[number];

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
  /**
   * The per-key failures `delete-batch` absorbed, when any. Populated only
   * on the internal handler result the pipeline's `recovery` callback reads
   * to build {@link Core.M3LRunRecoveryEntry} entries — `runS3Objects` itself
   * never surfaces this field on the summary it resolves.
   */
  readonly errors?: readonly AWS.S3DeleteError[];
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

/** The five cross-parameter fields an operation's requirements are drawn from. */
type GuardedFieldName =
  "key" | "output" | "input" | "sourceBucket" | "sourceKey";

/**
 * Which of `key`/`output`/`input`/`sourceBucket`/`sourceKey` each operation
 * requires (see the contract's per-operation requirement table). Keyed as a
 * `Record<S3ObjectsOperation, …>` so a new operation added to
 * {@link S3_OBJECTS_OPERATIONS} without a corresponding entry here is a
 * compile error. Fed to `Core.M3LOperationPipeline`'s `requiredFields`
 * option, which owns the actual per-operation guard check.
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
 * Resolves every declared parameter this run needs from the pipeline's own
 * accessor. `operation`/`bucket`/`aws.profile` presence is enforced by the
 * declared config schema at config-load time in the real script; the type
 * re-checks here are defensive (a caller building `Core.M3LConfig` directly
 * bypasses that validation). Must not re-read `"operation"` or apply its own
 * required-field guards — `Core.M3LOperationPipeline` owns both (the
 * "Operation" and "Guards" phases).
 */
function resolveSettings(
  accessor: Core.M3LConfigAccessor,
  operation: S3ObjectsOperation,
): RunSettings {
  const bucket = accessor.requiredString("bucket", operation);
  const key = accessor.optionalString("key");
  const prefix = accessor.optionalString("prefix");
  const pageSize = accessor.optionalNumber("pageSize");
  const sourceBucket = accessor.optionalString("sourceBucket");
  const sourceKey = accessor.optionalString("sourceKey");
  const contentType = accessor.optionalString("contentType");
  const input = accessor.optionalString("input");
  const output = accessor.optionalString("output");
  const yes = accessor.requiredBoolean("yes", operation);

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

/**
 * Narrows an optional field to its defined value, throwing a defensive
 * config error otherwise. The pipeline's `requiredFields` guard has already
 * enforced presence for every field callers read this way before those
 * callers are ever invoked — this is a type-narrowing safety net, not an
 * expected runtime path.
 */
function requireDefined(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/** Builds the human-readable description shown to the `Core.confirmDestructive` confirmation prompt. */
function describeDestructiveOp(settings: RunSettings): string {
  switch (settings.operation) {
    case "put":
      return `put object ${settings.bucket}/${requireDefined(settings.key, "key")}`;
    case "copy":
      return `copy ${requireDefined(settings.sourceBucket, "sourceBucket")}/${requireDefined(settings.sourceKey, "sourceKey")} to ${settings.bucket}/${requireDefined(settings.key, "key")}`;
    case "delete":
      return `delete object ${settings.bucket}/${requireDefined(settings.key, "key")}`;
    case "delete-batch":
      return `delete-batch keys listed in '${requireDefined(settings.input, "input")}' against bucket ${settings.bucket}`;
    case "list":
    case "describe":
    case "get":
      // Guarded by destructive.operations before this function is ever
      // called — reaching here means the gate was invoked for a
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

/** The full dependency bag `runS3Objects` receives and the pipeline threads through. */
interface Deps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  readonly s3: Parameters<typeof AWS.listObjects>[0];
  /**
   * Reports one absorbed per-key `delete-batch` failure. Called once per
   * {@link Core.M3LRunRecoveryEntry} produced by the pipeline's `recovery`
   * callback when a run resolves `"partial"` — never for a fully-succeeded
   * or fully-declined run.
   */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/** The dependencies each per-operation dispatch function needs. */
interface DispatchDeps {
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly s3: Parameters<typeof AWS.listObjects>[0];
}

/** Narrows the full pipeline `Deps` down to what a dispatch function needs. */
function toDispatchDeps(deps: Deps): DispatchDeps {
  return { paths: deps.paths, logger: deps.logger, s3: deps.s3 };
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
  return {
    processed: result.deleted,
    failed: result.errors.length,
    errors: result.errors,
  };
}

/**
 * Adapts a `dispatch*` step function's own parameter shape (`settings`,
 * `DispatchDeps`) to `Core.M3LOperationHandlers`'s fixed handler signature
 * (`operation`, `settings`, `context`, `deps`), for the four operations whose
 * dispatch doesn't need the `operation` argument itself. `handleDescribeOrGet`
 * stays a standalone named function below since it does need it (routing
 * `"describe"`/`"get"` through to `dispatchDescribeOrGet`'s own `operation`
 * parameter). The `"delete-batch"` handler-table key — not camelCase — reads
 * as a plain object-literal property referencing a `CallExpression` result
 * rather than an object-literal method, so the workspace's `naming-convention`
 * ESLint rule doesn't flag it either way.
 */
function adaptHandler(
  dispatch: (
    settings: RunSettings,
    deps: DispatchDeps,
  ) => Promise<RunS3ObjectsSummary>,
) {
  return (
    _operation: S3ObjectsOperation,
    settings: RunSettings,
    _context: undefined,
    deps: Deps,
  ): Promise<RunS3ObjectsSummary> => dispatch(settings, toDispatchDeps(deps));
}

async function handleDescribeOrGet(
  operation: "describe" | "get",
  settings: RunSettings,
  _context: undefined,
  deps: Deps,
): Promise<RunS3ObjectsSummary> {
  return dispatchDescribeOrGet(operation, settings, toDispatchDeps(deps));
}

/**
 * The `s3-objects` pipeline: resolve + guard-check config -&gt; (the
 * destructive-operation gate, for `put`/`copy`/`delete`/`delete-batch`) -&gt;
 * the operation-appropriate step -&gt; the run summary, all owned by
 * `Core.M3LOperationPipeline`. Built once at module load — a pipeline
 * instance is stateless across `run()` calls.
 *
 * An operator declining the destructive-operation gate (surfacing as
 * `ERR_S3_OBJECTS_ABORTED`) soft-lands: the engine logs a warning and
 * resolves an all-zero summary rather than throwing, without dispatching or
 * running `finalize`. Any other gate failure propagates unmodified. This
 * mirrors `dynamodb-crud`'s `ERR_DYNAMO_CRUD_ABORTED` handling, not
 * `sqs-etl`'s.
 */
const pipeline = new Core.M3LOperationPipeline<
  S3ObjectsOperation,
  RunSettings,
  Deps,
  RunS3ObjectsSummary
>({
  operations: S3_OBJECTS_OPERATIONS,
  configCode: "ERR_S3_OBJECTS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  destructive: {
    operations: new Set(["put", "copy", "delete", "delete-batch"] as const),
    describe: (_operation, settings) => describeDestructiveOp(settings),
    yes: (settings) => settings.yes,
    abortCode: "ERR_S3_OBJECTS_ABORTED",
    onDecline: {
      kind: "soft-land",
      result: () => ({ processed: 0, failed: 0 }),
      warning: (operation, settings, deps) =>
        `s3-objects run ${deps.correlationId} aborted before '${operation}' on bucket '${settings.bucket}'`,
    },
  },
  handlers: {
    list: adaptHandler(dispatchList),
    describe: handleDescribeOrGet,
    get: handleDescribeOrGet,
    put: adaptHandler(dispatchPutObject),
    copy: adaptHandler(dispatchCopyObject),
    delete: adaptHandler(dispatchDeleteObject),
    "delete-batch": adaptHandler(dispatchDeleteBatch),
  },
  finalize: (result, _settings, deps) => {
    deps.logger.step(`s3-objects run ${deps.correlationId} complete`, {
      processed: result.processed,
      failed: result.failed,
    });
  },
  recovery: (result) =>
    (result.errors ?? []).map((error) => ({
      item: error.key,
      error: [{ name: "M3LError", message: error.message }],
      recordedAt: new Date().toISOString(),
    })),
});

/**
 * Composes the `s3-objects` pipeline end to end via
 * `Core.M3LOperationPipeline`, preserving the legacy `RunS3ObjectsSummary`
 * return shape regardless of whether the run completed, soft-landed on a
 * declined destructive-operation gate, or left some `delete-batch` keys
 * failed. A `delete-batch` run leaving `failed > 0` never throws: each
 * absorbed per-key failure is reported once via `deps.reportRecovery` (the
 * pipeline's `"partial"` outcome) and the run still resolves the summary.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, the provisioned `s3` client, `script.prompt`, and `reportRecovery`.
 * @returns The run summary: objects/keys processed and failed.
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_CONFIG` when a required
 *   parameter is missing/malformed for the requested operation.
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
 *   reportRecovery: (entry) => console.warn(entry.item, entry.error),
 * });
 * console.log(summary.processed, summary.failed);
 * ```
 */
export async function runS3Objects(deps: Deps): Promise<RunS3ObjectsSummary> {
  const outcome = await pipeline.run(deps);
  if (outcome.status === "partial") {
    for (const entry of outcome.recovery) {
      deps.reportRecovery(entry);
    }
  }
  return { processed: outcome.result.processed, failed: outcome.result.failed };
}
