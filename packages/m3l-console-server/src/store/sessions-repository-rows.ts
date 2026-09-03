/**
 * `store/sessions-repository-rows` — the raw row-projection and
 * single-statement query/write functions `store/sessions-repository.ts`'s
 * builder functions are composed from, split into their own file purely
 * because `sessions-repository.ts` sits at the 25,000-byte per-file budget
 * ceiling (ADR-0072). There is no design rationale beyond that: this is a
 * byte-budget split, not a layering decision — mirrors
 * `runs/orchestrator-types.ts`'s own split off `runs/orchestrator.ts` — and
 * every function here stays a plain function over an injected
 * {@link M3LStoreQueryExecutor}, never a class. None of these functions are
 * re-exported from `sessions-repository.ts`'s own public surface — they are
 * this module's private implementation, same discipline as an `internal/`
 * file, just not under that directory name (this package's existing layout
 * has no `internal/` convention to match).
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import { toParametersJson } from "./parameters-json.js";
import { isRunStatus, isTerminalRunStatus } from "./run-status.js";
import type { M3LRunStatus, M3LRunTerminalStatus } from "./run-status.js";
import type {
  M3LSessionBindingInsert,
  M3LSessionBindingRecord,
  M3LSessionDecisionAnswer,
  M3LSessionDecisionInsert,
  M3LSessionDecisionRecord,
  M3LSessionDecisionStatus,
  M3LSessionInsert,
  M3LSessionListQuery,
  M3LSessionRecord,
  M3LSessionStatus,
  M3LSessionStepFinish,
  M3LSessionStepInsert,
  M3LSessionStepRecord,
} from "./sessions-repository-types.js";
import type { M3LStoreQueryExecutor, M3LStoreRow } from "./types.js";

/**
 * One raw column value, as reading it off an {@link M3LStoreRow} yields it.
 * Includes `| undefined` on top of `store/types.ts`'s (unexported)
 * `M3LStoreOutputValue` shape — see `runs-repository.ts`'s own
 * `RunColumnValue` TSDoc for why `noUncheckedIndexedAccess` requires this.
 */
type SessionColumnValue =
  string | number | bigint | null | Uint8Array | undefined;

/** Throws when a `NOT NULL` column reads back as SQL `NULL` (or, per {@link SessionColumnValue}, TS-only `undefined`) — a `CHECK`-guaranteed invariant broken. `table` names the source table in the thrown message, matching `runs-repository.ts`'s equivalent. */
function requireColumn(
  table: string,
  value: SessionColumnValue,
): string | number | bigint | Uint8Array {
  if (value === null || value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      `${table} row is missing a value for a NOT NULL column`,
    );
  }
  return value;
}

/** Narrows a raw column value to a required (non-`NULL`) number, tolerating a `bigint` read. */
function toRequiredNumber(table: string, value: SessionColumnValue): number {
  return Number(requireColumn(table, value));
}

/** Narrows a raw column value to a required (non-`NULL`) string. */
function toRequiredString(table: string, value: SessionColumnValue): string {
  return String(requireColumn(table, value));
}

/** Narrows a raw column value to an optional number, mapping SQL `NULL` to `undefined`. */
function toOptionalNumber(value: SessionColumnValue): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

/** Narrows a raw column value to an optional string, mapping SQL `NULL` to `undefined`. */
function toOptionalString(value: SessionColumnValue): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** Parses an optional JSON-text column (`NULL` maps to `undefined`) back into a plain value. */
function toOptionalJson(value: SessionColumnValue): unknown {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(String(value)) as unknown;
}

/** Narrows a raw `console_sessions.status` column value to {@link M3LSessionStatus}. */
function toSessionStatus(value: SessionColumnValue): M3LSessionStatus {
  if (value === "open" || value === "closed") return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_sessions row has an unrecognized status value",
  );
}

