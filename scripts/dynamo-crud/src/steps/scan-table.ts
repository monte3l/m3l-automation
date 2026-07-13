import { readFile, rm, writeFile } from "node:fs/promises";

import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * Persisted resume state for a `scan-table` run: one cursor entry per
 * segment index (as a string key). A segment's cursor is the last
 * `lastEvaluatedKey` seen, or `null` once that segment has fully drained.
 */
export interface ScanCheckpoint {
  readonly segments: Record<string, Record<string, unknown> | null>;
}

/** Injected dependencies and resolved config for {@link scanTable}. */
export interface ScanTableOptions {
  /** A provisioned `dynamoDBDocument` client. */
  readonly dynamoDBDocument: Parameters<typeof AWS.scanSegment>[0];
  /** `"scan"` drives `AWS.scanSegment`; `"query"` drives `AWS.queryItems`. */
  readonly mode: "scan" | "query";
  /** Target table. */
  readonly tableName: string;
  /** Parallel segment/worker count (scan mode); `1` is unsegmented. */
  readonly totalSegments: number;
  /** Page size passed through to `AWS.scanSegment`/`queryItems`. */
  readonly pageSize: number;
  /** Optional GSI/LSI name (query mode only). */
  readonly indexName: string | undefined;
  /** Equality key condition (query mode only; required when `mode` is `"query"`). */
  readonly keyCondition: Record<string, unknown> | undefined;
  /** Write a checkpoint every this many pages, per segment. */
  readonly checkpointEveryPages: number;
  /** Resume from a previously written checkpoint at `checkpointPath`. */
  readonly resume: boolean;
  /** The checkpoint file's path. */
  readonly checkpointPath: string;
  /** Logger for diagnostics. */
  readonly logger: Core.M3LLogger;
}

/**
 * Loads and parses the checkpoint file for a `resume: true` run.
 *
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when the
 *   checkpoint file does not exist — `resume: true` with no checkpoint is a
 *   config error, not a silent fresh start.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CHECKPOINT` on any
 *   other read failure.
 */
