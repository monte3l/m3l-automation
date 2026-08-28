/**
 * `store/runs-repository` — `createConsoleRunsRepository`, the
 * {@link M3LConsoleRunsRepository} built over `console_runs`
 * (`store/migrations/registry.ts`'s v3, X4 run-registry, slice 3b).
 *
 * Exactly `store/meta-repository.ts`'s shape: a repository is a plain
 * FUNCTION over the injected {@link M3LStoreQueryExecutor} port, never a
 * class holding a `DatabaseSync` — equally usable against a transaction's
 * executor and the top-level store, with every failure branch reachable
 * from a plain unit test.
 *
 * **Transitions are guarded in the `WHERE` clause, never read-then-write.**
 * `claimForStart` runs
 * `UPDATE console_runs SET status = 'running', started_at_ms = ? WHERE id = ? AND status = 'queued'`
 * and reports success as `result.changes === 1`; `finish` guards the same
 * way on `WHERE id = ? AND status = 'running'`. A read-then-write
 * (`SELECT` the row, check its status in JS, then `UPDATE`) has a race
 * window between the two statements that a second caller can land in; the
 * guarded single statement has none — `node:sqlite` executes one `UPDATE`
 * atomically, so two concurrent callers each see their own guard evaluated
 * against the row state at the instant their own statement runs, and at
 * most one can match `status = 'queued'` (or `'running'`) before the first
 * writer's own update has already moved it on. A lost race therefore
 * reports `false` rather than corrupting the row — no transaction required
 * for this guarantee. The orchestrator (a later slice) is what turns a
 * `false` into a caller-facing typed error; this repository only reports
 * whether its own guarded write applied.
 *
 * **`reconcileOrphaned` leaves `started_at_ms` `NULL` on a reconciled
 * `queued` row, deliberately.** `store/migrations/registry.ts`'s v3 CHECK
 * constraints were narrowed (a deliberate, documented correction) to permit
 * `status = 'interrupted'` with `ended_at_ms` set and `started_at_ms` still
 * `NULL` — see that file's own TSDoc for why fabricating a `started_at_ms`
 * here would destroy an operationally decisive distinction. A `running` row
 * being reconciled keeps whatever real `started_at_ms` it already has; only
 * `status`, `outcome`, and `ended_at_ms` are ever written by this method.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import { toParametersJson } from "./parameters-json.js";
import { isRunStatus, isTerminalRunStatus } from "./run-status.js";
import type { M3LRunStatus, M3LRunTerminalStatus } from "./run-status.js";
import type { M3LStoreQueryExecutor, M3LStoreRow } from "./types.js";

/**
 * One raw `console_runs` column value, as reading it off an
 * {@link M3LStoreRow} yields it. Includes `| undefined` on top of
 * `store/types.ts`'s (unexported) `M3LStoreOutputValue` shape:
 * `noUncheckedIndexedAccess` widens every index-signature read
 * (`row["col"]`) this way, even for a column the `CHECK` constraints
 * guarantee is always present — {@link toRequiredNumber}/
 * {@link toRequiredString} turn that TS-only possibility into a thrown
 * `M3LConsoleError` rather than a silently wrong `"undefined"`/`NaN`.
 */
type RunColumnValue = string | number | bigint | null | Uint8Array | undefined;

/** The closed `execution_mode` vocabulary `console_runs`' own `CHECK` constraint enforces. */
export type RunExecutionMode = "spawn" | "in-process";

/**
 * One `console_runs` row, projected into camelCase fields with SQLite's
 * `INTEGER`/`TEXT`/`NULL` storage mapped to the JS shape callers actually
 * want: `dry_run` (`0`/`1`) to a real `boolean`, every nullable column to
 * `| undefined`, and `parameters_json` parsed back into a plain value.
 *
 * @example
 * ```ts
 * function summarize(record: M3LRunRecord): string {
 *   return `${record.id} (${record.status})`;
 * }
 * ```
 */
