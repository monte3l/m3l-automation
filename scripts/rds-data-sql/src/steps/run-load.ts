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

/** The resume-state shape {@link runLoad} persists via its injected `checkpoint` port. */
export interface RunLoadCheckpoint {
  /** The 0-based index of the last chunk fully attempted (inserted or recorded as failed). */
  readonly chunkIndex?: number;
  /**
   * Every raw input record already rejected to `failedWriter` by a prior
   * interrupted run, in rejection order — the same shape passed to
   * `failedWriter.append`. On resume, {@link runLoad} re-appends every one
   * of these to `failedWriter` before it starts consuming the import
   * stream again, since `failedWriter`'s underlying exporter truncates
   * `failed.jsonl` on construction.
   */
  readonly failedRecords?: readonly Record<string, unknown>[];
}

/** The narrow checkpoint port {@link runLoad} depends on. */
interface RunLoadCheckpointPort {
  /** Reads the current checkpoint, or an empty object on a fresh run. */
  read(): Promise<RunLoadCheckpoint>;
  /** Persists the checkpoint after a chunk has been attempted. */
  write(checkpoint: {
    readonly chunkIndex: number;
    readonly failedRecords: readonly Record<string, unknown>[];
  }): Promise<void>;
  /** Deletes the checkpoint once the run completes with no failed rows. */
  delete(): Promise<void>;
}