async function loadCheckpoint(
  checkpointPath: string,
): Promise<ScanCheckpoint["segments"]> {
  try {
    const raw = await readFile(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as ScanCheckpoint;
    return parsed.segments;
  } catch (cause) {
    if (Core.isEnoentError(cause)) {
      throw new Core.M3LError(
        `scanTable: --resume set but checkpoint file '${checkpointPath}' does not exist`,
        { code: "ERR_DYNAMO_CRUD_CONFIG", cause },
      );
    }
    throw new Core.M3LError(
      `scanTable: failed reading checkpoint file '${checkpointPath}'`,
      { code: "ERR_DYNAMO_CRUD_CHECKPOINT", cause },
    );
  }
}

/**
 * Persists the full checkpoint snapshot (every segment's current state),
 * overwriting any prior contents.
 *
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CHECKPOINT` when
 *   the write fails, chaining the original cause.
 */
async function saveCheckpoint(
  checkpointPath: string,
  segments: ScanCheckpoint["segments"],
): Promise<void> {
  try {
    await writeFile(checkpointPath, JSON.stringify({ segments }));
  } catch (cause) {
    throw new Core.M3LError(
      `scanTable: failed writing checkpoint file '${checkpointPath}'`,
      { code: "ERR_DYNAMO_CRUD_CHECKPOINT", cause },
    );
  }
}

/**
 * Deletes the checkpoint file once every segment has fully drained. A
 * missing file (already deleted, or never written because the run never
 * hit a checkpoint boundary) is not an error.
 *
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CHECKPOINT` on any
 *   failure other than the file already being absent.
 */
async function deleteCheckpoint(checkpointPath: string): Promise<void> {
  try {
    await rm(checkpointPath);
  } catch (cause) {
    if (Core.isEnoentError(cause)) return;
    throw new Core.M3LError(
      `scanTable: failed deleting checkpoint file '${checkpointPath}'`,
      { code: "ERR_DYNAMO_CRUD_CHECKPOINT", cause },
    );
  }
}

/**
 * Shared, mutable checkpoint state for one `scanTable` run: one cursor entry
 * per segment index. Every concurrently-driven segment (see `mergeAsync`)
 * shares one instance, so a checkpoint write always captures the latest
 * state of every segment, not just the one that triggered it. Mutation is
 * encapsulated behind {@link SegmentCheckpointState.set} rather than exposing
 * the backing map directly, since `driveSegment` takes this state as a
 * parameter and mutating a parameter's property directly is disallowed.
 */
class SegmentCheckpointState {
  readonly #segments: Record<string, Record<string, unknown> | null>;

  constructor(initial: Record<string, Record<string, unknown> | null>) {
    this.#segments = initial;
  }

  /** The cursor recorded for `index`, or `undefined` if never recorded. */
  get(index: number): Record<string, unknown> | null | undefined {
    return this.#segments[String(index)];
  }

  /** Records `index`'s current cursor (or `null` once it has fully drained). */
  set(index: number, cursor: Record<string, unknown> | null): void {
    this.#segments[String(index)] = cursor;
  }

  /** A snapshot of every segment's current state, ready for `JSON.stringify`. */
  snapshot(): Record<string, Record<string, unknown> | null> {
    return { ...this.#segments };
  }
}

/**
 * Narrows `keyCondition` for query mode. `scanTable` already validates this
 * once, before any segment is driven, so reaching `undefined` here would be
 * an internal wiring bug — this check is defensive, not a documented path.
 */
function requireKeyCondition(
  keyCondition: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (keyCondition === undefined) {
    throw new Core.M3LError(
      "scanTable: 'keyCondition' is required when mode is 'query'",
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }
  return keyCondition;
}

/**
 * Builds the mode-appropriate page-yielding async generator for one
 * segment: `AWS.queryItems` for `"query"`, `AWS.scanSegment` for `"scan"`
 * (fanning segments out via `parallel` only when `totalSegments > 1`).
 */
function buildPages(
  opts: ScanTableOptions,
  segmentIndex: number,
  startCursor: Record<string, unknown> | undefined,
): AsyncGenerator<AWS.DynamoDBPage> {
  if (opts.mode === "query") {
    return AWS.queryItems(
      opts.dynamoDBDocument,
      {
        tableName: opts.tableName,
        keyCondition: requireKeyCondition(opts.keyCondition),
        pageSize: opts.pageSize,
        ...(opts.indexName !== undefined ? { indexName: opts.indexName } : {}),
      },
      startCursor,
    );
  }
  return AWS.scanSegment(
    opts.dynamoDBDocument,
    {
      tableName: opts.tableName,
      pageSize: opts.pageSize,
      ...(opts.totalSegments > 1
        ? {
            parallel: {
              segment: segmentIndex,
              totalSegments: opts.totalSegments,
            },
          }
        : {}),
    },
    startCursor,
  );
}

/**
 * Drives one segment's page loop: yields every item, updates the shared
 * checkpoint `state` after each page, and persists a snapshot every
 * `checkpointEveryPages` pages. An `AWS.scanSegment`/`queryItems` failure
 * propagates unmodified through this generator.
 */
async function* driveSegment(
  opts: ScanTableOptions,
  segmentIndex: number,
  startCursor: Record<string, unknown> | undefined,
  state: SegmentCheckpointState,
): AsyncGenerator<Record<string, unknown>> {
  let pageCount = 0;

  for await (const page of buildPages(opts, segmentIndex, startCursor)) {
    pageCount += 1;
    // Yield this page's items to the consumer BEFORE advancing the
    // checkpoint cursor past it. The consumer (streamToExporter) awaits
    // each item's write before pulling the next, so by the time this
    // generator resumes past `yield*`, every item in this page is already
    // durably written — advancing the checkpoint any earlier would let a
    // crash between the checkpoint write and the consumer draining this
    // page silently lose those items on --resume (they'd never be
    // re-fetched, since the resumed cursor starts after this page).
    yield* page.items;
    state.set(segmentIndex, page.lastEvaluatedKey ?? null);
    if (pageCount % opts.checkpointEveryPages === 0) {
      await saveCheckpoint(opts.checkpointPath, state.snapshot());
      opts.logger.step(
        `scanTable: checkpoint written for '${opts.tableName}' (segment ${String(segmentIndex)}, ${String(pageCount)} pages)`,
        { checkpointPath: opts.checkpointPath, segmentIndex, pageCount },
      );
    }
  }
}

/**
 * Fans in every active segment's item stream into a single ordered-by-arrival
 * stream, driving each segment's `.next()` concurrently (bounded only by how
 * many segments are active) via a simple `Promise.race` scheduler.
 *
 * A segment's next `.next()` call is only issued **after** this generator
 * resumes from yielding that segment's previous value — i.e., only once the
 * downstream consumer has finished with it and asked for another. Eagerly
 * prefetching a segment's next value immediately after producing the current
 * one (rather than after the consumer resumes this generator) would let
 * `driveSegment` race ahead past its own post-yield checkpoint update before
 * the consumer has even received, let alone durably written, the value the
 * checkpoint is about to advance past — silently defeating the no-data-loss
 * ordering `driveSegment` otherwise guarantees.
 */
async function* mergeAsync(
  sources: ReadonlyMap<number, AsyncGenerator<Record<string, unknown>>>,
): AsyncGenerator<Record<string, unknown>> {
  const pending = new Map<
    number,
    Promise<{
      readonly index: number;
      readonly result: IteratorResult<Record<string, unknown>>;
    }>
  >();
  for (const [index, source] of sources) {
    pending.set(
      index,
      source.next().then((result) => ({ index, result })),
    );
  }

  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    pending.delete(index);
    if (result.done === true) {
      continue;
    }
    yield result.value;
    // Only issued once this generator resumes from the yield above — i.e.,
    // once the consumer has finished with `result.value` and asked for more.
    const source = sources.get(index);
    if (source === undefined) {
      throw new Core.M3LError(
        "scanTable: internal error — missing segment source for merge",
        { code: "ERR_DYNAMO_CRUD_CHECKPOINT" },
      );
    }
    pending.set(
      index,
      source.next().then((r) => ({ index, result: r })),
    );
  }
}

/**
 * Streams every item from a full-table scan or an equality-key query,
 * fanning out `totalSegments` parallel segment workers (scan mode) and
 * checkpointing each segment's cursor every `checkpointEveryPages` pages so a
 * killed run can `resume`.
 *
 * `resume: true` loads `checkpointPath`: a segment recorded as `null` is
 * already fully drained and is skipped (no further AWS call for it); a
 * segment recorded with a cursor object resumes from it. The checkpoint file
 * is deleted once every segment has fully drained.
 *
 * @param opts - Mode, table, segmentation, and checkpoint settings.
 * @returns An async generator yielding one plain record at a time.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when
 *   `mode` is `"query"` and `keyCondition` is missing, or when `resume` is
 *   `true` and the checkpoint file does not exist — both checked before any
 *   AWS call.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CHECKPOINT` on an
 *   unexpected checkpoint read/write/delete failure.
 * @throws An `AWS.M3LDynamoDBOperationError` from the underlying
 *   `scanSegment`/`queryItems` call propagates unmodified.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { scanTable } from "./scan-table.js";
 *
 * for await (const item of scanTable({
 *   dynamoDBDocument: script.aws.clients.dynamoDBDocument,
 *   mode: "scan",
 *   tableName: "orders",
 *   totalSegments: 4,
 *   pageSize: 100,
 *   indexName: undefined,
 *   keyCondition: undefined,
 *   checkpointEveryPages: 25,
 *   resume: false,
 *   checkpointPath: "./data/outputs/run-1.checkpoint.json",
 *   logger: new Core.M3LLogger([]),
 * })) {
 *   // ...
 * }
 * ```
 */
export async function* scanTable(
  opts: ScanTableOptions,
): AsyncGenerator<Record<string, unknown>> {
  if (opts.mode === "query" && opts.keyCondition === undefined) {
    throw new Core.M3LError(
      "scanTable: 'keyCondition' is required when mode is 'query'",
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }

  opts.logger.step(
    `scanTable: starting '${opts.mode}' on '${opts.tableName}' (${String(opts.totalSegments)} segment(s)${opts.resume ? ", resuming" : ""})`,
    {
      mode: opts.mode,
      tableName: opts.tableName,
      totalSegments: opts.totalSegments,
      resume: opts.resume,
    },
  );

  const state = new SegmentCheckpointState(
    opts.resume ? await loadCheckpoint(opts.checkpointPath) : {},
  );

  const activeSegments = new Map<
    number,
    AsyncGenerator<Record<string, unknown>>
  >();
  for (let index = 0; index < opts.totalSegments; index += 1) {
    const existing = state.get(index);
    // Already fully drained by a prior/resumed run — nothing left to drive.
    // (When `opts.resume` is false, `state` starts empty, so `existing` is
    // always `undefined` here and this branch never triggers.)
    if (existing === null) continue;
    activeSegments.set(index, driveSegment(opts, index, existing, state));
  }

  yield* mergeAsync(activeSegments);

  await deleteCheckpoint(opts.checkpointPath);
  opts.logger.step(
    `scanTable: complete on '${opts.tableName}' — checkpoint cleared`,
    { tableName: opts.tableName },
  );
}
