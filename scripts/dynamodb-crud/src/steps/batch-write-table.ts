import { AWS, Core } from "@m3l-automation/m3l-common";

/** DynamoDB's own `BatchWriteItem` cap — the maximum items per request. */
const BATCH_CHUNK_SIZE = 25;

/** The result of {@link batchWriteTable}. */
export interface BatchWriteTableResult {
  /** Total items DynamoDB actually confirmed written/deleted. */
  readonly written: number;
  /** Items still unprocessed once the retry runner's own attempts are exhausted. */
  readonly failed: readonly Record<string, unknown>[];
}

/**
 * The `M3LError.code` {@link DynamoBatchUnprocessedSignal} carries. Exported
 * so the caller composing the production `Core.M3LRetryRunner` (see
 * `run-dynamodb-crud.ts`) can recognize this sentinel by code and classify it
 * `"retriable"`, without importing the (deliberately unexported) sentinel
 * class itself.
 */
export const BATCH_RETRY_ERROR_CODE = "ERR_DYNAMO_CRUD_BATCH_RETRY";

/**
 * Internal sentinel: thrown from inside a `Core.M3LRetryRunner.run` op body
 * when a `batchWriteItems`/`batchDeleteItems` call returns a non-empty
 * `unprocessed` result, converting that benign "some items unprocessed"
 * outcome into a retriable signal the runner will loop on. Never surfaces
 * past {@link processChunk} — the runner's own re-throw on exhaustion is
 * caught locally there and folded into `BatchWriteTableResult.failed`.
 */
class DynamoBatchUnprocessedSignal extends Core.M3LError {
  constructor() {
    super("dynamo batch chunk has unprocessed items after this attempt", {
      code: BATCH_RETRY_ERROR_CODE,
    });
  }
}

/** Groups `records` into arrays of at most `size` items, streaming (never buffering the whole source). */
async function* chunksOf<T>(
  records: AsyncIterable<T>,
  size: number,
): AsyncGenerator<T[]> {
  let buffer: T[] = [];
  for await (const record of records) {
    buffer.push(record);
    if (buffer.length === size) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer;
}

/**
 * Dispatches one chunk to `AWS.batchWriteItems` (mode `"write"`) or
 * `AWS.batchDeleteItems` (mode `"delete"`), normalizing both responses'
 * differently-named confirmed-count field to a single `confirmed` count.
 */
async function callBatch(opts: {
  readonly dynamoDBDocument: Parameters<typeof AWS.batchWriteItems>[0];
  readonly mode: "write" | "delete";
  readonly tableName: string;
  readonly items: readonly Record<string, unknown>[];
}): Promise<{
  readonly confirmed: number;
  readonly unprocessed: readonly Record<string, unknown>[];
}> {
  if (opts.mode === "write") {
    const response = await AWS.batchWriteItems(
      opts.dynamoDBDocument,
      opts.tableName,
      opts.items,
    );
    return { confirmed: response.written, unprocessed: response.unprocessed };
  }
  const response = await AWS.batchDeleteItems(
    opts.dynamoDBDocument,
    opts.tableName,
    opts.items,
  );
  return { confirmed: response.deleted, unprocessed: response.unprocessed };
}

/**
 * Processes one chunk (at most 25 items) through `opts.retryRunner`: each
 * attempt calls the mode-appropriate batch operation against whatever subset
 * is still outstanding, accumulating confirmed writes across attempts. A
 * non-empty `unprocessed` result throws {@link DynamoBatchUnprocessedSignal}
 * so the runner retries only that subset; once the runner's own attempts are
 * exhausted, the last-seen unprocessed subset becomes `failed`. A hard
 * failure (anything other than the sentinel) propagates unchanged.
 */
async function processChunk(opts: {
  readonly dynamoDBDocument: Parameters<typeof AWS.batchWriteItems>[0];
  readonly mode: "write" | "delete";
  readonly tableName: string;
  readonly retryRunner: Core.M3LRetryRunner;
  readonly chunk: readonly Record<string, unknown>[];
}): Promise<BatchWriteTableResult> {
  let written = 0;
  let remaining = opts.chunk;

  try {
    await opts.retryRunner.run(async () => {
      const { confirmed, unprocessed } = await callBatch({
        dynamoDBDocument: opts.dynamoDBDocument,
        mode: opts.mode,
        tableName: opts.tableName,
        items: remaining,
      });
      written += confirmed;
      if (unprocessed.length > 0) {
        remaining = unprocessed;
        throw new DynamoBatchUnprocessedSignal();
      }
    });
    return { written, failed: [] };
  } catch (cause) {
    if (cause instanceof DynamoBatchUnprocessedSignal) {
      return { written, failed: remaining };
    }
    throw cause;
  }
}

/**
 * Drives `chunks` through `worker`, bounding concurrent in-flight chunks to
 * `limit` via a `Promise.race`-based scheduler. A hard failure from any
 * chunk (i.e. `worker` rejects) stops launching new chunks and, once every
 * already-in-flight chunk has settled, rejects with that first error. When
 * two or more chunks fail concurrently (both already in flight before the
 * first failure stops new launches), only the first error is ever rethrown —
 * every subsequent one is logged via `logger.warning` so it isn't silently
 * dropped, even though it can't also propagate.
 */
async function processAllChunks(
  chunks: AsyncGenerator<Record<string, unknown>[]>,
  limit: number,
  worker: (chunk: Record<string, unknown>[]) => Promise<BatchWriteTableResult>,
  logger: Core.M3LLogger,
): Promise<BatchWriteTableResult> {
  let written = 0;
  const failed: Record<string, unknown>[] = [];
  let firstError: unknown;
  let nextId = 0;
  const inFlight = new Map<number, Promise<void>>();

  const runOne = async (chunk: Record<string, unknown>[]): Promise<void> => {
    try {
      const result = await worker(chunk);
      written += result.written;
      failed.push(...result.failed);
    } catch (error: unknown) {
      if (firstError !== undefined) {
        logger.warning(
          "batch chunk failed after an earlier chunk had already failed — only the first error propagates, this one is logged instead of silently dropped",
          { cause: error },
        );
      }
      firstError ??= error;
    }
  };

  for await (const chunk of chunks) {
    if (firstError !== undefined) break;
    while (inFlight.size >= limit) {
      await Promise.race(inFlight.values());
    }
    const id = nextId;
    nextId += 1;
    const task = runOne(chunk).finally(() => {
      inFlight.delete(id);
    });
    inFlight.set(id, task);
  }

  await Promise.all(inFlight.values());

  if (firstError !== undefined) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows the original caught value verbatim; its provenance is `unknown` (any value can be thrown in JS) and this preserves identity rather than wrapping it
    throw firstError;
  }

  return { written, failed };
}

