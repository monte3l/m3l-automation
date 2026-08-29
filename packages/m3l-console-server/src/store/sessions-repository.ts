/**
 * `store/sessions-repository` — `createConsoleSessionsRepository`, the
 * {@link M3LConsoleSessionsRepository} built over `console_sessions`,
 * `console_session_steps`, `console_session_bindings`, and
 * `console_session_decisions` (`store/migrations/registry.ts`'s v4, X6
 * workbench-sessions module, slice 1).
 *
 * Mirrors `store/runs-repository.ts` almost line-for-line — same shape as a
 * plain FUNCTION over the injected {@link M3LStoreQueryExecutor} port, never
 * a class holding a `DatabaseSync`, and the same **guarded `WHERE`-clause
 * transitions, never read-then-write** discipline: `closeSession`,
 * `reopenSession`, `claimStepForStart`, `finishStep`, and `answerDecision`
 * each run one `UPDATE ... WHERE id = ? AND <expected state>` and report
 * success as `result.changes === 1`, so a lost race reports `false` rather
 * than corrupting the row — see `runs-repository.ts`'s own
 * `@packageDocumentation` for the full argument on why a single guarded
 * statement closes the race window a read-then-write cannot.
 *
 * A session's own `status` vocabulary (`'open'` / `'closed'`) is
 * console-local, declared inline rather than imported from
 * `store/run-status.ts` — a session's lifecycle is not a run's. A session
 * STEP's `status`, by contrast, genuinely reuses `store/run-status.ts`'s
 * {@link M3LRunStatus}/{@link M3LRunTerminalStatus} vocabulary unchanged,
 * because `console_session_steps`' `CHECK` constraints
 * (`store/migrations/registry.ts`) were declared as an exact structural copy
 * of `console_runs`' own FSM shape, `runStatusCheckList()` included.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import {
  answerDecisionRow,
  claimStepForStartRow,
  closeSessionRow,
  countOpenSessionsRow,
  finishStepRow,
  getDecisionRow,
  getSessionRow,
  getStepByOrdinalRow,
  getStepRow,
  insertBindingRow,
  insertDecisionRow,
  insertSessionRow,
  insertStepRow,
  listBindingsForSessionRows,
  listDecisionsForSessionRows,
  listSessionRows,
  listStepsForSessionRows,
  reopenSessionRow,
} from "./sessions-repository-rows.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingInsert,
  M3LSessionBindingRecord,
  M3LSessionDecisionAnswer,
  M3LSessionDecisionInsert,
  M3LSessionDecisionRecord,
  M3LSessionInsert,
  M3LSessionListQuery,
  M3LSessionRecord,
  M3LSessionStepFinish,
  M3LSessionStepInsert,
  M3LSessionStepRecord,
} from "./sessions-repository-types.js";
import type { M3LStoreQueryExecutor } from "./types.js";

export type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingInsert,
  M3LSessionBindingRecord,
  M3LSessionDecisionAnswer,
  M3LSessionDecisionInsert,
  M3LSessionDecisionRecord,
  M3LSessionInsert,
  M3LSessionListQuery,
  M3LSessionRecord,
  M3LSessionStepFinish,
  M3LSessionStepInsert,
  M3LSessionStepRecord,
} from "./sessions-repository-types.js";

/**
 * Runs `operation`, classifying any thrown value into an
 * {@link M3LConsoleError} — mirrors `runs-repository.ts`'s own
 * `runRunsOperation`. An already-typed `M3LConsoleError` is re-thrown
 * unchanged rather than double-wrapped.
 */
function runSessionsOperation<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(classifyStoreFailure(cause), "query", message, cause);
  }
}

/**
 * The `console_sessions`-scoped slice of {@link M3LConsoleSessionsRepository}
 * — split out of {@link createConsoleSessionsRepository} purely to keep each
 * builder function short; the returned object is spread back together with
 * the step/binding/decision slices below.
 */
function buildSessionMethods(
  executor: M3LStoreQueryExecutor,
): Pick<
  M3LConsoleSessionsRepository,
  | "insertSession"
  | "getSession"
  | "listSessions"
  | "closeSession"
  | "reopenSession"
  | "countOpenSessions"
> {
  return {
    insertSession(input: M3LSessionInsert): void {
      runSessionsOperation(
        () => insertSessionRow(executor, input),
        "console sessions repository insertSession failed",
      );
    },
    getSession(id: string): M3LSessionRecord | undefined {
      return runSessionsOperation(
        () => getSessionRow(executor, id),
        "console sessions repository getSession failed",
      );
    },
    listSessions(query: M3LSessionListQuery): readonly M3LSessionRecord[] {
      return runSessionsOperation(
        () => listSessionRows(executor, query),
        "console sessions repository listSessions failed",
      );
    },
    closeSession(id: string, closedAtMs: number): boolean {
      return runSessionsOperation(
        () => closeSessionRow(executor, id, closedAtMs),
        "console sessions repository closeSession failed",
      );
    },
    reopenSession(id: string, updatedAtMs: number): boolean {
      return runSessionsOperation(
        () => reopenSessionRow(executor, id, updatedAtMs),
        "console sessions repository reopenSession failed",
      );
    },
    countOpenSessions(): number {
      return runSessionsOperation(
        () => countOpenSessionsRow(executor),
        "console sessions repository countOpenSessions failed",
      );
    },
  };
}