/** Narrows a raw `console_session_decisions.status` column value to {@link M3LSessionDecisionStatus}. */
function toDecisionStatus(value: SessionColumnValue): M3LSessionDecisionStatus {
  if (value === "pending" || value === "answered") return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_session_decisions row has an unrecognized status value",
  );
}

/** Narrows a raw `console_session_steps.status` column value to {@link M3LRunStatus}. */
function toStepStatus(value: SessionColumnValue): M3LRunStatus {
  if (typeof value === "string" && isRunStatus(value)) return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_session_steps row has an unrecognized status value",
  );
}

/** Narrows a raw `console_session_steps.outcome` column value to {@link M3LRunTerminalStatus}, mapping `NULL` to `undefined`. */
function toStepOutcome(
  value: SessionColumnValue,
): M3LRunTerminalStatus | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && isTerminalRunStatus(value)) return value;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_session_steps row has an unrecognized outcome value",
  );
}

/** The `console_sessions` table name, threaded into {@link requireColumn}'s thrown message. */
const SESSIONS_TABLE = "console_sessions";
/** The `console_session_steps` table name, threaded into {@link requireColumn}'s thrown message. */
const SESSION_STEPS_TABLE = "console_session_steps";
/** The `console_session_bindings` table name, threaded into {@link requireColumn}'s thrown message. */
const SESSION_BINDINGS_TABLE = "console_session_bindings";
/** The `console_session_decisions` table name, threaded into {@link requireColumn}'s thrown message. */
const SESSION_DECISIONS_TABLE = "console_session_decisions";

/** Projects one raw `console_sessions` row into a {@link M3LSessionRecord}, branching on `status` per the table's `CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL))` invariant. */
function toSessionRecord(row: M3LStoreRow): M3LSessionRecord {
  const base = {
    id: toRequiredString(SESSIONS_TABLE, row["id"]),
    operator: toRequiredString(SESSIONS_TABLE, row["operator"]),
    correlationId: toRequiredString(SESSIONS_TABLE, row["correlation_id"]),
    createdAtMs: toRequiredNumber(SESSIONS_TABLE, row["created_at_ms"]),
    updatedAtMs: toRequiredNumber(SESSIONS_TABLE, row["updated_at_ms"]),
  };
  const status = toSessionStatus(row["status"]);
  if (status === "closed") {
    return {
      ...base,
      status,
      closedAtMs: toRequiredNumber(SESSIONS_TABLE, row["closed_at_ms"]),
    };
  }
  return { ...base, status };
}

/** Projects one raw `console_session_steps` row into a {@link M3LSessionStepRecord}. */
function toStepRecord(row: M3LStoreRow): M3LSessionStepRecord {
  return {
    id: toRequiredString(SESSION_STEPS_TABLE, row["id"]),
    sessionId: toRequiredString(SESSION_STEPS_TABLE, row["session_id"]),
    ordinal: toRequiredNumber(SESSION_STEPS_TABLE, row["ordinal"]),
    operation: toRequiredString(SESSION_STEPS_TABLE, row["operation"]),
    parameters: JSON.parse(
      toRequiredString(SESSION_STEPS_TABLE, row["parameters_json"]),
    ) as unknown,
    runId: toOptionalString(row["run_id"]),
    status: toStepStatus(row["status"]),
    resultRef: toOptionalString(row["result_ref"]),
    queuedAtMs: toRequiredNumber(SESSION_STEPS_TABLE, row["queued_at_ms"]),
    startedAtMs: toOptionalNumber(row["started_at_ms"]),
    endedAtMs: toOptionalNumber(row["ended_at_ms"]),
    outcome: toStepOutcome(row["outcome"]),
    failureMessage: toOptionalString(row["failure_message"]),
  };
}

