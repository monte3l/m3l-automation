/**
 * Tests for src/store/runs-repository.ts — `M3LConsoleRunsRepository`
 * (X4 run-registry, slice 3b).
 *
 * `M3LConsoleRunsRepository` is a set of functions over the
 * {@link M3LStoreQueryExecutor} port, never a class holding a `DatabaseSync`
 * — exactly the shape `store/meta-repository.ts` established. Every test
 * here therefore builds its own executor directly over a real `:memory:`
 * `node:sqlite` database and applies `CONSOLE_MIGRATIONS`' own DDL
 * `statements` directly (the same fixture pattern
 * `tests/store-meta-repository.test.ts` and `tests/store-migrations.test.ts`
 * use), rather than importing `store/store.ts` or `store/executor.ts` — this
 * file's `perFile` v8 coverage must bind only to `store/runs-repository.ts`,
 * `store/run-status.ts`, `store/migrations/registry.ts`, and
 * `store/types.ts`/`errors/console-error.ts` for types, never to a sibling
 * slice's implementation.
 *
 * No dedicated `store-runs-row.test.ts` file: the row <-> record mapping
 * (the `dry_run` INTEGER<->boolean cast, `parameters_json`<->object,
 * optional-column<->`| undefined`) is a thin facet fully exercised by this
 * file's insert+get round-trip tests below — it does not warrant its own
 * fixture/coverage-boundary story the way, say, an AWS response-mapper does.
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
import { createConsoleRunsRepository } from "../src/store/runs-repository.js";
import type {
  M3LConsoleRunsRepository,
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../src/store/runs-repository.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
} from "../src/store/types.js";

// ---------------------------------------------------------------------------
// Raw executor + migrated-database fixtures — mirrors
// tests/store-meta-repository.test.ts's own helpers, duplicated locally
// rather than imported, to keep this file's coverage bound to its own slice
// and independent of that sibling file's internals.
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

/**
 * Builds a real {@link M3LStoreQueryExecutor} directly over a `node:sqlite`
 * `DatabaseSync` — no `store/executor.ts` import, so this file's coverage
 * stays bound to its own slice. A closed `database` naturally makes every
 * method below throw the real `ERR_INVALID_STATE` node:sqlite raises; no
 * fake is needed for that path.
 */
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

/** Applies every `CONSOLE_MIGRATIONS` DDL statement to a fresh `:memory:` database. */
function createMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of CONSOLE_MIGRATIONS) {
    for (const statement of migration.statements) {
      database.exec(statement);
    }
  }
  return database;
}

