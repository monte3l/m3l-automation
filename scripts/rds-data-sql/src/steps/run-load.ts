/**
 * `steps/run-load` — bulk-inserts `input.file` into `table`, chunked to
 * `batch.size` and transactional per chunk.
 *
 * Business logic lives here — never in `main.ts`. Resolves the `INSERT`
 * column list (explicit `columns`, or inferred from the first imported
 * record's keys), coerces each record's values to `AWS.M3LRDSDataValue`,
 * rejects any record whose key set differs from the resolved columns or
 * whose values don't coerce cleanly, and inserts the rest in `batch.size`
 * chunks — each chunk in its own `withTransaction` scope, so one chunk's
 * failure never aborts the rest of the run. See
 * `docs/reference/scripts/rds-data-sql.md`'s `run-load` row and the
 * `columns`/`batch.size` config-parameter rows for the full contract.
 * `runLoad` itself never throws on a partial failure — it returns a summary
 * with a nonzero `failed` count; mapping that to a process-level failure is
 * `run-rds-data-sql`'s job.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

import { quoteIdentifier, validateIdentifier } from "../lib/identifiers.js";

/**
 * The `Core.M3LError` code {@link runLoad} throws with for an invalid
 * inferred column name — mirrors `resolve-settings.ts`'s identifier
 * validation (see `docs/reference/scripts/rds-data-sql.md`'s "Configuration
 * schema" section). `resolve-settings.ts` already validates an explicit
 * `columns` config value at config-load time; this step re-checks it
 * defensively (a caller may hand `runLoad` a `columns` list built outside
 * that path) and, more importantly, is the *only* place a column list
 * **inferred** from the first imported record's own keys is ever validated.
 */
const INVALID_COLUMN_CODE = "ERR_RDS_DATA_SQL_INVALID_COLUMN";

/**
 * The `Core.M3LError` code {@link flushChunk} throws with when recording a
 * chunk's rejected rows to `failedWriter` itself fails.
 */
const FAILED_WRITER_CODE = "ERR_RDS_DATA_SQL_FAILED_WRITER";

/**
 * The `Core.M3LError` code {@link runLoad} throws with when the rejection
 * writer's `close()` fails after the import stream otherwise consumed
 * cleanly — see {@link closeFailedWriterBestEffort}'s TSDoc for why this
 * case cannot be a best-effort log.
 */
const OUTPUT_WRITER_CODE = "ERR_RDS_DATA_SQL_OUTPUT_WRITER";

/** The resume-state shape {@link runLoad} persists via its injected `checkpoint` port. */
export interface RunLoadCheckpoint {
  /** The 0-based index of the last chunk fully attempted (inserted or recorded as failed). */
  readonly chunkIndex?: number;
  /**
   * The byte length already flushed to `failed.jsonl` by a prior
   * interrupted run — `failedWriter.bytesWritten` as of the last checkpoint
   * write. On resume, {@link runLoad} passes this to `createFailedWriter`
   * as `resumeFromByte`, so the reopened writer appends from exactly this
   * offset instead of truncating and replaying every prior rejection.
   */
  readonly failedOutputBytes?: number;
  /**
   * The total number of rows rejected to `failedWriter` so far, across
   * every resumed run — seeds {@link runLoad}'s own running failed-count on
   * resume, and is re-persisted (updated) after every chunk.
   */
  readonly failedCount?: number;
  /**
   * The total number of records READ from the import stream so far, across
   * every resumed run — both accepted (into a chunk) and rejected, unlike
   * {@link RunLoadCheckpoint.chunkIndex} (which only counts fully-attempted
   * chunks of *accepted* records). On resume, {@link runLoad} skips
   * classifying (accepting or rejecting) each of the import stream's first
   * `recordsProcessed` records — the stream is re-read from the beginning,
   * but every record already classified by a prior interrupted run must not
   * be reclassified, or a record that was already rejected gets rejected
   * (and recorded to `failedWriter`) a second time.
   */
  readonly recordsProcessed?: number;
}