/** Projects one raw `console_session_bindings` row into a {@link M3LSessionBindingRecord}. */
function toBindingRecord(row: M3LStoreRow): M3LSessionBindingRecord {
  return {
    id: toRequiredString(SESSION_BINDINGS_TABLE, row["id"]),
    sessionId: toRequiredString(SESSION_BINDINGS_TABLE, row["session_id"]),
    reference: toRequiredString(SESSION_BINDINGS_TABLE, row["reference"]),
    expectedType: toRequiredString(
      SESSION_BINDINGS_TABLE,
      row["expected_type"],
    ),
    multiSelect:
      toRequiredNumber(SESSION_BINDINGS_TABLE, row["multi_select"]) === 1,
    createdAtMs: toRequiredNumber(SESSION_BINDINGS_TABLE, row["created_at_ms"]),
    parameterName: toOptionalString(row["parameter_name"]),
  };
}

/** Projects one raw `console_session_decisions` row into a {@link M3LSessionDecisionRecord}, branching on `status` per the table's `CHECK` pair tying `status = 'answered'` to `answer_json`/`answered_at_ms` both being non-`NULL`. */
function toDecisionRecord(row: M3LStoreRow): M3LSessionDecisionRecord {
  const base = {
    id: toRequiredString(SESSION_DECISIONS_TABLE, row["id"]),
    sessionId: toRequiredString(SESSION_DECISIONS_TABLE, row["session_id"]),
    stepId: toRequiredString(SESSION_DECISIONS_TABLE, row["step_id"]),
    prompt: toRequiredString(SESSION_DECISIONS_TABLE, row["prompt"]),
    options: toOptionalJson(row["options_json"]),
    createdAtMs: toRequiredNumber(
      SESSION_DECISIONS_TABLE,
      row["created_at_ms"],
    ),
  };
  const status = toDecisionStatus(row["status"]);
  if (status === "answered") {
    return {
      ...base,
      status,
      answer: toOptionalJson(
        requireColumn(SESSION_DECISIONS_TABLE, row["answer_json"]),
      ),
      answeredAtMs: toRequiredNumber(
        SESSION_DECISIONS_TABLE,
        row["answered_at_ms"],
      ),
    };
  }
  return { ...base, status };
}

/** Inserts one `'open'` `console_sessions` row. */
export function insertSessionRow(
  executor: M3LStoreQueryExecutor,
  input: M3LSessionInsert,
): void {
  executor.run(
    `INSERT INTO console_sessions (
      id, status, operator, correlation_id, created_at_ms, updated_at_ms, closed_at_ms
    ) VALUES (?, 'open', ?, ?, ?, ?, NULL)`,
    [
      input.id,
      input.operator,
      input.correlationId,
      input.createdAtMs,
      input.createdAtMs,
    ],
  );
}

/** Reads one `console_sessions` row by id, or `undefined` when absent. */
export function getSessionRow(
  executor: M3LStoreQueryExecutor,
  id: string,
): M3LSessionRecord | undefined {
  const row = executor.get("SELECT * FROM console_sessions WHERE id = ?", [id]);
  return row === undefined ? undefined : toSessionRecord(row);
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `limit` is a non-negative integer
 * — see `runs-repository.ts`'s `requireValidLimit` for the full rationale.
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

/** The `WHERE` clause + bound parameters `listSessionRows` adds for `query`'s optional filters. */
function buildSessionListFilter(query: M3LSessionListQuery): {
  readonly clause: string;
  readonly parameters: readonly (string | number)[];
} {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (query.status !== undefined) {
    clauses.push("status = ?");
    parameters.push(query.status);
  }
  if (query.operator !== undefined) {
    clauses.push("operator = ?");
    parameters.push(query.operator);
  }
  const clause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { clause, parameters };
}

/** Lists `console_sessions` rows matching `query`, oldest-created-first. */
export function listSessionRows(
  executor: M3LStoreQueryExecutor,
  query: M3LSessionListQuery,
): readonly M3LSessionRecord[] {
  const { clause, parameters } = buildSessionListFilter(query);
  const rows = executor.all(
    `SELECT * FROM console_sessions${clause} ORDER BY created_at_ms ASC LIMIT ?`,
    [...parameters, requireValidLimit(query.limit)],
  );
  return rows.map((row) => toSessionRecord(row));
}

/** The guarded `open` to `closed` write. */
export function closeSessionRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  closedAtMs: number,
): boolean {
  const result = executor.run(
    `UPDATE console_sessions
     SET status = 'closed', closed_at_ms = ?, updated_at_ms = ?
     WHERE id = ? AND status = 'open'`,
    [closedAtMs, closedAtMs, id],
  );
  return result.changes === 1;
}