function createRepository(database: DatabaseSync): M3LConsoleRunsRepository {
  return createConsoleRunsRepository(createRawExecutor(database));
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

/** Reads one raw `console_runs` row by `id`, exactly as persisted — the ground truth every "unchanged" assertion below compares against. */
function readRawRun(
  database: DatabaseSync,
  id: string,
): Record<string, unknown> | undefined {
  const row = prepareRaw(
    database,
    "SELECT * FROM console_runs WHERE id = ?",
  ).get(id);
  return row === undefined ? undefined : { ...row };
}

function countRawRows(database: DatabaseSync): number {
  const row = prepareRaw(
    database,
    "SELECT COUNT(*) AS count FROM console_runs",
  ).get();
  return Number(row?.["count"] ?? 0);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function insertInput(overrides: Partial<M3LRunInsert> = {}): M3LRunInsert {
  const base: M3LRunInsert = {
    id: "run-1",
    script: "scripts/example",
    dryRun: false,
    executionMode: "spawn",
    parameters: { mode: "batch", count: 3 },
    operator: "alice",
    correlationId: "corr-1",
    queuedAtMs: 1_000,
  };
  return { ...base, ...overrides };
}

/** Inserts a queued run and immediately claims it, returning the `startedAtMs` used. */
function insertAndClaim(
  repository: M3LConsoleRunsRepository,
  overrides: Partial<M3LRunInsert> = {},
  startedAtMs = 1_500,
): { readonly id: string; readonly startedAtMs: number } {
  const input = insertInput(overrides);
  repository.insertQueued(input);
  const claimed = repository.claimForStart(input.id, startedAtMs);
  if (!claimed) {
    throw new Error("expected claimForStart to succeed in test setup");
  }
  return { id: input.id, startedAtMs };
}

/** Inserts a queued run, claims it, then finishes it with a given terminal outcome. */
function insertAndFinish(
  repository: M3LConsoleRunsRepository,
  overrides: Partial<M3LRunInsert> = {},
  finish: M3LRunFinish = { outcome: "success", endedAtMs: 2_000 },
): string {
  const { id } = insertAndClaim(repository, overrides);
  const finished = repository.finish(id, finish);
  if (!finished) {
    throw new Error("expected finish to succeed in test setup");
  }
  return id;
}

// ---------------------------------------------------------------------------
// insertQueued + get — round trip
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — insertQueued + get round trip", () => {
  test("get() after insertQueued() returns the queued record with every pending field undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insertQueued(insertInput());
    const record = repository.get("run-1");

    expect(record).toEqual({
      id: "run-1",
      script: "scripts/example",
      status: "queued",
      dryRun: false,
      executionMode: "spawn",
      parameters: { mode: "batch", count: 3 },
      operator: "alice",
      correlationId: "corr-1",
      queuedAtMs: 1_000,
      startedAtMs: undefined,
      endedAtMs: undefined,
      outcome: undefined,
      exitCode: undefined,
      failureMessage: undefined,
    });
  });

  test("dryRun: false round-trips as boolean false, stored as INTEGER 0 — not a truthy 0", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insertQueued(
      insertInput({ id: "run-dry-false", dryRun: false }),
    );

    expect(readRawRun(database, "run-dry-false")?.["dry_run"]).toBe(0);
    expect(repository.get("run-dry-false")?.dryRun).toBe(false);
  });

  test("dryRun: true round-trips as boolean true, stored as INTEGER 1", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insertQueued(insertInput({ id: "run-dry-true", dryRun: true }));

    expect(readRawRun(database, "run-dry-true")?.["dry_run"]).toBe(1);
    expect(repository.get("run-dry-true")?.dryRun).toBe(true);
  });

  test("parameters round-trips through parameters_json as a structurally equal object, including nested values", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const parameters = { mode: "batch", count: 3, nested: { a: 1, b: [1, 2] } };

    repository.insertQueued(insertInput({ id: "run-params", parameters }));

    expect(repository.get("run-params")?.parameters).toEqual(parameters);
  });

  test("get() on an unknown id returns undefined rather than throwing", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(() => repository.get("does-not-exist")).not.toThrow();
    expect(repository.get("does-not-exist")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimForStart — the guarded queued -> running transition
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — claimForStart()", () => {
  test("on a queued run: returns true and sets status to running with the given startedAtMs", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(insertInput({ id: "run-claim" }));

    const claimed = repository.claimForStart("run-claim", 1_500);

    expect(claimed).toBe(true);
    const record = repository.get("run-claim");
    expect(record?.status).toBe("running");
    expect(record?.startedAtMs).toBe(1_500);
  });

  test("on a run already running: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { id } = insertAndClaim(repository, { id: "run-already-running" });
    const before = readRawRun(database, id);

    const claimed = repository.claimForStart(id, 9_999);

    expect(claimed).toBe(false);
    expect(readRawRun(database, id)).toEqual(before);
  });

  test("on a terminal run: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const id = insertAndFinish(repository, { id: "run-terminal-claim" });
    const before = readRawRun(database, id);

    const claimed = repository.claimForStart(id, 9_999);

    expect(claimed).toBe(false);
    expect(readRawRun(database, id)).toEqual(before);
  });

  test("on an unknown id: returns false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.claimForStart("does-not-exist", 1_000)).toBe(false);
  });

  test("two competing claimForStart calls for the same queued run: exactly one succeeds — a real guarded race, not a simulated pre-set state", () => {
    // Deliberately does NOT pre-set the row to "running" via raw SQL before
    // asserting the second call fails (that would be the simulated case
    // covered by "on a run already running" above). Both calls here go
    // through the real claimForStart, and it is the SECOND call's own
    // guarded `WHERE status = 'queued'` that must find zero matching rows —
    // the exact "rejected loudly, never silently dropped" guarantee an
    // orchestrator relies on to turn a lost race into a typed error.
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(insertInput({ id: "run-race" }));

    const firstCallerWon = repository.claimForStart("run-race", 1_100);
    const secondCallerWon = repository.claimForStart("run-race", 1_200);

    expect([firstCallerWon, secondCallerWon].filter(Boolean)).toHaveLength(1);
    expect(firstCallerWon).toBe(true);
    expect(secondCallerWon).toBe(false);
    // The winner's startedAtMs sticks; the loser's attempted value is discarded.
    expect(repository.get("run-race")?.startedAtMs).toBe(1_100);
  });
});