/** The narrow checkpoint port {@link runLoad} depends on. */
interface RunLoadCheckpointPort {
  /** Reads the current checkpoint, or an empty object on a fresh run. */
  read(): Promise<RunLoadCheckpoint>;
  /** Persists the checkpoint after a chunk has been attempted. */
  write(
    checkpoint: RunLoadCheckpoint & { readonly chunkIndex: number },
  ): Promise<void>;
  /** Deletes the checkpoint once the run completes with no failed rows. */
  delete(): Promise<void>;
}

/** The narrow rejection-writer port {@link runLoad} appends each rejected raw record to. */
interface RunLoadFailedWriterPort {
  /** Appends one rejected raw input record to `failed.jsonl`. */
  append(record: Record<string, unknown>): Promise<void>;
  /** Closes the underlying `failed.jsonl` stream. */
  close(): Promise<void>;
  /** The total byte length flushed to `failed.jsonl` so far. */
  readonly bytesWritten: number;
}

/** Injected dependencies for {@link runLoad}. */
export interface RunLoadDeps {
  /** The provisioned RDS Data API operations wrapper, narrowed to `batchExecuteStatement`/`withTransaction`. */
  readonly rdsData: Pick<
    AWS.M3LRDSDataOperations,
    "batchExecuteStatement" | "withTransaction"
  >;
  /** The Aurora cluster/instance ARN. */
  readonly resourceArn: string;
  /** The Secrets Manager ARN holding the database credentials. */
  readonly secretArn: string;
  /** The target database name, when set. */
  readonly database?: string;
  /** The target schema qualifier, when set. */
  readonly schema?: string;
  /** The target table, already qualified/quoted (e.g. `"public"."users"`). */
  readonly table: string;
  /** An explicit `INSERT` column list; when unset, inferred from the first imported record's keys. */
  readonly columns?: readonly string[];
  /** The importer selected by `input.format`. */
  readonly importer: Core.M3LListImporter<Record<string, unknown>>;
  /** The source file path forwarded to `importer.importStream`, when set. */
  readonly source?: string;
  /** Row-chunk size for `batchExecuteStatement` calls. */
  readonly batchSize: number;
  /** The resume-state port; see {@link RunLoadCheckpointPort}. */
  readonly checkpoint: RunLoadCheckpointPort;
  /**
   * Builds the rejection-writer, deferred until its resume byte offset is
   * known: unlike `run-query`'s writer, `failed.jsonl` is always JSONL
   * (no column-bootstrap concern), so this is a much simpler seam than
   * `RunQueryDeps.createWriter` — `runLoad` calls it exactly once, at the
   * very top of the run, with `checkpoint.failedOutputBytes ?? 0`.
   */
  readonly createFailedWriter: (
    resumeFromByte: number,
  ) => RunLoadFailedWriterPort;
  /** The run's correlated logger. */
  readonly logger: Core.M3LLogger;
  /**
   * Reports one absorbed per-row (or per-chunk) rejection to the run's
   * recovery ledger, when provided — optional because `RunLoadDeps` is
   * hand-constructed directly by many existing tests that don't exercise
   * this reporting path. Called once per rejected row (never for a
   * checkpoint's carried-over `failedCount` from a prior interrupted run).
   */
  readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
}

/** The summary {@link runLoad} resolves with. */
export interface RunLoadResult {
  /** The total number of rows successfully inserted. */
  readonly inserted: number;
  /** The total number of rows/chunks rejected to `failedWriter`. */
  readonly failed: number;
}

/** One accepted, not-yet-flushed row: its raw record (for a rejection path) plus its coerced `INSERT` parameters, in column order. */
interface PendingRow {
  readonly record: Record<string, unknown>;
  readonly parameters: readonly AWS.M3LRDSDataParameter[];
}

/**
 * Fixed per-run context threaded through the load's helper functions — split
 * out so each function's own parameter count stays low. `failedWriter` is
 * built once by {@link runLoad} (from `deps.createFailedWriter`) and shared
 * by every helper that needs to record a rejection.
 */
interface LoadContext {
  readonly deps: RunLoadDeps;
  readonly failedWriter: RunLoadFailedWriterPort;
  readonly resumeFromChunkIndex: number;
}

/**
 * Validates `name` as a column identifier, delegating to
 * {@link validateIdentifier} with this step's own established
 * `INVALID_COLUMN_CODE`.
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_INVALID_COLUMN"`
 *   when `name` fails the pattern.
 */
