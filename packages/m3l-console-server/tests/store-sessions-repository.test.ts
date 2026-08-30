/**
 * Tests for src/store/sessions-repository.ts — `M3LConsoleSessionsRepository`
 * (X6 workbench-sessions module, slice 1, ADR-0068/ADR-0069).
 *
 * RED: `store/sessions-repository.ts`, its v4 migration
 * (`store/migrations/registry.ts`'s `CONSOLE_MIGRATIONS`), and the five new
 * `M3LConsoleErrorCode` members it needs do not exist yet.
 *
 * Mirrors `tests/store-runs-repository.test.ts` almost line-for-line, per
 * the hub's explicit brief: `M3LConsoleSessionsRepository` is a plain set of
 * functions over the injected `M3LStoreQueryExecutor` port, never a class —
 * every test here builds its own executor directly over a real `:memory:`
 * `node:sqlite` database and applies `CONSOLE_MIGRATIONS`' own DDL
 * `statements` directly, rather than importing `store/store.ts` or
 * `store/executor.ts`, so this file's `perFile` v8 coverage binds only to
 * `store/sessions-repository.ts`, `store/run-status.ts`,
 * `store/migrations/registry.ts`, and `store/types.ts`/
 * `errors/console-error.ts` for types.
 *
 * Unlike `store-runs-repository.test.ts`'s fixture, `console_session_steps`
 * and `console_session_decisions` carry `REFERENCES` foreign keys — SQLite
 * only enforces those with `PRAGMA foreign_keys = ON`, which
 * `store/store.ts`'s real `openConsoleStore` sets before migrations run — so
 * this file's `createMigratedDatabase` replicates that one pragma (foreign
 * keys are irrelevant to WAL/synchronous, so those two are not replicated
 * here) to make the FK-rejection tests below meaningful.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import { RUN_TERMINAL_STATUSES } from "../src/store/run-status.js";
import type {
  M3LRunStatus,
  M3LRunTerminalStatus,
} from "../src/store/run-status.js";
import { createConsoleSessionsRepository } from "../src/store/sessions-repository.js";
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
} from "../src/store/sessions-repository.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
} from "../src/store/types.js";

// ---------------------------------------------------------------------------
// Raw executor + migrated-database fixtures — mirrors
// tests/store-runs-repository.test.ts's own helpers, duplicated locally.
// ---------------------------------------------------------------------------

interface RawStatementPort {
  all(...parameters: readonly unknown[]): Record<string, unknown>[];
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  run(...parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

function prepareRaw(database: DatabaseSync, sql: string): RawStatementPort {
  return database.prepare(sql);
}

function toStatementArguments(
  parameters: M3LStoreParameters | undefined,
): readonly unknown[] {
  if (parameters === undefined) return [];
  return Array.isArray(parameters) ? parameters : [parameters];
}

function createRawExecutor(database: DatabaseSync): M3LStoreQueryExecutor {
  return {
    all(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): readonly M3LStoreRow[] {
      const statement = prepareRaw(database, sql);
      const rows = statement.all(...toStatementArguments(parameters));
      return rows.map((row) => ({ ...row })) as readonly M3LStoreRow[];
    },
    get(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): M3LStoreRow | undefined {
      const statement = prepareRaw(database, sql);
      const row = statement.get(...toStatementArguments(parameters));
      return row === undefined ? undefined : ({ ...row } as M3LStoreRow);
    },
    run(sql: string, parameters?: M3LStoreParameters) {
      const statement = prepareRaw(database, sql);
      const result = statement.run(...toStatementArguments(parameters));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    script(sql: string): void {
      database.exec(sql);
    },
  };
}

/**
 * Applies every `CONSOLE_MIGRATIONS` DDL statement to a fresh `:memory:`
 * database, with `PRAGMA foreign_keys = ON` set first — replicating the one
 * pragma `store/store.ts`'s `openConsoleStore` sets before migrations that
 * this file's FK-rejection tests depend on. See this file's own
 * `@packageDocumentation`-style header for why.
 */
function createMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of CONSOLE_MIGRATIONS) {
    for (const statement of migration.statements) {
      database.exec(statement);
    }
  }
  return database;
}