/** The `console_session_steps`-scoped slice — see {@link buildSessionMethods}'s own TSDoc for why this is split out. */
function buildStepMethods(
  executor: M3LStoreQueryExecutor,
): Pick<
  M3LConsoleSessionsRepository,
  | "insertStep"
  | "claimStepForStart"
  | "finishStep"
  | "getStep"
  | "getStepByOrdinal"
  | "listStepsForSession"
> {
  return {
    insertStep(input: M3LSessionStepInsert): void {
      runSessionsOperation(
        () => insertStepRow(executor, input),
        "console sessions repository insertStep failed",
      );
    },
    claimStepForStart(id: string, startedAtMs: number): boolean {
      return runSessionsOperation(
        () => claimStepForStartRow(executor, id, startedAtMs),
        "console sessions repository claimStepForStart failed",
      );
    },
    finishStep(id: string, result: M3LSessionStepFinish): boolean {
      return runSessionsOperation(
        () => finishStepRow(executor, id, result),
        "console sessions repository finishStep failed",
      );
    },
    getStep(id: string): M3LSessionStepRecord | undefined {
      return runSessionsOperation(
        () => getStepRow(executor, id),
        "console sessions repository getStep failed",
      );
    },
    getStepByOrdinal(
      sessionId: string,
      ordinal: number,
    ): M3LSessionStepRecord | undefined {
      return runSessionsOperation(
        () => getStepByOrdinalRow(executor, sessionId, ordinal),
        "console sessions repository getStepByOrdinal failed",
      );
    },
    listStepsForSession(sessionId: string): readonly M3LSessionStepRecord[] {
      return runSessionsOperation(
        () => listStepsForSessionRows(executor, sessionId),
        "console sessions repository listStepsForSession failed",
      );
    },
  };
}

/** The `console_session_bindings`-scoped slice — see {@link buildSessionMethods}'s own TSDoc for why this is split out. */
function buildBindingMethods(
  executor: M3LStoreQueryExecutor,
): Pick<
  M3LConsoleSessionsRepository,
  "insertBinding" | "listBindingsForSession"
> {
  return {
    insertBinding(input: M3LSessionBindingInsert): void {
      runSessionsOperation(
        () => insertBindingRow(executor, input),
        "console sessions repository insertBinding failed",
      );
    },
    listBindingsForSession(
      sessionId: string,
    ): readonly M3LSessionBindingRecord[] {
      return runSessionsOperation(
        () => listBindingsForSessionRows(executor, sessionId),
        "console sessions repository listBindingsForSession failed",
      );
    },
  };
}

/** The `console_session_decisions`-scoped slice — see {@link buildSessionMethods}'s own TSDoc for why this is split out. */
function buildDecisionMethods(
  executor: M3LStoreQueryExecutor,
): Pick<
  M3LConsoleSessionsRepository,
  | "insertDecision"
  | "answerDecision"
  | "getDecision"
  | "listDecisionsForSession"
> {
  return {
    insertDecision(input: M3LSessionDecisionInsert): void {
      runSessionsOperation(
        () => insertDecisionRow(executor, input),
        "console sessions repository insertDecision failed",
      );
    },
    answerDecision(id: string, answer: M3LSessionDecisionAnswer): boolean {
      return runSessionsOperation(
        () => answerDecisionRow(executor, id, answer),
        "console sessions repository answerDecision failed",
      );
    },
    getDecision(id: string): M3LSessionDecisionRecord | undefined {
      return runSessionsOperation(
        () => getDecisionRow(executor, id),
        "console sessions repository getDecision failed",
      );
    },
    listDecisionsForSession(
      sessionId: string,
    ): readonly M3LSessionDecisionRecord[] {
      return runSessionsOperation(
        () => listDecisionsForSessionRows(executor, sessionId),
        "console sessions repository listDecisionsForSession failed",
      );
    },
  };
}

/**
 * Builds a {@link M3LConsoleSessionsRepository} over `executor`.
 *
 * @param executor - The {@link M3LStoreQueryExecutor} port this repository
 * reads and writes through — the top-level store's own executor, or a
 * transaction's, closed over rather than held as a class field.
 * @returns The {@link M3LConsoleSessionsRepository}.
 *
 * @example
 * ```ts
 * import { createStoreExecutor } from "@m3l-automation/m3l-console-server/store/executor";
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * const repository = createConsoleSessionsRepository(createStoreExecutor(database));
 * repository.insertSession({
 *   id: "session-1",
 *   operator: "alice",
 *   correlationId: "corr-1",
 *   createdAtMs: Date.now(),
 * });
 * ```
 */
export function createConsoleSessionsRepository(
  executor: M3LStoreQueryExecutor,
): M3LConsoleSessionsRepository {
  return {
    ...buildSessionMethods(executor),
    ...buildStepMethods(executor),
    ...buildBindingMethods(executor),
    ...buildDecisionMethods(executor),
  };
}