function validateColumnName(name: string): string {
  return validateIdentifier(name, "column", INVALID_COLUMN_CODE);
}

/** Builds the chunk-shared `INSERT` statement text for `table`/`columns`. */
function buildInsertSql(table: string, columns: readonly string[]): string {
  const columnList = columns.map(quoteIdentifier).join(", ");
  const paramList = columns.map((column) => `:${column}`).join(", ");
  return `INSERT INTO ${table} (${columnList}) VALUES (${paramList})`;
}

/**
 * Coerces one raw field value to {@link AWS.M3LRDSDataValue}: `null → null`,
 * `boolean → boolean`, `string → string`, a safe integer `→ long`, any other
 * finite number `→ double`. Returns `undefined` — never throws — for a
 * non-finite number, `undefined`, an array, or a nested object; the caller
 * rejects the whole record (not just this field) to `failedWriter` rather
 * than coercing.
 */
function coerceLoadValue(value: unknown): AWS.M3LRDSDataValue | undefined {
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isSafeInteger(value)
      ? { kind: "long", value }
      : { kind: "double", value };
  }
  return undefined;
}

/** Reads `key` off `record`, guarding against a non-own (e.g. prototype-chain) hit on untrusted input. */
function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether `record`'s own key set is exactly `columns` (order-independent). */
function keysMatchColumns(
  record: Record<string, unknown>,
  columns: readonly string[],
): boolean {
  const recordKeys = Object.keys(record);
  if (recordKeys.length !== columns.length) return false;
  const columnSet = new Set(columns);
  return recordKeys.every((key) => columnSet.has(key));
}

/**
 * Attempts to coerce every column's value out of `record`, in column order,
 * building the named `M3LRDSDataParameter`s `batchExecuteStatement` binds
 * directly (rather than a bare value list) so no later step needs to
 * re-pair a value back to its column name.
 *
 * @returns The coerced parameters, or `undefined` when any single field
 *   fails to coerce — the whole record is rejected, not just that field.
 */
function coerceRecord(
  record: Record<string, unknown>,
  columns: readonly string[],
): readonly AWS.M3LRDSDataParameter[] | undefined {
  const parameters: AWS.M3LRDSDataParameter[] = [];
  for (const column of columns) {
    const coerced = coerceLoadValue(ownField(record, column));
    if (coerced === undefined) return undefined;
    parameters.push({ name: column, value: coerced });
  }
  return parameters;
}

/** {@link insertChunk}'s result: the chunk's own inserted/failed row counts. */
interface InsertChunkOutcome {
  /** The number of rows inserted for this chunk. */
  readonly inserted: number;
  /** The number of rows failed for this chunk. */
  readonly failed: number;
}

/**
 * Attempts one chunk's `batchExecuteStatement` inside its own
 * `withTransaction` scope. On a transaction failure, every row in the chunk
 * is recorded to `context.failedWriter`; the run continues — a chunk-level
 * failure never aborts subsequent chunks. Split out of {@link flushChunk} to
 * keep that function within the module's line-count budget.
 *
 * @returns See {@link InsertChunkOutcome}.
 */
async function insertChunk(
  context: LoadContext,
  sql: string,
  chunk: readonly PendingRow[],
  chunkIndex: number,
): Promise<InsertChunkOutcome> {
  const { deps, failedWriter } = context;
  try {
    await deps.rdsData.withTransaction(
      {
        resourceArn: deps.resourceArn,
        secretArn: deps.secretArn,
        ...(deps.database !== undefined && { database: deps.database }),
        ...(deps.schema !== undefined && { schema: deps.schema }),
      },
      async (transactionId) => {
        await deps.rdsData.batchExecuteStatement({
          resourceArn: deps.resourceArn,
          secretArn: deps.secretArn,
          sql,
          ...(deps.database !== undefined && { database: deps.database }),
          ...(deps.schema !== undefined && { schema: deps.schema }),
          parameterSets: chunk.map((row) => row.parameters),
          transactionId,
        });
      },
    );
    return { inserted: chunk.length, failed: 0 };
  } catch (cause) {
    const chunkFailureReason =
      cause instanceof Error ? cause.message : String(cause);
    deps.logger.error(`run-load: chunk ${String(chunkIndex)} failed`, {
      error: chunkFailureReason,
    });
    try {
      for (const row of chunk) {
        await failedWriter.append(row.record);
        deps.reportRecovery?.({
          item: JSON.stringify(row.record),
          error: [{ name: "M3LError", message: chunkFailureReason }],
          recordedAt: new Date().toISOString(),
        });
      }
    } catch (appendCause) {
      // The original transaction-failure `cause` above is only preserved in
      // the log line — `Core.M3LError` can only chain one `cause`, so it
      // must go through as message text here rather than being dropped.
      throw new Core.M3LError(
        `run-load: chunk ${String(chunkIndex)} failed (${chunkFailureReason}), and recording its rejected rows to the failed-writer also failed`,
        { code: FAILED_WRITER_CODE, cause: appendCause },
      );
    }
    return { inserted: 0, failed: chunk.length };
  }
}