function createRepository(
  database: DatabaseSync,
): M3LConsoleSessionsRepository {
  return createConsoleSessionsRepository(createRawExecutor(database));
}

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function readRawRow(
  database: DatabaseSync,
  table: string,
  id: string,
): Record<string, unknown> | undefined {
  const row = prepareRaw(database, `SELECT * FROM ${table} WHERE id = ?`).get(
    id,
  );
  return row === undefined ? undefined : { ...row };
}

function countRawRows(database: DatabaseSync, table: string): number {
  const row = prepareRaw(
    database,
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get();
  return Number(row?.["count"] ?? 0);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function sessionInsertInput(
  overrides: Partial<M3LSessionInsert> = {},
): M3LSessionInsert {
  const base: M3LSessionInsert = {
    id: "session-1",
    operator: "alice",
    correlationId: "corr-1",
    createdAtMs: 1_000,
  };
  return { ...base, ...overrides };
}

/** Inserts a session directly, returning its id — the common precondition every step/binding/decision fixture needs. */
function seedSession(
  repository: M3LConsoleSessionsRepository,
  overrides: Partial<M3LSessionInsert> = {},
): string {
  const input = sessionInsertInput(overrides);
  repository.insertSession(input);
  return input.id;
}

function stepInsertInput(
  sessionId: string,
  overrides: Partial<M3LSessionStepInsert> = {},
): M3LSessionStepInsert {
  const base: M3LSessionStepInsert = {
    id: "step-1",
    sessionId,
    ordinal: 0,
    operation: "scripts/example",
    parameters: { mode: "batch" },
    queuedAtMs: 1_000,
  };
  return { ...base, ...overrides };
}

/** Seeds a session, then a step in it, returning both ids. */
function seedSessionAndStep(
  repository: M3LConsoleSessionsRepository,
  overrides: Partial<M3LSessionStepInsert> = {},
): { readonly sessionId: string; readonly stepId: string } {
  const sessionId = seedSession(repository);
  const input = stepInsertInput(sessionId, overrides);
  repository.insertStep(input);
  return { sessionId, stepId: input.id };
}

/** Seeds a session + step, then claims the step, returning the startedAtMs used. */
function seedAndClaimStep(
  repository: M3LConsoleSessionsRepository,
  overrides: Partial<M3LSessionStepInsert> = {},
  startedAtMs = 1_500,
): { readonly sessionId: string; readonly stepId: string } {
  const { sessionId, stepId } = seedSessionAndStep(repository, overrides);
  const claimed = repository.claimStepForStart(stepId, startedAtMs);
  if (!claimed) {
    throw new Error("expected claimStepForStart to succeed in test setup");
  }
  return { sessionId, stepId };
}

/** Seeds, claims, then finishes a step with a given terminal outcome. */
function seedClaimAndFinishStep(
  repository: M3LConsoleSessionsRepository,
  overrides: Partial<M3LSessionStepInsert> = {},
  finish: M3LSessionStepFinish = { outcome: "success", endedAtMs: 2_000 },
): { readonly sessionId: string; readonly stepId: string } {
  const { sessionId, stepId } = seedAndClaimStep(repository, overrides);
  const finished = repository.finishStep(stepId, finish);
  if (!finished) {
    throw new Error("expected finishStep to succeed in test setup");
  }
  return { sessionId, stepId };
}

function bindingInsertInput(
  sessionId: string,
  overrides: Partial<M3LSessionBindingInsert> = {},
): M3LSessionBindingInsert {
  const base: M3LSessionBindingInsert = {
    id: "binding-1",
    sessionId,
    reference: "step-1.result",
    expectedType: "string",
    multiSelect: false,
    createdAtMs: 1_000,
  };
  return { ...base, ...overrides };
}

function decisionInsertInput(
  sessionId: string,
  stepId: string,
  overrides: Partial<M3LSessionDecisionInsert> = {},
): M3LSessionDecisionInsert {
  const base: M3LSessionDecisionInsert = {
    id: "decision-1",
    sessionId,
    stepId,
    prompt: "Proceed?",
    createdAtMs: 1_000,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// insertSession + getSession — round trip
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — insertSession + getSession round trip", () => {
  test("getSession() after insertSession() returns an open record, updatedAtMs equal to createdAtMs, closedAtMs undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insertSession(sessionInsertInput());
    const record = repository.getSession("session-1");

    expect(record).toEqual({
      id: "session-1",
      status: "open",
      operator: "alice",
      correlationId: "corr-1",
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      closedAtMs: undefined,
    });
  });

  test("getSession() on an unknown id returns undefined rather than throwing", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(() => repository.getSession("does-not-exist")).not.toThrow();
    expect(repository.getSession("does-not-exist")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listSessions — filtering, limit, and ordering
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — listSessions()", () => {
  function seedListFixture(repository: M3LConsoleSessionsRepository): void {
    repository.insertSession(
      sessionInsertInput({
        id: "session-c",
        operator: "alice",
        createdAtMs: 3_000,
      }),
    );
    repository.insertSession(
      sessionInsertInput({
        id: "session-a",
        operator: "alice",
        createdAtMs: 1_000,
      }),
    );
    repository.insertSession(
      sessionInsertInput({
        id: "session-b",
        operator: "bob",
        createdAtMs: 2_000,
      }),
    );
    repository.closeSession("session-b", 2_100);
  }

  test("returns open rows oldest-created-first regardless of insertion order", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.listSessions({ status: "open", limit: 10 });

    expect(results.map((record: M3LSessionRecord) => record.id)).toEqual([
      "session-a",
      "session-c",
    ]);
  });

  test("filters by status", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const closed = repository.listSessions({ status: "closed", limit: 10 });

    expect(closed.map((record: M3LSessionRecord) => record.id)).toEqual([
      "session-b",
    ]);
  });

  test("filters by operator", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const aliceSessions = repository.listSessions({
      operator: "alice",
      limit: 10,
    });

    expect(
      aliceSessions.map((record: M3LSessionRecord) => record.id).sort(),
    ).toEqual(["session-a", "session-c"]);
  });

  test("filters by both status and operator together", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.listSessions({
      status: "open",
      operator: "alice",
      limit: 10,
    });

    expect(results.map((record: M3LSessionRecord) => record.id)).toEqual([
      "session-a",
      "session-c",
    ]);
  });

  test("respects limit, still returning the oldest matches first", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.listSessions({ status: "open", limit: 1 });

    expect(results.map((record: M3LSessionRecord) => record.id)).toEqual([
      "session-a",
    ]);
  });

  test("limit: 0 returns an empty list, not every matching row", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    expect(repository.listSessions({ status: "open", limit: 0 })).toEqual([]);
  });

  test("with no status/operator filter, returns every row up to limit", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    expect(repository.listSessions({ limit: 10 })).toHaveLength(3);
  });

  test("limit: -1 throws ERR_CONSOLE_BAD_REQUEST rather than returning every matching row unbounded", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const thrown = captureFailure(() =>
      repository.listSessions({ status: "open", limit: -1 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("a non-integer limit (1.5) throws ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const thrown = captureFailure(() =>
      repository.listSessions({ status: "open", limit: 1.5 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// closeSession / reopenSession — guarded FSM transitions
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — closeSession()", () => {
  test("on an open session: returns true, sets status closed, closedAtMs and updatedAtMs to the given value", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);

    const closed = repository.closeSession("session-1", 5_000);

    expect(closed).toBe(true);
    const record = repository.getSession("session-1");
    expect(record?.status).toBe("closed");
    expect(record?.closedAtMs).toBe(5_000);
    expect(record?.updatedAtMs).toBe(5_000);
  });

  test("on an already-closed session: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);
    repository.closeSession("session-1", 5_000);
    const before = readRawRow(database, "console_sessions", "session-1");

    const closedAgain = repository.closeSession("session-1", 9_999);

    expect(closedAgain).toBe(false);
    expect(readRawRow(database, "console_sessions", "session-1")).toEqual(
      before,
    );
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.closeSession("does-not-exist", 1_000)).toBe(false);
  });

  test("two competing closeSession calls for the same open session: exactly one succeeds, neither throws — a real guarded race", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);

    const firstCallerWon = repository.closeSession("session-1", 5_000);
    const secondCallerWon = repository.closeSession("session-1", 6_000);

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
    expect(repository.getSession("session-1")?.closedAtMs).toBe(5_000);
  });
});