/** The narrow rejection-writer port {@link runLoad} appends each rejected raw record to. */
interface RunLoadFailedWriterPort {
  /** Appends one rejected raw input record to `failed.jsonl`. */
  append(record: Record<string, unknown>): Promise<void>;
  /** Closes the underlying `failed.jsonl` stream. */
  close(): Promise<void>;
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
  /** The rejection-writer port; see {@link RunLoadFailedWriterPort}. */
  readonly failedWriter: RunLoadFailedWriterPort;
  /** The run's correlated logger. */
  readonly logger: Core.M3LLogger;
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

/** Fixed per-run context threaded through {@link flushChunk} — split out so its own parameter count stays low. */
interface FlushContext {
  readonly deps: RunLoadDeps;
  readonly sql: string;
  readonly resumeFromChunkIndex: number;
}

/** {@link flushChunk}'s result: the chunk's own inserted/failed counts, plus the run-scoped rejected-record accumulator after this chunk. */
interface FlushChunkOutcome {
  /** The number of rows inserted for this chunk. */
  readonly inserted: number;
  /** The number of rows failed for this chunk. */
  readonly failed: number;
  /** Every raw record rejected so far this run, including this chunk's (if any). */
  readonly failedRecords: readonly Record<string, unknown>[];
}

/**
 * Attempts one chunk's `batchExecuteStatement` inside its own
 * `withTransaction` scope. On a transaction failure, every row in the chunk
 * is recorded to `failedWriter` and `accumulatedFailed` grows to include
 * them; the run continues — a chunk-level failure never aborts subsequent
 * chunks. Split out of {@link flushChunk} to keep that function within the
 * module's line-count budget.
 *
 * @returns See {@link FlushChunkOutcome}.
 */
async function insertChunk(
  context: FlushContext,
  chunk: readonly PendingRow[],
  chunkIndex: number,
  accumulatedFailed: readonly Record<string, unknown>[],
): Promise<FlushChunkOutcome> {
  const { deps } = context;
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
          sql: context.sql,
          ...(deps.database !== undefined && { database: deps.database }),
          ...(deps.schema !== undefined && { schema: deps.schema }),
          parameterSets: chunk.map((row) => row.parameters),
          transactionId,
        });
      },
    );
    return {
      inserted: chunk.length,
      failed: 0,
      failedRecords: accumulatedFailed,
    };
  } catch (cause) {
    const chunkFailureReason =
      cause instanceof Error ? cause.message : String(cause);
    deps.logger.error(`run-load: chunk ${String(chunkIndex)} failed`, {
      error: chunkFailureReason,
    });
    try {
      for (const row of chunk) {
        await deps.failedWriter.append(row.record);
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
    return {
      inserted: 0,
      failed: chunk.length,
      failedRecords: [...accumulatedFailed, ...chunk.map((row) => row.record)],
    };
  }
}

/**
 * Inserts one chunk (via {@link insertChunk}) and checkpoints the outcome. A
 * chunk already covered by a prior interrupted run
 * (`chunkIndex <= resumeFromChunkIndex`) is skipped without re-inserting or
 * re-recording it. `accumulatedFailed` is this run's rejected record set
 * *before* this chunk; the checkpoint written after this chunk carries the
 * full accumulator (this chunk's newly-rejected rows appended, if any) so a
 * resumed run can fully re-populate `failedWriter` before continuing.
 *
 * @returns See {@link FlushChunkOutcome}.
 */
async function flushChunk(
  context: FlushContext,
  chunk: readonly PendingRow[],
  chunkIndex: number,
  accumulatedFailed: readonly Record<string, unknown>[],
): Promise<FlushChunkOutcome> {
  if (chunk.length === 0) {
    return { inserted: 0, failed: 0, failedRecords: accumulatedFailed };
  }
  if (chunkIndex <= context.resumeFromChunkIndex) {
    return { inserted: 0, failed: 0, failedRecords: accumulatedFailed };
  }

  const outcome = await insertChunk(
    context,
    chunk,
    chunkIndex,
    accumulatedFailed,
  );
  await context.deps.checkpoint.write({
    chunkIndex,
    failedRecords: outcome.failedRecords,
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
  readonly failed: number;
  readonly nextChunkIndex: number;
  readonly pending: readonly PendingRow[];
  /** Every raw record rejected so far this run (including any re-populated from a resumed checkpoint); the checkpoint's `failedRecords` field. */
  readonly failedRecords: readonly Record<string, unknown>[];
}

/** Flushes `state.pending` as one chunk, when non-empty, returning the resulting state. */
async function flushPending(
  deps: RunLoadDeps,
  state: LoadState,
  resumeFromChunkIndex: number,
): Promise<LoadState> {
  if (state.columns === undefined || state.pending.length === 0) return state;
  const context: FlushContext = {
    deps,
    sql: buildInsertSql(deps.table, state.columns),
    resumeFromChunkIndex,
  };
  const outcome = await flushChunk(
    context,
    state.pending,
    state.nextChunkIndex,
    state.failedRecords,
  );
  return {
    ...state,
    inserted: state.inserted + outcome.inserted,
    failed: state.failed + outcome.failed,
    nextChunkIndex: state.nextChunkIndex + 1,
    pending: [],
    failedRecords: outcome.failedRecords,
  };
}

/**
 * Classifies one imported `record` against `state.columns` (resolving it
 * from `record`'s own keys on the first call, when `deps.columns` is unset):
 * an accepted row is appended to the returned state's `pending`; a rejected
 * one is appended to `deps.failedWriter` and both `failed` and
 * `failedRecords` advance. Split out of the import loop to keep its nesting
 * depth low.
 */
async function classifyRecord(
  deps: RunLoadDeps,
  state: LoadState,
  record: Record<string, unknown>,
): Promise<LoadState> {
  const columns = state.columns ?? resolveColumns(deps.columns, record);
  const parameters = keysMatchColumns(record, columns)
    ? coerceRecord(record, columns)
    : undefined;

  if (parameters === undefined) {
    await deps.failedWriter.append(record);
    return {
      ...state,
      columns,
      failed: state.failed + 1,
      failedRecords: [...state.failedRecords, record],
    };
  }
  return {
    ...state,
    columns,
    pending: [...state.pending, { record, parameters }],
  };
}

/** Drains `deps.importer`'s stream, classifying and chunk-flushing each record in turn, returning the final state. */
async function consumeImportStream(
  deps: RunLoadDeps,
  initialState: LoadState,
  resumeFromChunkIndex: number,
): Promise<LoadState> {
  const stream = deps.importer.importStream(deps.source);
  let state = initialState;
  let step = await stream.next();
  while (step.done !== true) {
    state = await classifyRecord(deps, state, step.value);
    if (state.pending.length >= deps.batchSize) {
      state = await flushPending(deps, state, resumeFromChunkIndex);
    }
    step = await stream.next();
  }
  return flushPending(deps, state, resumeFromChunkIndex);
}

/** Closes `deps.failedWriter`, best-effort — a failing close() must never mask the real outcome above it. */
async function closeFailedWriterBestEffort(deps: RunLoadDeps): Promise<void> {
  try {
    await deps.failedWriter.close();
  } catch (closeError) {
    deps.logger.error("run-load: failed to close the rejection writer", {
      error:
        closeError instanceof Error ? closeError.message : String(closeError),
    });
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
  const initialFailedRecords = savedCheckpoint.failedRecords ?? [];

  // The exporter behind `failedWriter` truncates `failed.jsonl` on
  // construction (`fs.createWriteStream`'s default flags) — a resumed run
  // must re-populate it with every record a prior interrupted run already
  // rejected before any new record is consumed, or those rejections are
  // silently lost.
  for (const record of initialFailedRecords) {
    await deps.failedWriter.append(record);
  }

  const initialState: LoadState = {
    columns: deps.columns ? deps.columns.map(validateColumnName) : undefined,
    inserted: 0,
    failed: initialFailedRecords.length,
    nextChunkIndex: 0,
    pending: [],
    failedRecords: initialFailedRecords,
  };

  let state: LoadState;
  try {
    state = await consumeImportStream(deps, initialState, resumeFromChunkIndex);
  } finally {
    await closeFailedWriterBestEffort(deps);
  }

  if (state.failed === 0) await deps.checkpoint.delete();
  deps.logger.step(
    `run-load complete: inserted=${String(state.inserted)}, failed=${String(state.failed)}`,
  );
  return { inserted: state.inserted, failed: state.failed };
}