/**
 * Inserts one chunk (via {@link insertChunk}) and checkpoints the outcome. A
 * chunk already covered by a prior interrupted run
 * (`chunkIndex <= context.resumeFromChunkIndex`) is skipped without
 * re-inserting or re-checkpointing it. The checkpoint written after this
 * chunk carries `context.failedWriter.bytesWritten` and the run's
 * just-updated running `failedCount`/`recordsProcessed` — the writer's own
 * byte-offset resume seam means no record replay is ever needed on the next
 * resume.
 *
 * @returns See {@link InsertChunkOutcome}.
 */
async function flushChunk(
  context: LoadContext,
  sql: string,
  chunk: readonly PendingRow[],
  chunkIndex: number,
  failedCountAfterChunk: number,
  recordsProcessed: number,
): Promise<InsertChunkOutcome> {
  if (chunk.length === 0) return { inserted: 0, failed: 0 };
  if (chunkIndex <= context.resumeFromChunkIndex) {
    return { inserted: 0, failed: 0 };
  }

  const outcome = await insertChunk(context, sql, chunk, chunkIndex);
  await context.deps.checkpoint.write({
    chunkIndex,
    failedOutputBytes: context.failedWriter.bytesWritten,
    failedCount: failedCountAfterChunk + outcome.failed,
    recordsProcessed,
  });
  return outcome;
}

/**
 * Resolves the `INSERT` column list: `deps.columns` when set (re-validated),
 * otherwise `firstRecord`'s own key order (validated here for the first
 * time — see {@link validateColumnName}'s TSDoc).
 */
function resolveColumns(
  explicit: readonly string[] | undefined,
  firstRecord: Record<string, unknown>,
): readonly string[] {
  const source = explicit ?? Object.keys(firstRecord);
  return source.map(validateColumnName);
}

/**
 * Immutable, run-scoped accumulator threaded through the load's helper
 * functions — each helper returns a new `LoadState` rather than mutating
 * its input, kept out of `runLoad` itself to hold its complexity down.
 */
interface LoadState {
  readonly columns: readonly string[] | undefined;
  readonly inserted: number;
  /** The running total of rows rejected — seeded from the checkpoint's `failedCount` on resume, the checkpoint's own `failedCount` field. */
  readonly failed: number;
  readonly nextChunkIndex: number;
  readonly pending: readonly PendingRow[];
  /**
   * The count of records read from the import stream so far *this run*
   * (accept or reject) — the checkpoint's `recordsProcessed` field. Starts
   * at `0` on every run (including a resumed one): the import stream is
   * always re-read from the beginning, so this run's own counter tracks
   * stream position independently of the resume skip-count it's compared
   * against in {@link consumeImportStream}.
   */
  readonly recordsProcessed: number;
}

/** Flushes `state.pending` as one chunk, when non-empty, returning the resulting state. */
async function flushPending(
  context: LoadContext,
  state: LoadState,
): Promise<LoadState> {
  if (state.columns === undefined || state.pending.length === 0) return state;
  const chunkIndex = state.nextChunkIndex;
  const sql = buildInsertSql(context.deps.table, state.columns);
  const outcome = await flushChunk(
    context,
    sql,
    state.pending,
    chunkIndex,
    state.failed,
    state.recordsProcessed,
  );
  return {
    ...state,
    inserted: state.inserted + outcome.inserted,
    failed: state.failed + outcome.failed,
    nextChunkIndex: chunkIndex + 1,
    pending: [],
  };
}