describe("createConsoleSessionsRepository — reopenSession()", () => {
  test("on a closed session: returns true, sets status open, clears closedAtMs, and sets updatedAtMs", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);
    repository.closeSession("session-1", 5_000);

    const reopened = repository.reopenSession("session-1", 8_000);

    expect(reopened).toBe(true);
    const record = repository.getSession("session-1");
    expect(record?.status).toBe("open");
    expect(record?.closedAtMs).toBeUndefined();
    expect(record?.updatedAtMs).toBe(8_000);
  });

  test("on an already-open session: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);
    const before = readRawRow(database, "console_sessions", "session-1");

    const reopened = repository.reopenSession("session-1", 8_000);

    expect(reopened).toBe(false);
    expect(readRawRow(database, "console_sessions", "session-1")).toEqual(
      before,
    );
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.reopenSession("does-not-exist", 1_000)).toBe(false);
  });

  test("two competing reopenSession calls for the same closed session: exactly one succeeds, neither throws", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository);
    repository.closeSession("session-1", 5_000);

    const firstCallerWon = repository.reopenSession("session-1", 8_000);
    const secondCallerWon = repository.reopenSession("session-1", 9_000);

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// insertStep + get round trip, ordinal lookup, listing
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — insertStep + getStep round trip", () => {
  test("getStep() after insertStep() returns a queued record with every pending field undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    repository.insertStep(stepInsertInput(sessionId));
    const record = repository.getStep("step-1");

    expect(record).toEqual({
      id: "step-1",
      sessionId,
      ordinal: 0,
      operation: "scripts/example",
      parameters: { mode: "batch" },
      runId: undefined,
      status: "queued",
      resultRef: undefined,
      queuedAtMs: 1_000,
      startedAtMs: undefined,
      endedAtMs: undefined,
      outcome: undefined,
      failureMessage: undefined,
    });
  });

  test("parameters round-trips through parameters_json as a structurally equal object", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);
    const parameters = { mode: "batch", nested: { a: 1, b: [1, 2] } };

    repository.insertStep(stepInsertInput(sessionId, { parameters }));

    expect(repository.getStep("step-1")?.parameters).toEqual(parameters);
  });

  test("getStep() on an unknown id returns undefined rather than throwing", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.getStep("does-not-exist")).toBeUndefined();
  });

  test("getStepByOrdinal() returns the matching step within a session", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-0", ordinal: 0 }),
    );
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-1", ordinal: 1 }),
    );

    expect(repository.getStepByOrdinal(sessionId, 1)?.id).toBe("step-1");
  });

  test("getStepByOrdinal() returns undefined for an ordinal with no matching row", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-0", ordinal: 0 }),
    );

    expect(repository.getStepByOrdinal(sessionId, 5)).toBeUndefined();
  });

  test("insertStep referencing a nonexistent session_id is rejected by the FOREIGN KEY constraint", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insertStep(stepInsertInput("session-does-not-exist")),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(countRawRows(database, "console_session_steps")).toBe(0);
  });

  test("a duplicate (session_id, ordinal) pair is rejected by the UNIQUE constraint", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-first", ordinal: 0 }),
    );

    const thrown = captureFailure(() =>
      repository.insertStep(
        stepInsertInput(sessionId, { id: "step-second", ordinal: 0 }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });
});