export interface M3LRunRecord {
  /** The run's id, unique within this store. */
  readonly id: string;
  /** The script identifier this run invokes. */
  readonly script: string;
  /** The run's current status. */
  readonly status: M3LRunStatus;
  /** Whether this run was launched in dry-run mode. */
  readonly dryRun: boolean;
  /** Whether this run executes as a spawned subprocess or in-process. */
  readonly executionMode: RunExecutionMode;
  /** The run's parameters, round-tripped through JSON. */
  readonly parameters: unknown;
  /** The operator who queued this run. */
  readonly operator: string;
  /** The correlation id this run's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Epoch-millisecond timestamp this run was queued at. */
  readonly queuedAtMs: number;
  /** Epoch-millisecond timestamp this run started at, or `undefined` if it never started. */
  readonly startedAtMs: number | undefined;
  /** Epoch-millisecond timestamp this run ended at, or `undefined` while pending. */
  readonly endedAtMs: number | undefined;
  /** This run's terminal outcome, or `undefined` while pending. */
  readonly outcome: M3LRunTerminalStatus | undefined;
  /** The spawned process's exit code, or `undefined` when not applicable. */
  readonly exitCode: number | undefined;
  /** A human-readable failure description, or `undefined` on a non-failure outcome. */
  readonly failureMessage: string | undefined;
}

/**
 * The fields `insertQueued` writes for a newly queued run. `status` is
 * always `'queued'` at insert time, so it is not part of this shape.
 *
 * @example
 * ```ts
 * const input: M3LRunInsert = {
 *   id: "run-1",
 *   script: "scripts/example",
 *   dryRun: false,
 *   executionMode: "spawn",
 *   parameters: { count: 3 },
 *   operator: "alice",
 *   correlationId: "corr-1",
 *   queuedAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LRunInsert {
  /** The run's id, unique within this store. */
  readonly id: string;
  /** The script identifier this run invokes. */
  readonly script: string;
  /** Whether this run was launched in dry-run mode. */
  readonly dryRun: boolean;
  /** Whether this run executes as a spawned subprocess or in-process. */
  readonly executionMode: RunExecutionMode;
  /**
   * The run's parameters; round-tripped through JSON, so must be
   * JSON-serializable — arbitrarily deep plain data is fine (`JSON.stringify`
   * has no depth limit), but a cycle, a `BigInt`, or a function/symbol/
   * `undefined` value is rejected. See `store/parameters-json.ts`'s own
   * `@packageDocumentation` for why a diagnostic serializer
   * (`Core.safeJsonStringify`) must never be swapped back in here — it
   * silently mangles exactly these cases instead of rejecting them.
   */
  readonly parameters: unknown;
  /** The operator queuing this run. */
  readonly operator: string;
  /** The correlation id this run's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Epoch-millisecond timestamp this run was queued at. */
  readonly queuedAtMs: number;
}

/**
 * The fields `finish` writes when a run reaches a terminal outcome.
 *
 * @example
 * ```ts
 * const result: M3LRunFinish = { outcome: "success", endedAtMs: Date.now() };
 * ```
 */
export interface M3LRunFinish {
  /** The run's terminal outcome. */
  readonly outcome: M3LRunTerminalStatus;
  /** Epoch-millisecond timestamp the run ended at. */
  readonly endedAtMs: number;
  /** The spawned process's exit code, when applicable. */
  readonly exitCode?: number;
  /** A human-readable failure description, when applicable. */
  readonly failureMessage?: string;
}

/**
 * Filters and a limit for `list`. `limit` is required — there is no
 * unbounded default, so a caller always makes an explicit choice. `limit`
 * must be a non-negative integer: SQLite treats a negative `LIMIT` as
 * unbounded, which would silently defeat that guarantee, so `list` validates
 * it at the boundary rather than binding it straight into SQL.
 *
 * @example
 * ```ts
 * const query: M3LRunListQuery = { status: "queued", limit: 20 };
 * ```
 */
export interface M3LRunListQuery {
  /** Restricts results to this status, when given. */
  readonly status?: M3LRunStatus;
  /** Restricts results to this script, when given. */
  readonly script?: string;
  /** The maximum number of rows to return. Must be a non-negative integer. */
  readonly limit: number;
}

/**
 * The console store's run registry: `console_runs` CRUD plus the guarded
 * FSM transitions and boot-time reconciliation the run lifecycle needs.
 *
 * @example
 * ```ts
 * function isBusy(repository: M3LConsoleRunsRepository, script: string): boolean {
 *   return repository.countRunningForScript(script) > 0;
 * }
 * ```
 */
