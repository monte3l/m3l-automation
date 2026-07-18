import { readFile } from "node:fs/promises";

import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * `delete-batch`: reads keys from `input` (JSONL `{key}` records) via
 * `Core.M3LJSONListImporter`, chunks into ≤1000-key groups (S3's own
 * `DeleteObjects` cap — `AWS.deleteObjects` throws if that cap is exceeded),
 * calls `AWS.deleteObjects` per chunk, aggregates `deleted`/`errors` across
 * every chunk, and writes the aggregated failures **once** (overwrite, not
 * incremental `fs.appendFile`) to `failedOutputPath` — mirrors
 * `dynamodb-crud`'s `writeFailedRecords`. `failed.jsonl` is written only when
 * `errors.length > 0`, so a clean batch never touches the failure sink at
 * all.
 *
 * `inputPath`'s bytes are read once via `node:fs/promises` `readFile` and
 * handed to `Core.M3LJSONListImporter` as an in-memory `Buffer` source
 * (rather than letting the importer resolve the file path itself): a
 * string-path source routes through `M3LJSONFormatDetector`, which opens the
 * file a second time via `node:fs/promises` `open` for format sampling — a
 * separate read primitive from `readFile`. Handing over an already-read
 * `Buffer` keeps this step's only file-read primitive `readFile`.
 */

/** S3's own `DeleteObjects` cap — the maximum number of keys a single `AWS.deleteObjects` call may carry. */
const DELETE_OBJECTS_KEY_CAP = 1000;

/**
 * `Core.M3LJSONListImporter`'s internal (deliberately unexported) error code
 * for "the source has no detectable JSON/JSONL shape" — recognized here by
 * its `.code` string rather than an import, mirroring `dynamodb-crud`'s
 * `batchSentinelClassifier` recognizing `batch-write-table`'s own unexported
 * sentinel the same way.
 */
const ERR_IMPORT_SOURCE_CODE = "ERR_IMPORT_SOURCE";

/**
 * One key record read from the `input` JSONL file. The `Core.M3LJSONListImporter<KeyRecord>`
 * generic is erased at runtime — a malformed record (`{"key":""}`,
 * `{"key":123}`, or a record missing `key` entirely) still flows through
 * `importStream` typed as `KeyRecord`, so `record.key` must be re-validated
 * at runtime (see the `unknown`-read in {@link runDeleteBatch}'s loop) rather
 * than trusted as the declared `string`.
 */
interface KeyRecord {
  readonly key: string;
}

/** The aggregated result `runDeleteBatch` reports — mirrors `AWS.DeleteObjectsResult`. */
export interface RunDeleteBatchResult {
  /** Total keys confirmed deleted across every chunk. */
  readonly deleted: number;
  /** Per-key failures aggregated across every chunk. */
  readonly errors: readonly AWS.S3DeleteError[];
}

/**
 * Deletes one chunk of at most {@link DELETE_OBJECTS_KEY_CAP} keys, wrapping
 * a non-`M3LS3OperationError` failure as a typed `Core.M3LError`.
 */
async function deleteChunk(
  client: Parameters<typeof AWS.deleteObjects>[0],
  bucket: string,
  keys: readonly string[],
): Promise<AWS.DeleteObjectsResult> {
  try {
    return await AWS.deleteObjects(client, bucket, keys);
  } catch (cause) {
    if (cause instanceof AWS.M3LS3OperationError) throw cause;
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError("delete-batch chunk failed", {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
      context: { bucket, keyCount: keys.length },
    });
  }
}

/**
 * Classifies one imported `KeyRecord`: a valid non-empty string key, or the
 * `AWS.S3DeleteError` to report when `record.key` fails runtime validation.
 * The `Core.M3LJSONListImporter<KeyRecord>` generic is erased at runtime, so
 * `record.key` is re-read as `unknown` here rather than trusted as the
 * declared `string` (see the `KeyRecord` interface's own doc).
 */
function classifyKeyRecord(
  record: KeyRecord,
): { readonly key: string } | { readonly error: AWS.S3DeleteError } {
  const key: unknown = record.key;
  if (typeof key === "string" && key.length > 0) return { key };
  return {
    error: {
      key: typeof key === "string" ? key : String(key),
      message: "invalid key record: 'key' must be a non-empty string",
    },
  };
}