describe("createConsoleSessionsRepository — insertStep() parameters validation", () => {
  test("parameters containing a cycle throws ERR_CONSOLE_BAD_REQUEST rather than persisting a placeholder", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);
    const parameters: Record<string, unknown> = { mode: "batch" };
    parameters["self"] = parameters;

    const thrown = captureFailure(() =>
      repository.insertStep(stepInsertInput(sessionId, { parameters })),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(
      readRawRow(database, "console_session_steps", "step-1"),
    ).toBeUndefined();
  });

  test("parameters containing a function value throws ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    const thrown = captureFailure(() =>
      repository.insertStep(
        stepInsertInput(sessionId, {
          parameters: { callback: () => "unused" },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(
      readRawRow(database, "console_session_steps", "step-1"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimStepForStart — the guarded queued -> running transition
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — claimStepForStart()", () => {
  test("on a queued step: returns true and sets status to running with the given startedAtMs", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    const claimed = repository.claimStepForStart(stepId, 1_500);

    expect(claimed).toBe(true);
    const record = repository.getStep(stepId);
    expect(record?.status).toBe("running");
    expect(record?.startedAtMs).toBe(1_500);
  });

  test("on a step already running: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedAndClaimStep(repository);
    const before = readRawRow(database, "console_session_steps", stepId);

    const claimed = repository.claimStepForStart(stepId, 9_999);

    expect(claimed).toBe(false);
    expect(readRawRow(database, "console_session_steps", stepId)).toEqual(
      before,
    );
  });

  test("on a terminal step: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedClaimAndFinishStep(repository);
    const before = readRawRow(database, "console_session_steps", stepId);

    const claimed = repository.claimStepForStart(stepId, 9_999);

    expect(claimed).toBe(false);
    expect(readRawRow(database, "console_session_steps", stepId)).toEqual(
      before,
    );
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.claimStepForStart("does-not-exist", 1_000)).toBe(false);
  });

  test("two competing claimStepForStart calls for the same queued step: exactly one succeeds — a real guarded race", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    const firstCallerWon = repository.claimStepForStart(stepId, 1_100);
    const secondCallerWon = repository.claimStepForStart(stepId, 1_200);

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
    expect(repository.getStep(stepId)?.startedAtMs).toBe(1_100);
  });
});