export interface M3LConsoleRunsRepository {
  /**
   * Inserts a new `'queued'` run.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `input.parameters` is not JSON-serializable (a cycle, a
   *   `BigInt`, or a function/symbol/`undefined` value).
   */
  insertQueued(input: M3LRunInsert): void;
  /**
   * Guarded `queued` to `running` transition.
   *
   * @returns `true` when this call's own write applied (the run was
   *   `queued`); `false` when it was not (already running, already
   *   terminal, or unknown id) — a lost race reports `false`, never throws.
   */
  claimForStart(id: string, startedAtMs: number): boolean;
  /**
   * Guarded `running` to terminal transition.
   *
   * @returns `true` when this call's own write applied (the run was
   *   `running`); `false` when it was not (still queued, already terminal,
   *   or unknown id).
   */
  finish(id: string, result: M3LRunFinish): boolean;
  /** Reads one run by id, or `undefined` when no such row exists. */
  get(id: string): M3LRunRecord | undefined;
  /**
   * Lists runs matching `query`, oldest-queued-first, up to `query.limit`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `query.limit` is not a non-negative integer.
   */
  list(query: M3LRunListQuery): readonly M3LRunRecord[];
  /** Counts rows currently in `status`. */
  countByStatus(status: M3LRunStatus): number;
  /** Counts currently-`running` rows for `script`. */
  countRunningForScript(script: string): number;
  /**
   * Transitions every `queued` and `running` row to `interrupted`, setting
   * `outcome = 'interrupted'` and `ended_at_ms = endedAtMs`. A `queued` row
   * keeps `started_at_ms` `NULL`; a `running` row keeps its real
   * `started_at_ms`. Already-terminal rows are untouched.
   *
   * @returns The number of rows changed.
   */
  reconcileOrphaned(endedAtMs: number): number;
  /**
   * Guarded `queued` to `interrupted` transition, for a run that timed out
   * while still waiting in the queue — it never started, so `started_at_ms`
   * is deliberately left `NULL` rather than fabricated. See
   * `store/migrations/registry.ts`'s `CREATE_CONSOLE_RUNS_TABLE` TSDoc for why
   * `'interrupted'` is the one status the schema's own `CHECK` constraints
   * permit to end without ever having started, and why fabricating a
   * `started_at_ms` here would destroy that distinction.
   *
   * @returns `true` when this call's own write applied (the run was still
   *   `queued`); `false` when it was not (already started, already
   *   terminal, or unknown id) — a lost race reports `false`, never throws.
   */
  abandonQueued(id: string, endedAtMs: number): boolean;
}

/**
 * Runs `operation`, classifying any thrown value into an
 * {@link M3LConsoleError} — mirrors `meta-repository.ts`'s own
 * `runMetaOperation`. An already-typed `M3LConsoleError` (e.g. raised by a
 * production `M3LStoreQueryExecutor` that classifies its own failures) is
 * re-thrown unchanged rather than double-wrapped.
 */
function runRunsOperation<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(classifyStoreFailure(cause), "query", message, cause);
  }
}

/** Throws when a `NOT NULL` column reads back as SQL `NULL` (or, per {@link RunColumnValue}, TS-only `undefined`) — a `CHECK`-guaranteed invariant broken. */
function requireColumn(
  value: RunColumnValue,
): string | number | bigint | Uint8Array {
  if (value === null || value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "console_runs row is missing a value for a NOT NULL column",
    );
  }
  return value;
}

/** Narrows a raw column value to a required (non-`NULL`) number, tolerating a `bigint` read. */
function toRequiredNumber(value: RunColumnValue): number {
  return Number(requireColumn(value));
}

/** Narrows a raw column value to a required (non-`NULL`) string. */
function toRequiredString(value: RunColumnValue): string {
  return String(requireColumn(value));
}

/** Narrows a raw column value to an optional number, mapping SQL `NULL` to `undefined`. */
function toOptionalNumber(value: RunColumnValue): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

/** Narrows a raw column value to an optional string, mapping SQL `NULL` to `undefined`. */
function toOptionalString(value: RunColumnValue): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * Narrows a raw `status` column value to {@link M3LRunStatus}, throwing a
 * typed error rather than silently coercing an unrecognized value — the
 * `CHECK` constraint should make this unreachable, but a reader must not
 * trust that invariant blindly.
 */
function toRunStatus(value: RunColumnValue): M3LRunStatus {
  if (typeof value === "string" && isRunStatus(value)) return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_runs row has an unrecognized status value",
  );
}

/** Narrows a raw `outcome` column value to {@link M3LRunTerminalStatus}, mapping `NULL` to `undefined`. */
function toRunOutcome(value: RunColumnValue): M3LRunTerminalStatus | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && isTerminalRunStatus(value)) return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_runs row has an unrecognized outcome value",
  );
}

/** Narrows a raw `execution_mode` column value to {@link RunExecutionMode}. */
function toRunExecutionMode(value: RunColumnValue): RunExecutionMode {
  if (value === "spawn" || value === "in-process") return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_runs row has an unrecognized execution_mode value",
  );
}