/** Writes `errors` once as JSONL to `outputPath` — the `delete-batch` failure sink. */
async function writeFailed(
  outputPath: string,
  errors: readonly AWS.S3DeleteError[],
  logger: Core.M3LLogger,
): Promise<void> {
  const exporter = new Core.M3LJSONListExporter<AWS.S3DeleteError>({
    filePath: outputPath,
    format: "jsonl",
  });
  const writer = exporter.exportStream();
  let closed = false;
  try {
    for (const error of errors) {
      await writer.append(error);
    }
    await writer.close();
    closed = true;
  } catch (cause) {
    if (!closed) {
      try {
        await writer.close();
      } catch (closeError) {
        logger.warning("failed.jsonl close after failure also failed", {
          cause: closeError,
        });
      }
    }
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed writing '${outputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }
}

/**
 * Handles a chunk's `AWS.deleteObjects` call rejecting fatally (the whole
 * `DeleteObjects` request failed — throttling, a permissions change mid-run,
 * etc. — not a per-key failure, which never throws and is aggregated via
 * `deleteChunk`'s return value instead). Whatever `deleted`/`errors` state
 * accumulated from prior successful chunks in this run would otherwise be
 * silently discarded — this persists it to `failedOutputPath` before
 * surfacing the fatal error.
 */
async function handleFatalChunkFailure(
  cause: AWS.M3LS3OperationError,
  failedOutputPath: string,
  logger: Core.M3LLogger,
  deleted: number,
  errors: readonly AWS.S3DeleteError[],
): Promise<never> {
  if (errors.length > 0) {
    await writeFailed(failedOutputPath, errors, logger);
  }
  throw new Core.M3LError(
    `delete-batch aborted: a chunk's AWS.deleteObjects call failed after ${String(deleted)} key(s) already deleted`,
    {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
      context: { deleted, priorErrorCount: errors.length },
    },
  );
}

/** The dependencies both {@link collectAndDeleteKeys} and {@link runDeleteBatch} share. */
interface DeleteBatchDeps {
  readonly client: Parameters<typeof AWS.deleteObjects>[0];
  readonly bucket: string;
  readonly inputPath: string;
  readonly failedOutputPath: string;
  readonly logger: Core.M3LLogger;
}

/**
 * Reads `inputPath`'s key records and deletes every key in ≤1000-key
 * chunks, aggregating `deleted`/`errors` across every chunk. Handles the "no
 * recognizable JSON/JSONL key records" short-circuit and the fatal
 * chunk-rejection path (via {@link handleFatalChunkFailure}) — does NOT
 * write `failedOutputPath` itself on the happy/partial-failure path; the
 * caller ({@link runDeleteBatch}) does that once after this resolves, so the
 * "zero keys" short-circuit never touches the failure sink.
 */
async function collectAndDeleteKeys(
  deps: DeleteBatchDeps,
  importer: Core.M3LJSONListImporter<KeyRecord>,
): Promise<RunDeleteBatchResult> {
  let deleted = 0;
  const errors: AWS.S3DeleteError[] = [];
  let chunk: string[] = [];

  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const result = await deleteChunk(deps.client, deps.bucket, chunk);
    deleted += result.deleted;
    errors.push(...result.errors);
    chunk = [];
  };

  try {
    const bytes = await readFile(deps.inputPath);
    for await (const record of importer.importStream(bytes)) {
      const classified = classifyKeyRecord(record);
      if ("key" in classified) {
        chunk.push(classified.key);
      } else {
        errors.push(classified.error);
      }
      if (chunk.length === DELETE_OBJECTS_KEY_CAP) {
        await flush();
      }
    }
    await flush();
  } catch (cause) {
    if (cause instanceof AWS.M3LS3OperationError) {
      return handleFatalChunkFailure(
        cause,
        deps.failedOutputPath,
        deps.logger,
        deleted,
        errors,
      );
    }
    // An input with no detectable JSON/JSONL shape (including a genuinely
    // empty file) carries no key records to delete — treated the same as an
    // explicitly empty key list, not as a fatal read failure.
    if (
      cause instanceof Core.M3LError &&
      cause.code === ERR_IMPORT_SOURCE_CODE
    ) {
      deps.logger.warning(
        `delete-batch input '${deps.inputPath}' has no recognizable JSON/JSONL key records; treating as zero keys`,
        { cause },
      );
      return { deleted: 0, errors: [] };
    }
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading '${deps.inputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }

  return { deleted, errors };
}

/**
 * Reads the key list at `inputPath`, deletes every key in ≤1000-key chunks,
 * and writes the aggregated per-key failures once to `failedOutputPath`.
 *
 * @param deps - Injected dependencies: the provisioned `s3` client, the
 *   target bucket, the resolved input/failed-output file paths, and a
 *   logger.
 * @returns The aggregated result across every chunk.
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_OUTPUT` when reading
 *   `inputPath` fails, when writing `failedOutputPath` fails, or when a
 *   chunk's `AWS.deleteObjects` call itself rejects fatally (the whole
 *   `DeleteObjects` request failing, not a per-key failure) — the original
 *   {@link AWS.M3LS3OperationError} is chained as `cause`, and `context`
 *   carries `{ deleted, priorErrorCount }` so the operator can see how much
 *   progress happened before the abort; any `errors` already accumulated
 *   from prior successful chunks are still written to `failedOutputPath`
 *   before this throws.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runDeleteBatch } from "./delete-batch.js";
 *
 * const result = await runDeleteBatch({
 *   client: script.aws?.clients.s3,
 *   bucket: "reports",
 *   inputPath: "keys.jsonl",
 *   failedOutputPath: "failed.jsonl",
 *   logger: new Core.M3LLogger([]),
 * });
 * console.log(result.deleted, result.errors.length);
 * ```
 */
export async function runDeleteBatch(
  deps: DeleteBatchDeps,
): Promise<RunDeleteBatchResult> {
  const importer = new Core.M3LJSONListImporter<KeyRecord>({});
  const result = await collectAndDeleteKeys(deps, importer);
  if (result.errors.length > 0) {
    await writeFailed(deps.failedOutputPath, result.errors, deps.logger);
  }
  return result;
}