/**
 * Classifies one imported `record` against `state.columns` (resolving it
 * from `record`'s own keys on the first call, when `deps.columns` is unset):
 * an accepted row is appended to the returned state's `pending`; a rejected
 * one is appended to `context.failedWriter` and `failed` advances. Split out
 * of the import loop to keep its nesting depth low.
 */
async function classifyRecord(
  context: LoadContext,
  state: LoadState,
  record: Record<string, unknown>,
): Promise<LoadState> {
  const columns = state.columns ?? resolveColumns(context.deps.columns, record);
  const keysMatch = keysMatchColumns(record, columns);
  const parameters = keysMatch ? coerceRecord(record, columns) : undefined;

  if (parameters === undefined) {
    await context.failedWriter.append(record);
    // Two distinct failure modes collapse to this one rejection branch: a
    // key-set mismatch (checked again here, cheaply, since it was already
    // computed above) versus a value that failed `coerceLoadValue` despite
    // a matching key set. Each gets its own accurate message rather than one
    // message that would misdescribe the coercion-failure case.
    const rejectionReason = keysMatch
      ? "record's values failed to coerce to the resolved column types"
      : "record's keys do not match the resolved column list";
    context.deps.reportRecovery?.({
      item: JSON.stringify(record),
      error: [{ name: "M3LError", message: rejectionReason }],
      recordedAt: new Date().toISOString(),
    });
    return {
      ...state,
      columns,
      failed: state.failed + 1,
      recordsProcessed: state.recordsProcessed + 1,
    };
  }
  return {
    ...state,
    columns,
    pending: [...state.pending, { record, parameters }],
    recordsProcessed: state.recordsProcessed + 1,
  };
}

/**
 * Drains `context.deps.importer`'s stream, classifying and chunk-flushing
 * each record in turn, returning the final state.
 *
 * On a resumed run the import stream is always re-read from the beginning,
 * but every record already classified (accepted or rejected) by a prior
 * interrupted run must not be reclassified — reclassifying an already
 * rejected record would append it to `failedWriter` a second time. So while
 * this run's own `recordsProcessed` counter is still below
 * `resumeFromRecordCount`, each record is skipped entirely (never passed to
 * {@link classifyRecord}, never touching `pending`/`failedWriter`/`failed`)
 * — only the counter advances. Once the counter catches up, classification
 * resumes normally for every subsequent record.
 */
async function consumeImportStream(
  context: LoadContext,
  initialState: LoadState,
  resumeFromRecordCount: number,
): Promise<LoadState> {
  const stream = context.deps.importer.importStream(context.deps.source);
  let state = initialState;
  let step = await stream.next();
  while (step.done !== true) {
    if (state.recordsProcessed < resumeFromRecordCount) {
      state = { ...state, recordsProcessed: state.recordsProcessed + 1 };
    } else {
      state = await classifyRecord(context, state, step.value);
      if (state.pending.length >= context.deps.batchSize) {
        state = await flushPending(context, state);
      }
    }
    step = await stream.next();
  }
  return flushPending(context, state);
}

/**
 * Closes `failedWriter` after {@link runLoad}'s import-stream consumption has
 * finished, attributing a `close()` failure correctly depending on whether
 * that consumption already threw:
 *
 * - `primaryFailed: true` — `consumeImportStream` already threw, and that
 *   error is what's propagating out of `runLoad`. A `close()` failure here
 *   is secondary, so it's only logged; re-throwing it would replace the
 *   original error mid-flight instead of letting it continue propagating.
 * - `primaryFailed: false` — `consumeImportStream` completed cleanly (every
 *   remaining record inserted, none newly rejected this run), so a
 *   `close()` failure here is the ONLY signal of a real problem: e.g. a
 *   resumed run whose checkpoint claims a `resumeFromByte` beyond
 *   `failed.jsonl`'s actual size, a failure the writer defers until its
 *   first `write()`/`end()` call (which happens inside `close()` when zero
 *   rows were newly rejected this run). Swallowing it would let `runLoad`
 *   delete the checkpoint and report success over a truncated/invalid
 *   resume, so it propagates as a typed `M3LError` instead.
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_OUTPUT_WRITER"` when
 *   `close()` fails and `primaryFailed` is `false`.
 */
