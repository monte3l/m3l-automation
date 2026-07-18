import { readFile, writeFile } from "node:fs/promises";

import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * `describe`/`get`/`put`/`copy`/`delete`: one call each via
 * `AWS.headObject`/`getObject`/`putObject`/`copyObject`/`deleteObject`.
 * `put`/`copy`/`delete` are destructive — the orchestrator (`run-s3-objects`)
 * decides whether to route them through the destructive gate; this step
 * never gates itself and performs no cross-parameter validation (that is
 * `run-s3-objects`'s job per the contract's "Configuration schema" section).
 *
 * Reads/writes raw file bytes directly via `node:fs/promises`
 * `readFile`/`writeFile` — not the `Core` importer/exporter classes, which
 * are JSONL/CSV-row-shaped and don't fit a single JSON document or raw byte
 * body.
 */

/** The single-object operations this step dispatches. */
type SingleObjectOperation = "describe" | "get" | "put" | "copy" | "delete";

/** The run summary `runSingleObjectOp` reports: always one processed unit. */
export interface RunSingleObjectOpSummary {
  /** Always `1` — a single-object operation processes exactly one object. */
  readonly processed: number;
}

/** Throws a defensive config error for a field the orchestrator should have already guarded. */
function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: "ERR_S3_OBJECTS_CONFIG",
    });
  }
  return value;
}

/**
 * Fetches an object's metadata (`AWS.headObject`) and writes it (or `null`
 * when the object doesn't exist) as JSON to `outputPath`. A missing object is
 * logged as a warning but still counts as processed — a `describe` that
 * confirms absence is not a failure.
 */
async function runDescribe(
  client: Parameters<typeof AWS.headObject>[0],
  bucket: string,
  key: string,
  outputPath: string,
  logger: Core.M3LLogger,
): Promise<void> {
  const metadata = await AWS.headObject(client, bucket, key);
  if (metadata === undefined) {
    logger.warning(`describe: no object found at '${bucket}/${key}'`);
  }
  try {
    await writeFile(outputPath, JSON.stringify(metadata ?? null));
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed writing '${outputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }
}

/**
 * Downloads an object's full body (`AWS.getObject`) and writes the raw bytes
 * verbatim (never JSON-stringified) to `outputPath`. No soft not-found path —
 * a rejection from `AWS.getObject` propagates unmodified.
 */
async function runGet(
  client: Parameters<typeof AWS.getObject>[0],
  bucket: string,
  key: string,
  outputPath: string,
): Promise<void> {
  const { body } = await AWS.getObject(client, bucket, key);
  try {
    await writeFile(outputPath, body);
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed writing '${outputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }
}

/** Reads `inputPath`'s raw bytes and writes them as the object body (`AWS.putObject`). */
async function runPut(
  client: Parameters<typeof AWS.putObject>[0],
  bucket: string,
  key: string,
  inputPath: string,
  contentType: string | undefined,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(inputPath);
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading '${inputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }
  await AWS.putObject(client, bucket, key, body, {
    ...(contentType !== undefined && { contentType }),
  });
}

/** Copies an object from `sourceBucket`/`sourceKey` into `bucket`/`key` (`AWS.copyObject`). */
async function runCopy(
  client: Parameters<typeof AWS.copyObject>[0],
  bucket: string,
  key: string,
  sourceBucket: string,
  sourceKey: string,
): Promise<void> {
  await AWS.copyObject(client, bucket, key, {
    bucket: sourceBucket,
    key: sourceKey,
  });
}

/** The injected dependencies `runSingleObjectOp` and its per-operation dispatchers share. */
interface SingleObjectOpDeps {
  readonly client: Parameters<typeof AWS.headObject>[0];
  readonly operation: SingleObjectOperation;
  readonly bucket: string;
  readonly key?: string;
  readonly outputPath?: string;
  readonly inputPath?: string;
  readonly contentType?: string;
  readonly sourceBucket?: string;
  readonly sourceKey?: string;
  readonly logger: Core.M3LLogger;
}

/** `describe`: dispatches to {@link runDescribe} with the fields it needs. */
async function dispatchDescribe(deps: SingleObjectOpDeps): Promise<void> {
  await runDescribe(
    deps.client,
    deps.bucket,
    requireField(deps.key, "key"),
    requireField(deps.outputPath, "output"),
    deps.logger,
  );
}

/** `get`: dispatches to {@link runGet} with the fields it needs. */
async function dispatchGet(deps: SingleObjectOpDeps): Promise<void> {
  await runGet(
    deps.client,
    deps.bucket,
    requireField(deps.key, "key"),
    requireField(deps.outputPath, "output"),
  );
}

/** `put`: dispatches to {@link runPut} with the fields it needs. */
async function dispatchPut(deps: SingleObjectOpDeps): Promise<void> {
  await runPut(
    deps.client,
    deps.bucket,
    requireField(deps.key, "key"),
    requireField(deps.inputPath, "input"),
    deps.contentType,
  );
}

/** `copy`: dispatches to {@link runCopy} with the fields it needs. */
async function dispatchCopy(deps: SingleObjectOpDeps): Promise<void> {
  await runCopy(
    deps.client,
    deps.bucket,
    requireField(deps.key, "key"),
    requireField(deps.sourceBucket, "sourceBucket"),
    requireField(deps.sourceKey, "sourceKey"),
  );
}

/** `delete`: dispatches directly to `AWS.deleteObject` with the fields it needs. */
async function dispatchDelete(deps: SingleObjectOpDeps): Promise<void> {
  await AWS.deleteObject(
    deps.client,
    deps.bucket,
    requireField(deps.key, "key"),
  );
}

/**
 * Dispatches one of `describe`/`get`/`put`/`copy`/`delete` against a single
 * S3 object.
 *
 * @param deps - Injected dependencies: the provisioned `s3` client, the
 *   operation, the target bucket, and the per-operation fields that
 *   operation needs (`key`, `outputPath`, `inputPath`, `contentType`,
 *   `sourceBucket`, `sourceKey`), plus a logger.
 * @returns The run summary — always `{ processed: 1 }`.
 * @throws {@link AWS.M3LS3OperationError} when the underlying AWS call
 *   rejects (propagated unmodified).
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_CONFIG` when a field
 *   the selected operation requires is missing (defensive — `run-s3-objects`
 *   is expected to have already guard-checked this before calling in).
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_OUTPUT` when a local
 *   filesystem read/write fails — writing `outputPath` for `describe`/`get`,
 *   or reading `inputPath` for `put`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runSingleObjectOp } from "./single-object-ops.js";
 *
 * const summary = await runSingleObjectOp({
 *   client: script.aws?.clients.s3,
 *   operation: "delete",
 *   bucket: "reports",
 *   key: "2026/07/summary.json",
 *   logger: new Core.M3LLogger([]),
 * });
 * console.log(summary.processed);
 * ```
 */
export async function runSingleObjectOp(
  deps: SingleObjectOpDeps,
): Promise<RunSingleObjectOpSummary> {
  switch (deps.operation) {
    case "describe":
      await dispatchDescribe(deps);
      break;
    case "get":
      await dispatchGet(deps);
      break;
    case "put":
      await dispatchPut(deps);
      break;
    case "copy":
      await dispatchCopy(deps);
      break;
    case "delete":
      await dispatchDelete(deps);
      break;
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_S3_OBJECTS_CONFIG",
      });
    }
  }

  return { processed: 1 };
}