/** Projects one raw `console_runs` row into a {@link M3LRunRecord}. */
function toRunRecord(row: M3LStoreRow): M3LRunRecord {
  return {
    id: toRequiredString(row["id"]),
    script: toRequiredString(row["script"]),
    status: toRunStatus(row["status"]),
    dryRun: toRequiredNumber(row["dry_run"]) === 1,
    executionMode: toRunExecutionMode(row["execution_mode"]),
    parameters: JSON.parse(toRequiredString(row["parameters_json"])) as unknown,
    operator: toRequiredString(row["operator"]),
    correlationId: toRequiredString(row["correlation_id"]),
    queuedAtMs: toRequiredNumber(row["queued_at_ms"]),
    startedAtMs: toOptionalNumber(row["started_at_ms"]),
    endedAtMs: toOptionalNumber(row["ended_at_ms"]),
    outcome: toRunOutcome(row["outcome"]),
    exitCode: toOptionalNumber(row["exit_code"]),
    failureMessage: toOptionalString(row["failure_message"]),
  };
}

/** Inserts one `'queued'` `console_runs` row. */
function insertQueuedRow(
  executor: M3LStoreQueryExecutor,
  input: M3LRunInsert,
): void {
  executor.run(
    `INSERT INTO console_runs (
      id, script, status, dry_run, execution_mode, parameters_json,
      operator, correlation_id, queued_at_ms
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.script,
      input.dryRun ? 1 : 0,
      input.executionMode,
      toParametersJson(input.parameters),
      input.operator,
      input.correlationId,
      input.queuedAtMs,
    ],
  );
}

/** The guarded `queued` to `running` write; see this module's own `@packageDocumentation` for why guarded, not read-then-write. */
function claimForStartRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  startedAtMs: number,
): boolean {
  const result = executor.run(
    "UPDATE console_runs SET status = 'running', started_at_ms = ? WHERE id = ? AND status = 'queued'",
    [startedAtMs, id],
  );
  return result.changes === 1;
}

/** The guarded `running` to terminal write. */
function finishRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  result: M3LRunFinish,
): boolean {
  const writeResult = executor.run(
    `UPDATE console_runs
     SET status = ?, outcome = ?, ended_at_ms = ?, exit_code = ?, failure_message = ?
     WHERE id = ? AND status = 'running'`,
    [
      result.outcome,
      result.outcome,
      result.endedAtMs,
      result.exitCode ?? null,
      result.failureMessage ?? null,
      id,
    ],
  );
  return writeResult.changes === 1;
}

/** Reads one `console_runs` row by id, or `undefined` when absent. */
function getRow(
  executor: M3LStoreQueryExecutor,
  id: string,
): M3LRunRecord | undefined {
  const row = executor.get("SELECT * FROM console_runs WHERE id = ?", [id]);
  return row === undefined ? undefined : toRunRecord(row);
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `limit` is a non-negative
 * integer. SQLite treats a negative `LIMIT` as unbounded, so binding an
 * unvalidated `limit` straight into `LIMIT ?` would silently contradict
 * `M3LRunListQuery.limit`'s own "no unbounded default" guarantee; a
 * non-integer (e.g. `1.5`) is rejected the same way, as a caller error
 * rather than the generic store fault `classifyStoreFailure` would
 * otherwise produce once it reached `node:sqlite`.
 */
function requireValidLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "list query limit must be a non-negative integer",
    );
  }
  return limit;
}

/** The `WHERE` clause + bound parameters `listRows` adds for `query`'s optional filters. */
function buildListFilter(query: M3LRunListQuery): {
  readonly clause: string;
  readonly parameters: readonly (string | number)[];
} {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (query.status !== undefined) {
    clauses.push("status = ?");
    parameters.push(query.status);
  }
  if (query.script !== undefined) {
    clauses.push("script = ?");
    parameters.push(query.script);
  }
  const clause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { clause, parameters };
}

/** Lists `console_runs` rows matching `query`, oldest-queued-first. */
function listRows(
  executor: M3LStoreQueryExecutor,
  query: M3LRunListQuery,
): readonly M3LRunRecord[] {
  const { clause, parameters } = buildListFilter(query);
  const rows = executor.all(
    `SELECT * FROM console_runs${clause} ORDER BY queued_at_ms ASC LIMIT ?`,
    [...parameters, requireValidLimit(query.limit)],
  );
  return rows.map((row) => toRunRecord(row));
}

/** Reads a `COUNT(*)` result row as a plain number, defaulting to `0`. */
function readCount(row: M3LStoreRow | undefined): number {
  return row === undefined ? 0 : Number(row["count"]);
}

/** Counts `console_runs` rows currently in `status`. */
function countByStatusRow(
  executor: M3LStoreQueryExecutor,
  status: M3LRunStatus,
): number {
  const row = executor.get(
    "SELECT COUNT(*) AS count FROM console_runs WHERE status = ?",
    [status],
  );
  return readCount(row);
}

/** Counts currently-`running` `console_runs` rows for `script`. */
function countRunningForScriptRow(
  executor: M3LStoreQueryExecutor,
  script: string,
): number {
  const row = executor.get(
    "SELECT COUNT(*) AS count FROM console_runs WHERE script = ? AND status = 'running'",
    [script],
  );
  return readCount(row);
}

/**
 * The one guarded `UPDATE ... WHERE status IN ('queued','running')` that
 * reconciles every mid-flight run to `interrupted` — never a read-then-loop.
 * See this module's own `@packageDocumentation` for why `started_at_ms` is
 * left untouched here rather than fabricated.
 */
function reconcileOrphanedRows(
  executor: M3LStoreQueryExecutor,
  endedAtMs: number,
): number {
  const result = executor.run(
    `UPDATE console_runs
     SET status = 'interrupted', outcome = 'interrupted', ended_at_ms = ?
     WHERE status IN ('queued', 'running')`,
    [endedAtMs],
  );
  return result.changes;
}

/**
 * The guarded `queued` to `interrupted` write; see
 * {@link M3LConsoleRunsRepository.abandonQueued}'s own TSDoc for why
 * `started_at_ms` is never written here.
 */
function abandonQueuedRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  endedAtMs: number,
): boolean {
  const result = executor.run(
    `UPDATE console_runs
     SET status = 'interrupted', outcome = 'interrupted', ended_at_ms = ?
     WHERE id = ? AND status = 'queued'`,
    [endedAtMs, id],
  );
  return result.changes === 1;
}

/**
 * Builds a {@link M3LConsoleRunsRepository} over `executor`.
 *
 * @param executor - The {@link M3LStoreQueryExecutor} port this repository
 * reads and writes through — the top-level store's own executor, or a
 * transaction's, closed over rather than held as a class field.
 * @returns The {@link M3LConsoleRunsRepository}.
 *
 * @example
 * ```ts
 * import { createStoreExecutor } from "@m3l-automation/m3l-console-server/store/executor";
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * const repository = createConsoleRunsRepository(createStoreExecutor(database));
 * repository.insertQueued({
 *   id: "run-1",
 *   script: "scripts/example",
 *   dryRun: false,
 *   executionMode: "spawn",
 *   parameters: {},
 *   operator: "alice",
 *   correlationId: "corr-1",
 *   queuedAtMs: Date.now(),
 * });
 * ```
 */
export function createConsoleRunsRepository(
  executor: M3LStoreQueryExecutor,
): M3LConsoleRunsRepository {
  return {
    insertQueued(input: M3LRunInsert): void {
      runRunsOperation(
        () => insertQueuedRow(executor, input),
        "console runs repository insertQueued failed",
      );
    },
    claimForStart(id: string, startedAtMs: number): boolean {
      return runRunsOperation(
        () => claimForStartRow(executor, id, startedAtMs),
        "console runs repository claimForStart failed",
      );
    },
    finish(id: string, result: M3LRunFinish): boolean {
      return runRunsOperation(
        () => finishRow(executor, id, result),
        "console runs repository finish failed",
      );
    },
    get(id: string): M3LRunRecord | undefined {
      return runRunsOperation(
        () => getRow(executor, id),
        "console runs repository get failed",
      );
    },
    list(query: M3LRunListQuery): readonly M3LRunRecord[] {
      return runRunsOperation(
        () => listRows(executor, query),
        "console runs repository list failed",
      );
    },
    countByStatus(status: M3LRunStatus): number {
      return runRunsOperation(
        () => countByStatusRow(executor, status),
        "console runs repository countByStatus failed",
      );
    },
    countRunningForScript(script: string): number {
      return runRunsOperation(
        () => countRunningForScriptRow(executor, script),
        "console runs repository countRunningForScript failed",
      );
    },
    reconcileOrphaned(endedAtMs: number): number {
      return runRunsOperation(
        () => reconcileOrphanedRows(executor, endedAtMs),
        "console runs repository reconcileOrphaned failed",
      );
    },
    abandonQueued(id: string, endedAtMs: number): boolean {
      return runRunsOperation(
        () => abandonQueuedRow(executor, id, endedAtMs),
        "console runs repository abandonQueued failed",
      );
    },
  };
}