/** The guarded `closed` to `open` write, clearing `closed_at_ms`. */
export function reopenSessionRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  updatedAtMs: number,
): boolean {
  const result = executor.run(
    `UPDATE console_sessions
     SET status = 'open', closed_at_ms = NULL, updated_at_ms = ?
     WHERE id = ? AND status = 'closed'`,
    [updatedAtMs, id],
  );
  return result.changes === 1;
}

/** Inserts one `'queued'` `console_session_steps` row. */
export function insertStepRow(
  executor: M3LStoreQueryExecutor,
  input: M3LSessionStepInsert,
): void {
  executor.run(
    `INSERT INTO console_session_steps (
      id, session_id, ordinal, operation, parameters_json, run_id, status,
      result_ref, queued_at_ms
    ) VALUES (?, ?, ?, ?, ?, NULL, 'queued', NULL, ?)`,
    [
      input.id,
      input.sessionId,
      input.ordinal,
      input.operation,
      toParametersJson(input.parameters),
      input.queuedAtMs,
    ],
  );
}

/** The guarded `queued` to `running` write. */
export function claimStepForStartRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  startedAtMs: number,
): boolean {
  const result = executor.run(
    "UPDATE console_session_steps SET status = 'running', started_at_ms = ? WHERE id = ? AND status = 'queued'",
    [startedAtMs, id],
  );
  return result.changes === 1;
}

/** The guarded `running` to terminal write. */
export function finishStepRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  result: M3LSessionStepFinish,
): boolean {
  const writeResult = executor.run(
    `UPDATE console_session_steps
     SET status = ?, outcome = ?, ended_at_ms = ?, result_ref = ?, failure_message = ?
     WHERE id = ? AND status = 'running'`,
    [
      result.outcome,
      result.outcome,
      result.endedAtMs,
      result.resultRef ?? null,
      result.failureMessage ?? null,
      id,
    ],
  );
  return writeResult.changes === 1;
}

/** Reads one `console_session_steps` row by id, or `undefined` when absent. */
export function getStepRow(
  executor: M3LStoreQueryExecutor,
  id: string,
): M3LSessionStepRecord | undefined {
  const row = executor.get("SELECT * FROM console_session_steps WHERE id = ?", [
    id,
  ]);
  return row === undefined ? undefined : toStepRecord(row);
}

/** Reads one `console_session_steps` row by its `(session_id, ordinal)` pair, or `undefined` when absent. */
export function getStepByOrdinalRow(
  executor: M3LStoreQueryExecutor,
  sessionId: string,
  ordinal: number,
): M3LSessionStepRecord | undefined {
  const row = executor.get(
    "SELECT * FROM console_session_steps WHERE session_id = ? AND ordinal = ?",
    [sessionId, ordinal],
  );
  return row === undefined ? undefined : toStepRecord(row);
}

/** Lists `console_session_steps` rows for `sessionId`, ordinal-ascending. */
export function listStepsForSessionRows(
  executor: M3LStoreQueryExecutor,
  sessionId: string,
): readonly M3LSessionStepRecord[] {
  const rows = executor.all(
    "SELECT * FROM console_session_steps WHERE session_id = ? ORDER BY ordinal ASC",
    [sessionId],
  );
  return rows.map((row) => toStepRecord(row));
}

/** The guarded one-shot `run_id` attach write (X6 slice 4, Part A). */
export function attachStepRunRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  runId: string,
): boolean {
  const result = executor.run(
    "UPDATE console_session_steps SET run_id = ? WHERE id = ? AND run_id IS NULL",
    [runId, id],
  );
  return result.changes === 1;
}