/**
 * Streams `opts.records`, chunking into groups of at most 25 (DynamoDB's
 * `BatchWriteItem` cap), dispatching each chunk to `AWS.batchWriteItems`
 * (`mode: "write"`) or `AWS.batchDeleteItems` (`mode: "delete"`), and
 * retrying only a chunk's still-`unprocessed` subset through the injected
 * `retryRunner` — bounded to `maxInFlightBatches` concurrent chunks.
 *
 * Reading the input file and writing any `failed.jsonl` sink are out of
 * scope here — the caller (`run-dynamodb-crud`) owns both; this step only
 * takes an already-parsed `AsyncIterable<Record<string, unknown>>`.
 *
 * @param opts - The provisioned document client, write/delete mode, target
 *   table, the record stream, the concurrency bound, and the retry runner.
 * @returns `{ written, failed }`: `written` counts only DynamoDB-confirmed
 *   writes/deletes; `failed` holds whatever is still unprocessed once the
 *   retry runner itself gives up.
 * @throws A hard (non-"unprocessed") failure from the underlying AWS call
 *   propagates out unchanged, rather than being folded into `failed`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { batchWriteTable } from "./batch-write-table.js";
 *
 * async function* records(): AsyncGenerator<Record<string, unknown>> {
 *   yield { id: "1" };
 * }
 *
 * const result = await batchWriteTable({
 *   dynamoDBDocument: script.aws.clients.dynamoDBDocument,
 *   mode: "write",
 *   tableName: "orders",
 *   records: records(),
 *   maxInFlightBatches: 4,
 *   retryRunner: new Core.M3LRetryRunner({
 *     classifier: Core.awsThrottlingClassifier,
 *   }),
 *   logger: new Core.M3LLogger([]),
 * });
 * ```
 */
export async function batchWriteTable(opts: {
  readonly dynamoDBDocument: Parameters<typeof AWS.batchWriteItems>[0];
  readonly mode: "write" | "delete";
  readonly tableName: string;
  readonly records: AsyncIterable<Record<string, unknown>>;
  readonly maxInFlightBatches: number;
  readonly retryRunner: Core.M3LRetryRunner;
  readonly logger: Core.M3LLogger;
}): Promise<BatchWriteTableResult> {
  const chunks = chunksOf(opts.records, BATCH_CHUNK_SIZE);
  const result = await processAllChunks(
    chunks,
    opts.maxInFlightBatches,
    (chunk) =>
      processChunk({
        dynamoDBDocument: opts.dynamoDBDocument,
        mode: opts.mode,
        tableName: opts.tableName,
        retryRunner: opts.retryRunner,
        chunk,
      }),
    opts.logger,
  );

  if (result.failed.length > 0) {
    opts.logger.warning(
      `batch ${opts.mode} left ${String(result.failed.length)} item(s) unprocessed on table '${opts.tableName}' after retry`,
    );
  }

  return result;
}