// ---------------------------------------------------------------------------
// finishStep — the guarded running -> terminal transition
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — finishStep()", () => {
  test("on a running step: returns true and sets outcome, endedAtMs, resultRef, and failureMessage", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedAndClaimStep(repository);

    const finished = repository.finishStep(stepId, {
      outcome: "failure",
      endedAtMs: 2_500,
      resultRef: "s3://bucket/result.json",
      failureMessage: "boom",
    });

    expect(finished).toBe(true);
    const record = repository.getStep(stepId);
    expect(record?.status).toBe("failure");
    expect(record?.outcome).toBe("failure");
    expect(record?.endedAtMs).toBe(2_500);
    expect(record?.resultRef).toBe("s3://bucket/result.json");
    expect(record?.failureMessage).toBe("boom");
  });

  test("on a running step finished without optional fields: resultRef and failureMessage remain undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedAndClaimStep(repository);

    const finished = repository.finishStep(stepId, {
      outcome: "success",
      endedAtMs: 2_500,
    });

    expect(finished).toBe(true);
    const record = repository.getStep(stepId);
    expect(record?.resultRef).toBeUndefined();
    expect(record?.failureMessage).toBeUndefined();
  });

  test("on a queued step (never started): returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);
    const before = readRawRow(database, "console_session_steps", stepId);

    const finished = repository.finishStep(stepId, {
      outcome: "success",
      endedAtMs: 2_000,
    });

    expect(finished).toBe(false);
    expect(readRawRow(database, "console_session_steps", stepId)).toEqual(
      before,
    );
  });

  test("on an already-terminal step: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedClaimAndFinishStep(repository);
    const before = readRawRow(database, "console_session_steps", stepId);

    const finished = repository.finishStep(stepId, {
      outcome: "failure",
      endedAtMs: 9_000,
    });

    expect(finished).toBe(false);
    expect(readRawRow(database, "console_session_steps", stepId)).toEqual(
      before,
    );
  });

  test.each(RUN_TERMINAL_STATUSES.map((status) => [status] as const))(
    "sets status equal to outcome for terminal status %s",
    (status: M3LRunTerminalStatus) => {
      const database = createMigratedDatabase();
      const repository = createRepository(database);
      const { stepId } = seedAndClaimStep(repository, {
        id: `step-outcome-${status}`,
      });

      const finished = repository.finishStep(stepId, {
        outcome: status,
        endedAtMs: 3_000,
      });

      expect(finished).toBe(true);
      const record = repository.getStep(stepId);
      expect(record?.status).toBe(status);
      expect(record?.outcome).toBe(status);
    },
  );
});