/** Reads one `console_session_steps` row by its attached `run_id`, or `undefined` when absent (X6 slice 4, Part A). */
export function getStepByRunIdRow(
  executor: M3LStoreQueryExecutor,
  runId: string,
): M3LSessionStepRecord | undefined {
  const row = executor.get(
    "SELECT * FROM console_session_steps WHERE run_id = ?",
    [runId],
  );
  return row === undefined ? undefined : toStepRecord(row);
}

/** Inserts one `console_session_bindings` row. */
export function insertBindingRow(
  executor: M3LStoreQueryExecutor,
  input: M3LSessionBindingInsert,
): void {
  executor.run(
    `INSERT INTO console_session_bindings (
      id, session_id, reference, expected_type, multi_select, created_at_ms,
      parameter_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sessionId,
      input.reference,
      input.expectedType,
      input.multiSelect ? 1 : 0,
      input.createdAtMs,
      input.parameterName,
    ],
  );
}

/** Lists `console_session_bindings` rows for `sessionId`, created-ascending. */
export function listBindingsForSessionRows(
  executor: M3LStoreQueryExecutor,
  sessionId: string,
): readonly M3LSessionBindingRecord[] {
  const rows = executor.all(
    "SELECT * FROM console_session_bindings WHERE session_id = ? ORDER BY created_at_ms ASC",
    [sessionId],
  );
  return rows.map((row) => toBindingRecord(row));
}

/** Inserts one `'pending'` `console_session_decisions` row. `options_json` is `NULL` when `input.options` was omitted. */
export function insertDecisionRow(
  executor: M3LStoreQueryExecutor,
  input: M3LSessionDecisionInsert,
): void {
  executor.run(
    `INSERT INTO console_session_decisions (
      id, session_id, step_id, prompt, options_json, status, answer_json,
      created_at_ms, answered_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    [
      input.id,
      input.sessionId,
      input.stepId,
      input.prompt,
      input.options === undefined ? null : toParametersJson(input.options),
      input.createdAtMs,
    ],
  );
}

/** The guarded `pending` to `answered` write. */
export function answerDecisionRow(
  executor: M3LStoreQueryExecutor,
  id: string,
  answer: M3LSessionDecisionAnswer,
): boolean {
  const result = executor.run(
    `UPDATE console_session_decisions
     SET status = 'answered', answer_json = ?, answered_at_ms = ?
     WHERE id = ? AND status = 'pending'`,
    [toParametersJson(answer.answer), answer.answeredAtMs, id],
  );
  return result.changes === 1;
}

/** Reads one `console_session_decisions` row by id, or `undefined` when absent. */
export function getDecisionRow(
  executor: M3LStoreQueryExecutor,
  id: string,
): M3LSessionDecisionRecord | undefined {
  const row = executor.get(
    "SELECT * FROM console_session_decisions WHERE id = ?",
    [id],
  );
  return row === undefined ? undefined : toDecisionRecord(row);
}

/** Lists `console_session_decisions` rows for `sessionId`, created-ascending. */
export function listDecisionsForSessionRows(
  executor: M3LStoreQueryExecutor,
  sessionId: string,
): readonly M3LSessionDecisionRecord[] {
  const rows = executor.all(
    "SELECT * FROM console_session_decisions WHERE session_id = ? ORDER BY created_at_ms ASC",
    [sessionId],
  );
  return rows.map((row) => toDecisionRecord(row));
}

/** Reads a `COUNT(*)` result row as a plain number, defaulting to `0`. */
function readCount(row: M3LStoreRow | undefined): number {
  return row === undefined ? 0 : Number(row["count"]);
}

/** Counts `console_sessions` rows currently `'open'`. */
export function countOpenSessionsRow(executor: M3LStoreQueryExecutor): number {
  const row = executor.get(
    "SELECT COUNT(*) AS count FROM console_sessions WHERE status = 'open'",
  );
  return readCount(row);
}