async function closeFailedWriterBestEffort(
  failedWriter: RunLoadFailedWriterPort,
  logger: Core.M3LLogger,
  primaryFailed: boolean,
): Promise<void> {
  try {
    await failedWriter.close();
  } catch (closeError) {
    if (primaryFailed) {
      logger.error("run-load: failed to close the rejection writer", {
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      });
      return;
    }
    throw new Core.M3LError(
      "run-load: failed to close the rejection writer after a successful run",
      { code: OUTPUT_WRITER_CODE, cause: closeError },
    );
  }
}

/**
 * Runs `load`: imports `deps.source` via `deps.importer`, resolves and
 * validates the column list, coerces and chunks accepted rows, and inserts
 * each chunk transactionally.
 *
 * @param deps - See {@link RunLoadDeps}.
 * @returns A summary of rows inserted and rows/chunks rejected.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_INVALID_COLUMN"`
 *   when an explicit or inferred column name fails the identifier pattern —
 *   a structural problem affecting the whole run, not a single row.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_OUTPUT_WRITER"` when
 *   the import stream otherwise consumed cleanly but the rejection writer's
 *   `close()` fails — see {@link closeFailedWriterBestEffort} for why this
 *   case cannot be a best-effort log (it may carry the only signal of an
 *   invalid resume).
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { runLoad } from "./run-load.js";
 *
 * async function run(deps: Parameters<typeof runLoad>[0]): Promise<void> {
 *   const { inserted, failed } = await runLoad(deps);
 *   console.log(`load: inserted=${String(inserted)} failed=${String(failed)}`);
 * }
 * ```
 */
export async function runLoad(deps: RunLoadDeps): Promise<RunLoadResult> {
  const savedCheckpoint = await deps.checkpoint.read();
  const resumeFromChunkIndex = savedCheckpoint.chunkIndex ?? -1;
  const resumeFromRecordCount = savedCheckpoint.recordsProcessed ?? 0;
  const failedWriter = deps.createFailedWriter(
    savedCheckpoint.failedOutputBytes ?? 0,
  );
  const context: LoadContext = { deps, failedWriter, resumeFromChunkIndex };

  const initialState: LoadState = {
    columns: deps.columns ? deps.columns.map(validateColumnName) : undefined,
    inserted: 0,
    failed: savedCheckpoint.failedCount ?? 0,
    // Seeded from the resume point, not hardcoded `0`: on a genuine resume
    // (`resumeFromChunkIndex` >= 0) the prior run already fully attempted
    // chunks `0..resumeFromChunkIndex`, so the first chunk this run actually
    // forms is really `resumeFromChunkIndex + 1` in the original absolute
    // sequence — post-skip records never re-enter `classifyRecord`, so
    // renumbering from `0` here would make `flushChunk`'s
    // `chunkIndex <= resumeFromChunkIndex` guard misidentify a genuinely new
    // chunk as already-flushed. For a fresh run or a legacy checkpoint with
    // no `chunkIndex` (`resumeFromChunkIndex === -1`), this seeds to `0`,
    // identical to the prior hardcoded behavior.
    nextChunkIndex: resumeFromChunkIndex + 1,
    pending: [],
    recordsProcessed: 0,
  };

  let state: LoadState;
  // Tracks whether consumeImportStream already threw, so
  // closeFailedWriterBestEffort knows whether a close() failure is
  // secondary (log-only) or is itself the only signal of a real failure
  // (must propagate). See that function's own TSDoc for why the
  // distinction matters.
  let primaryFailed = false;
  try {
    state = await consumeImportStream(
      context,
      initialState,
      resumeFromRecordCount,
    );
  } catch (cause) {
    primaryFailed = true;
    throw cause;
  } finally {
    await closeFailedWriterBestEffort(failedWriter, deps.logger, primaryFailed);
  }

  if (state.failed === 0) await deps.checkpoint.delete();
  deps.logger.step(
    `run-load complete: inserted=${String(state.inserted)}, failed=${String(state.failed)}`,
  );
  return { inserted: state.inserted, failed: state.failed };
}