// ---------------------------------------------------------------------------
// listStepsForSession — ordinal ordering, scoped to session
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — listStepsForSession()", () => {
  test("returns rows ordinal-ASC regardless of insertion order, scoped to the given session", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository, { id: "session-target" });
    const otherSessionId = seedSession(repository, { id: "session-other" });
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-2", ordinal: 2 }),
    );
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-0", ordinal: 0 }),
    );
    repository.insertStep(
      stepInsertInput(sessionId, { id: "step-1", ordinal: 1 }),
    );
    repository.insertStep(
      stepInsertInput(otherSessionId, { id: "step-other", ordinal: 0 }),
    );

    const results = repository.listStepsForSession(sessionId);

    expect(results.map((record: M3LSessionStepRecord) => record.id)).toEqual([
      "step-0",
      "step-1",
      "step-2",
    ]);
  });

  test("returns an empty array for a session with no steps", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    expect(repository.listStepsForSession(sessionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// attachStepRun — the guarded one-shot run_id attach (X6 slice 4, Part A)
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — attachStepRun()", () => {
  test("on a step with no run_id yet: returns true and sets runId to the given value", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    const attached = repository.attachStepRun(stepId, "run-1");

    expect(attached).toBe(true);
    expect(repository.getStep(stepId)?.runId).toBe("run-1");
  });

  test("on a step already attached to a run: returns false and leaves runId unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);
    repository.attachStepRun(stepId, "run-1");

    const attachedAgain = repository.attachStepRun(stepId, "run-2");

    expect(attachedAgain).toBe(false);
    expect(repository.getStep(stepId)?.runId).toBe("run-1");
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.attachStepRun("does-not-exist", "run-1")).toBe(false);
  });

  test("two competing attachStepRun calls for the same step: exactly one succeeds — a real guarded race", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    const firstCallerWon = repository.attachStepRun(stepId, "run-first");
    const secondCallerWon = repository.attachStepRun(stepId, "run-second");

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
    expect(repository.getStep(stepId)?.runId).toBe("run-first");
  });
});

// ---------------------------------------------------------------------------
// getStepByRunId — read path for the attached run_id (X6 slice 4, Part A)
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — getStepByRunId()", () => {
  test("returns the step attached to the given run id", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);
    repository.attachStepRun(stepId, "run-target");

    expect(repository.getStepByRunId("run-target")?.id).toBe(stepId);
  });

  test("returns undefined for a run id with no attached step", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.getStepByRunId("does-not-exist")).toBeUndefined();
  });

  test("returns undefined for a step's own id (never confuses step id with run id)", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    expect(repository.getStepByRunId(stepId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// insertBinding + listBindingsForSession
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — insertBinding() and listBindingsForSession()", () => {
  test("round-trips multiSelect: false as boolean false, stored as INTEGER 0", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    repository.insertBinding(
      bindingInsertInput(sessionId, {
        id: "binding-false",
        multiSelect: false,
      }),
    );

    expect(
      readRawRow(database, "console_session_bindings", "binding-false")?.[
        "multi_select"
      ],
    ).toBe(0);
  });

  test("round-trips multiSelect: true as boolean true, stored as INTEGER 1", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    repository.insertBinding(
      bindingInsertInput(sessionId, { id: "binding-true", multiSelect: true }),
    );

    expect(
      readRawRow(database, "console_session_bindings", "binding-true")?.[
        "multi_select"
      ],
    ).toBe(1);
  });

  test("listBindingsForSession returns rows createdAtMs-ASC, scoped to the given session", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository, { id: "session-target" });
    const otherSessionId = seedSession(repository, { id: "session-other" });
    repository.insertBinding(
      bindingInsertInput(sessionId, { id: "binding-b", createdAtMs: 2_000 }),
    );
    repository.insertBinding(
      bindingInsertInput(sessionId, { id: "binding-a", createdAtMs: 1_000 }),
    );
    repository.insertBinding(
      bindingInsertInput(otherSessionId, { id: "binding-other" }),
    );

    const results = repository.listBindingsForSession(sessionId);

    expect(results.map((record: M3LSessionBindingRecord) => record.id)).toEqual(
      ["binding-a", "binding-b"],
    );
  });

  test("insertBinding referencing a nonexistent session_id is rejected by the FOREIGN KEY constraint", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insertBinding(bindingInsertInput("session-does-not-exist")),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(countRawRows(database, "console_session_bindings")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// insertDecision + answerDecision + getDecision + listDecisionsForSession
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — insertDecision + getDecision round trip", () => {
  test("getDecision() after insertDecision() returns a pending record, options/answer/answeredAtMs undefined when omitted", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { sessionId, stepId } = seedSessionAndStep(repository);

    repository.insertDecision(decisionInsertInput(sessionId, stepId));
    const record = repository.getDecision("decision-1");

    expect(record).toEqual({
      id: "decision-1",
      sessionId,
      stepId,
      prompt: "Proceed?",
      options: undefined,
      status: "pending",
      answer: undefined,
      createdAtMs: 1_000,
      answeredAtMs: undefined,
    });
  });

  test("options round-trips through options_json as a structurally equal value when supplied", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { sessionId, stepId } = seedSessionAndStep(repository);
    const options = ["yes", "no"];

    repository.insertDecision(
      decisionInsertInput(sessionId, stepId, { options }),
    );

    expect(repository.getDecision("decision-1")?.options).toEqual(options);
  });

  test("getDecision() on an unknown id returns undefined rather than throwing", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.getDecision("does-not-exist")).toBeUndefined();
  });

  test("insertDecision referencing a nonexistent step_id is rejected by the FOREIGN KEY constraint", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    const thrown = captureFailure(() =>
      repository.insertDecision(
        decisionInsertInput(sessionId, "step-does-not-exist"),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(countRawRows(database, "console_session_decisions")).toBe(0);
  });

  test("insertDecision referencing a nonexistent session_id is rejected by the FOREIGN KEY constraint", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { stepId } = seedSessionAndStep(repository);

    const thrown = captureFailure(() =>
      repository.insertDecision(
        decisionInsertInput("session-does-not-exist", stepId),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });
});