// ---------------------------------------------------------------------------
// finish — the guarded running -> terminal transition
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — finish()", () => {
  test("on a running run: returns true and sets outcome, endedAtMs, exitCode, and failureMessage", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { id } = insertAndClaim(repository, { id: "run-finish" });

    const finished = repository.finish(id, {
      outcome: "failure",
      endedAtMs: 2_500,
      exitCode: 1,
      failureMessage: "boom",
    });

    expect(finished).toBe(true);
    const record = repository.get(id);
    expect(record?.status).toBe("failure");
    expect(record?.outcome).toBe("failure");
    expect(record?.endedAtMs).toBe(2_500);
    expect(record?.exitCode).toBe(1);
    expect(record?.failureMessage).toBe("boom");
  });

  test("on a running run finished without optional fields: exitCode and failureMessage remain undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { id } = insertAndClaim(repository, { id: "run-finish-minimal" });

    const finished = repository.finish(id, {
      outcome: "success",
      endedAtMs: 2_500,
    });

    expect(finished).toBe(true);
    const record = repository.get(id);
    expect(record?.exitCode).toBeUndefined();
    expect(record?.failureMessage).toBeUndefined();
  });

  test("on a queued run (never started): returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(insertInput({ id: "run-finish-queued" }));
    const before = readRawRun(database, "run-finish-queued");

    const finished = repository.finish("run-finish-queued", {
      outcome: "success",
      endedAtMs: 2_000,
    });

    expect(finished).toBe(false);
    expect(readRawRun(database, "run-finish-queued")).toEqual(before);
  });

  test("on an already-terminal run: returns false and leaves the row byte-for-byte unchanged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const id = insertAndFinish(repository, { id: "run-finish-terminal" });
    const before = readRawRun(database, id);

    const finished = repository.finish(id, {
      outcome: "failure",
      endedAtMs: 9_000,
    });

    expect(finished).toBe(false);
    expect(readRawRun(database, id)).toEqual(before);
  });

  test.each(RUN_TERMINAL_STATUSES.map((status) => [status] as const))(
    "sets status equal to outcome for terminal status %s",
    (status: M3LRunTerminalStatus) => {
      const database = createMigratedDatabase();
      const repository = createRepository(database);
      const { id } = insertAndClaim(repository, {
        id: `run-outcome-${status}`,
      });

      const finished = repository.finish(id, {
        outcome: status,
        endedAtMs: 3_000,
      });

      expect(finished).toBe(true);
      const record = repository.get(id);
      expect(record?.status).toBe(status);
      expect(record?.outcome).toBe(status);
    },
  );

  test("finish with endedAtMs before the run's startedAtMs surfaces a typed store failure, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const { id } = insertAndClaim(repository, { id: "run-bad-ended" }, 5_000);

    const thrown = captureFailure(() =>
      repository.finish(id, { outcome: "success", endedAtMs: 1_000 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    // The rejected write must not have partially applied.
    const record = repository.get(id);
    expect(record?.status).toBe("running");
    expect(record?.endedAtMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list — filtering, limit, and ordering
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — list()", () => {
  function seedListFixture(repository: M3LConsoleRunsRepository): void {
    // Inserted deliberately OUT of queued_at_ms order, so an implementation
    // that merely returns insertion order (rather than ordering explicitly)
    // cannot coincidentally pass the oldest-first assertion below.
    repository.insertQueued(
      insertInput({
        id: "run-c",
        script: "scripts/alpha",
        queuedAtMs: 3_000,
      }),
    );
    repository.insertQueued(
      insertInput({
        id: "run-a",
        script: "scripts/alpha",
        queuedAtMs: 1_000,
      }),
    );
    repository.insertQueued(
      insertInput({
        id: "run-b",
        script: "scripts/beta",
        queuedAtMs: 2_000,
      }),
    );
    repository.claimForStart("run-b", 2_100);
  }

  test("returns queued rows oldest-queued-first regardless of insertion order", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.list({ status: "queued", limit: 10 });

    expect(results.map((record: M3LRunRecord) => record.id)).toEqual([
      "run-a",
      "run-c",
    ]);
  });

  test("filters by status", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const running = repository.list({ status: "running", limit: 10 });

    expect(running.map((record: M3LRunRecord) => record.id)).toEqual(["run-b"]);
  });

  test("filters by script", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const alphaRuns = repository.list({ script: "scripts/alpha", limit: 10 });

    expect(alphaRuns.map((record: M3LRunRecord) => record.id).sort()).toEqual([
      "run-a",
      "run-c",
    ]);
  });

  test("filters by both status and script together", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.list({
      status: "queued",
      script: "scripts/alpha",
      limit: 10,
    });

    expect(results.map((record: M3LRunRecord) => record.id)).toEqual([
      "run-a",
      "run-c",
    ]);
  });

  test("respects limit, still returning the oldest matches first", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.list({ status: "queued", limit: 1 });

    expect(results.map((record: M3LRunRecord) => record.id)).toEqual(["run-a"]);
  });

  test("limit: 0 returns an empty list, not every matching row", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.list({ status: "queued", limit: 0 });

    expect(results).toEqual([]);
  });

  test("with no status/script filter, returns every row up to limit", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedListFixture(repository);

    const results = repository.list({ limit: 10 });

    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// countByStatus / countRunningForScript
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — countByStatus() and countRunningForScript()", () => {
  test("countByStatus returns the number of rows in that status, including 0 for a status with no rows", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(insertInput({ id: "run-count-a" }));
    repository.insertQueued(insertInput({ id: "run-count-b" }));
    repository.claimForStart("run-count-b", 1_100);

    expect(repository.countByStatus("queued")).toBe(1);
    expect(repository.countByStatus("running")).toBe(1);
    expect(repository.countByStatus("success")).toBe(0);
  });

  test("countRunningForScript returns the number of currently-running rows for that script, including 0 for an unknown script", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(
      insertInput({ id: "run-rfs-a", script: "scripts/a" }),
    );
    repository.claimForStart("run-rfs-a", 1_100);
    repository.insertQueued(
      insertInput({ id: "run-rfs-b", script: "scripts/a" }),
    );
    // run-rfs-b stays queued, not running — must not be counted.

    expect(repository.countRunningForScript("scripts/a")).toBe(1);
    expect(repository.countRunningForScript("scripts/unknown")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reconcileOrphaned — boot-time recovery of mid-flight runs
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — reconcileOrphaned()", () => {
  test("transitions every queued and running row to interrupted, sets endedAtMs and outcome, and returns the changed count", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(
      insertInput({ id: "run-orphan-queued", queuedAtMs: 1_000 }),
    );
    repository.insertQueued(
      insertInput({ id: "run-orphan-running", queuedAtMs: 1_000 }),
    );
    repository.claimForStart("run-orphan-running", 1_500);

    const changed = repository.reconcileOrphaned(9_000);

    expect(changed).toBe(2);
    const queuedRecord = repository.get("run-orphan-queued");
    expect(queuedRecord?.status).toBe("interrupted");
    expect(queuedRecord?.outcome).toBe("interrupted");
    expect(queuedRecord?.endedAtMs).toBe(9_000);

    const runningRecord = repository.get("run-orphan-running");
    expect(runningRecord?.status).toBe("interrupted");
    expect(runningRecord?.outcome).toBe("interrupted");
    expect(runningRecord?.endedAtMs).toBe(9_000);
    // A run that genuinely started keeps its real startedAtMs.
    expect(runningRecord?.startedAtMs).toBe(1_500);
  });

  // Decided contract (overriding an earlier proposal in this file's
  // history): a reconciled run that never started keeps `startedAtMs`
  // `undefined` rather than having reconciliation fabricate one. The schema's
  // CHECK was widened specifically to permit this
  // (`CHECK (ended_at_ms IS NULL OR started_at_ms IS NOT NULL OR status =
  // 'interrupted')`) instead of manufacturing a timestamp that never
  // happened — see the companion test below for why this distinction is
  // load-bearing and must not be "normalized" away.
  test("a reconciled queued run keeps startedAtMs undefined, marking it as never executed", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(
      insertInput({ id: "run-orphan-never-started", queuedAtMs: 4_000 }),
    );

    repository.reconcileOrphaned(9_000);

    const record = repository.get("run-orphan-never-started");
    expect(record?.startedAtMs).toBeUndefined();
    expect(record?.endedAtMs).toBe(9_000);
    expect(record?.status).toBe("interrupted");
    expect(record?.outcome).toBe("interrupted");
  });

  // The point of this test: `startedAtMs` after reconciliation is the signal
  // an operator uses to decide whether a run is safe to re-launch as-is
  // (never executed) or needs auditing for side effects first (killed
  // mid-execution). Collapsing both cases to the same shape — e.g. always
  // fabricating a `startedAtMs` — would silently destroy that signal, so
  // both rows are reconciled in the SAME pass here to make the contrast
  // directly assertable rather than trusting two separate tests not to
  // drift apart.
  test("reconciling a queued row and a running row in the same pass leaves startedAtMs undefined only for the one that never executed", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insertQueued(
      insertInput({ id: "run-never-executed", queuedAtMs: 1_000 }),
    );
    repository.insertQueued(
      insertInput({ id: "run-killed-mid-execution", queuedAtMs: 1_000 }),
    );
    repository.claimForStart("run-killed-mid-execution", 1_500);

    repository.reconcileOrphaned(9_000);

    const neverExecuted = repository.get("run-never-executed");
    expect(neverExecuted?.status).toBe("interrupted");
    expect(neverExecuted?.startedAtMs).toBeUndefined();

    const killedMidExecution = repository.get("run-killed-mid-execution");
    expect(killedMidExecution?.status).toBe("interrupted");
    // Not overwritten or cleared — the real startedAtMs it already had.
    expect(killedMidExecution?.startedAtMs).toBe(1_500);
  });

  test("leaves an already-terminal row byte-for-byte untouched", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const id = insertAndFinish(repository, { id: "run-orphan-already-done" });
    const before = readRawRun(database, id);

    repository.reconcileOrphaned(9_000);

    expect(readRawRun(database, id)).toEqual(before);
    expect(repository.get(id)?.status).toBe("success");
  });

  test("returns 0 and performs no writes on a database with no pending rows", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    const id = insertAndFinish(repository, { id: "run-clean-db" });
    const before = readRawRun(database, id);

    const changed = repository.reconcileOrphaned(9_000);

    expect(changed).toBe(0);
    expect(readRawRun(database, id)).toEqual(before);
    expect(countRawRows(database)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure mapping — a closed database
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — a closed database", () => {
  test("get() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() => repository.get("run-1"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });

  test("list() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() => repository.list({ limit: 10 }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });

  test("insertQueued() surfaces a typed M3LConsoleError, not a raw node:sqlite error", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    database.close();

    const thrown = captureFailure(() => repository.insertQueued(insertInput()));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe("createConsoleRunsRepository — type contract", () => {
  test("is a function over M3LStoreQueryExecutor, never a class holding a DatabaseSync", () => {
    expectTypeOf(createConsoleRunsRepository)
      .parameter(0)
      .toMatchTypeOf<M3LStoreQueryExecutor>();
    expectTypeOf(
      createConsoleRunsRepository,
    ).returns.toMatchTypeOf<M3LConsoleRunsRepository>();
  });

  test("M3LRunRecord exposes every documented field with the documented optionality", () => {
    expectTypeOf<M3LRunRecord["status"]>().toMatchTypeOf<M3LRunStatus>();
    expectTypeOf<M3LRunRecord["outcome"]>().toEqualTypeOf<
      M3LRunTerminalStatus | undefined
    >();
    expectTypeOf<M3LRunRecord["startedAtMs"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LRunRecord["endedAtMs"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LRunRecord["exitCode"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LRunRecord["failureMessage"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LRunRecord["dryRun"]>().toEqualTypeOf<boolean>();
  });

  test("M3LConsoleRunsRepository exposes exactly the documented method set", () => {
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("insertQueued");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("claimForStart");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("finish");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("get");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("list");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty("countByStatus");
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty(
      "countRunningForScript",
    );
    expectTypeOf<M3LConsoleRunsRepository>().toHaveProperty(
      "reconcileOrphaned",
    );
  });

  test("M3LRunListQuery requires limit but status/script are optional", () => {
    const withLimitOnly: M3LRunListQuery = { limit: 5 };
    const withEverything: M3LRunListQuery = {
      status: "queued",
      script: "scripts/example",
      limit: 5,
    };

    expect(withLimitOnly.limit).toBe(5);
    expect(withEverything.status).toBe("queued");
  });
});
