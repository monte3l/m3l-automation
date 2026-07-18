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

/** One key record read from the `input` JSONL file. */
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
 * Reads the key list at `inputPath`, deletes every key in ≤1000-key chunks,
 * and writes the aggregated per-key failures once to `failedOutputPath`.
 *
 * @param deps - Injected dependencies: the provisioned `s3` client, the
 *   target bucket, the resolved input/failed-output file paths, and a
 *   logger.
 * @returns The aggregated result across every chunk.
 * @throws {@link AWS.M3LS3OperationError} when a chunk's `AWS.deleteObjects`
 *   call rejects (propagated unmodified).
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_OUTPUT` when reading
 *   `inputPath` or writing `failedOutputPath` fails.
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
export async function runDeleteBatch(deps: {
  readonly client: Parameters<typeof AWS.deleteObjects>[0];
  readonly bucket: string;
  readonly inputPath: string;
  readonly failedOutputPath: string;
  readonly logger: Core.M3LLogger;
}): Promise<RunDeleteBatchResult> {
  const importer = new Core.M3LJSONListImporter<KeyRecord>({});

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
      chunk.push(record.key);
      if (chunk.length === DELETE_OBJECTS_KEY_CAP) {
        await flush();
      }
    }
    await flush();
  } catch (cause) {
    if (cause instanceof AWS.M3LS3OperationError) throw cause;
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

  if (errors.length > 0) {
    await writeFailed(deps.failedOutputPath, errors, deps.logger);
  }

  return { deleted, errors };
}