describe("createConsoleSessionsRepository — insertDecision() options validation", () => {
  test("options containing a cycle throws ERR_CONSOLE_BAD_REQUEST rather than persisting a placeholder", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { sessionId, stepId } = seedSessionAndStep(repository);
    const options: Record<string, unknown> = { choices: [] };
    options["self"] = options;

    const thrown = captureFailure(() =>
      repository.insertDecision(
        decisionInsertInput(sessionId, stepId, { options }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(
      readRawRow(database, "console_session_decisions", "decision-1"),
    ).toBeUndefined();
  });

  test("options containing a function value throws ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { sessionId, stepId } = seedSessionAndStep(repository);

    const thrown = captureFailure(() =>
      repository.insertDecision(
        decisionInsertInput(sessionId, stepId, {
          options: { callback: () => "unused" },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

describe("createConsoleSessionsRepository — answerDecision()", () => {
  function seedDecision(repository: M3LConsoleSessionsRepository): {
    readonly sessionId: string;
    readonly stepId: string;
    readonly decisionId: string;
  } {
    const { sessionId, stepId } = seedSessionAndStep(repository);
    const input = decisionInsertInput(sessionId, stepId);
    repository.insertDecision(input);
    return { sessionId, stepId, decisionId: input.id };
  }

  test("on a pending decision: returns true and sets status answered, answer, and answeredAtMs", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { decisionId } = seedDecision(repository);

    const answered = repository.answerDecision(decisionId, {
      answer: "yes",
      answeredAtMs: 4_000,
    });

    expect(answered).toBe(true);
    const record = repository.getDecision(decisionId);
    expect(record?.status).toBe("answered");
    expect(record?.answer).toBe("yes");
    expect(record?.answeredAtMs).toBe(4_000);
  });

  test("on an already-answered decision: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { decisionId } = seedDecision(repository);
    repository.answerDecision(decisionId, {
      answer: "yes",
      answeredAtMs: 4_000,
    });
    const before = readRawRow(
      database,
      "console_session_decisions",
      decisionId,
    );

    const answeredAgain = repository.answerDecision(decisionId, {
      answer: "no",
      answeredAtMs: 5_000,
    });

    expect(answeredAgain).toBe(false);
    expect(
      readRawRow(database, "console_session_decisions", decisionId),
    ).toEqual(before);
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(
      repository.answerDecision("does-not-exist", {
        answer: "yes",
        answeredAtMs: 1_000,
      }),
    ).toBe(false);
  });

  test("two competing answerDecision calls for the same pending decision: exactly one succeeds — a real guarded race", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { decisionId } = seedDecision(repository);

    const firstCallerWon = repository.answerDecision(decisionId, {
      answer: "first",
      answeredAtMs: 4_000,
    });
    const secondCallerWon = repository.answerDecision(decisionId, {
      answer: "second",
      answeredAtMs: 5_000,
    });

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
    expect(repository.getDecision(decisionId)?.answer).toBe("first");
  });

  test("an answer containing a cycle throws ERR_CONSOLE_BAD_REQUEST rather than persisting a placeholder", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { decisionId } = seedDecision(repository);
    const answer: Record<string, unknown> = { choice: "yes" };
    answer["self"] = answer;

    const thrown = captureFailure(() =>
      repository.answerDecision(decisionId, { answer, answeredAtMs: 4_000 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.getDecision(decisionId)?.status).toBe("pending");
  });
});

describe("createConsoleSessionsRepository — listDecisionsForSession()", () => {
  test("returns rows createdAtMs-ASC, scoped to the given session", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { sessionId, stepId } = seedSessionAndStep(repository, {
      id: "step-target",
    });
    const otherSessionId = seedSession(repository, { id: "session-other" });
    repository.insertStep(
      stepInsertInput(otherSessionId, { id: "step-other", ordinal: 0 }),
    );
    repository.insertDecision(
      decisionInsertInput(sessionId, stepId, {
        id: "decision-b",
        createdAtMs: 2_000,
      }),
    );
    repository.insertDecision(
      decisionInsertInput(sessionId, stepId, {
        id: "decision-a",
        createdAtMs: 1_000,
      }),
    );
    repository.insertDecision(
      decisionInsertInput(otherSessionId, "step-other", {
        id: "decision-other",
      }),
    );

    const results = repository.listDecisionsForSession(sessionId);

    expect(
      results.map((record: M3LSessionDecisionRecord) => record.id),
    ).toEqual(["decision-a", "decision-b"]);
  });

  test("returns an empty array for a session with no decisions", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const sessionId = seedSession(repository);

    expect(repository.listDecisionsForSession(sessionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countOpenSessions
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — countOpenSessions()", () => {
  test("returns 0 for an empty store", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.countOpenSessions()).toBe(0);
  });

  test("counts only open sessions, updating as sessions close and reopen", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedSession(repository, { id: "session-a" });
    seedSession(repository, { id: "session-b" });
    seedSession(repository, { id: "session-c" });

    expect(repository.countOpenSessions()).toBe(3);

    repository.closeSession("session-b", 2_000);
    expect(repository.countOpenSessions()).toBe(2);

    repository.reopenSession("session-b", 3_000);
    expect(repository.countOpenSessions()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Failure mapping — a closed database
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — a closed database", () => {
  test("getSession() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() => repository.getSession("session-1"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });

  test("listSessions() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() => repository.listSessions({ limit: 10 }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });

  test("insertSession() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() =>
      repository.insertSession(sessionInsertInput()),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe("createConsoleSessionsRepository — type contract", () => {
  test("is a function over M3LStoreQueryExecutor, never a class holding a DatabaseSync", () => {
    expectTypeOf(createConsoleSessionsRepository)
      .parameter(0)
      .toMatchTypeOf<M3LStoreQueryExecutor>();
    expectTypeOf(
      createConsoleSessionsRepository,
    ).returns.toMatchTypeOf<M3LConsoleSessionsRepository>();
  });

  test("M3LConsoleSessionsRepository exposes exactly the documented method set", () => {
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "insertSession",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("getSession");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("listSessions");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("closeSession");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "reopenSession",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("insertStep");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "claimStepForStart",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("finishStep");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("getStep");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "getStepByOrdinal",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "listStepsForSession",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "insertBinding",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "listBindingsForSession",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "insertDecision",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "answerDecision",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty("getDecision");
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "listDecisionsForSession",
    );
    expectTypeOf<M3LConsoleSessionsRepository>().toHaveProperty(
      "countOpenSessions",
    );
  });

  test("M3LSessionListQuery requires limit but status/operator are optional", () => {
    const withLimitOnly: M3LSessionListQuery = { limit: 5 };
    const withEverything: M3LSessionListQuery = {
      status: "open",
      operator: "alice",
      limit: 5,
    };

    expect(withLimitOnly.limit).toBe(5);
    expect(withEverything.status).toBe("open");
  });

  test("M3LSessionStepRecord.status shares M3LRunStatus, and outcome shares M3LRunTerminalStatus | undefined", () => {
    expectTypeOf<
      M3LSessionStepRecord["status"]
    >().toMatchTypeOf<M3LRunStatus>();
    expectTypeOf<M3LSessionStepRecord["outcome"]>().toEqualTypeOf<
      M3LRunTerminalStatus | undefined
    >();
  });

  test("M3LSessionDecisionAnswer requires answer and answeredAtMs", () => {
    const answer: M3LSessionDecisionAnswer = {
      answer: "yes",
      answeredAtMs: 1_000,
    };

    expect(answer.answeredAtMs).toBe(1_000);
  });
});
