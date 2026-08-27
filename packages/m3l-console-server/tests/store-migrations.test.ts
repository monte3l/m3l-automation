/**
 * Tests for `src/store/migrations/runner.ts`'s `applyMigrations` and the
 * `M3LMigration` shape it consumes from `src/store/migrations/registry.ts`
 * (X3 console-persistence, slice B, ADR-0069, hub issue #551).
 *
 * This file imports only its own slice — `store/migrations/runner.ts`
 * (a value import) and `store/migrations/registry.ts` (a type-only import,
 * for `M3LMigration`) — never `store/executor.ts` or
 * `store/sqlite-driver.ts` directly, so v8's `perFile` coverage does not get
 * re-bound across the `store/` slice split. `applyMigrations` naturally
 * exercises the executor and driver transitively at runtime (a `:memory:`
 * run really does issue real SQL through them); that is expected and fine,
 * it just means neither module is ever named in an `import` here.
 *
 * A migration declares its SQL as data (`statements: readonly string[]`),
 * not as an `up(executor)` function body — the runner executes each
 * statement in order inside the one transaction it owns. See the
 * edited-in-place drift test below for why: a digest keyed on a function's
 * source text would make a `prettier --write` pass or a TypeScript emit
 * change look identical to real tampering.
 *
 * Every scenario below builds its OWN small migration set rather than
 * importing the real `CONSOLE_MIGRATIONS` registry — the registry's actual
 * v1/v2 content (`console_schema_migrations`/`console_meta`) is exercised
 * by the metadata-repository slice another spoke owns. The one piece of
 * that registry's documented shape every fixture here still has to honor is
 * the `console_schema_migrations` table itself: the runner writes a history
 * row into it after every successful migration, so a fresh test registry's
 * own version 1 always creates that table with the exact documented
 * columns (`version`, `name`, `applied_at_ms`, `node_version`,
 * `sql_digest`) — otherwise the very first migration's history insert would
 * fail with "no such table", for reasons unrelated to what each test means
 * to prove.
 *
 * No filesystem I/O anywhere in this file: every case uses a real
 * `:memory:` `node:sqlite` database (via `node:sqlite`'s own `DatabaseSync`,
 * never `store/sqlite-driver.ts`'s `openSqliteDatabase` wrapper) or a thin
 * recording/fault-injecting fake that wraps one, mirroring the established
 * pattern in `tests/store-open.test.ts` and `tests/store-executor.test.ts`.
 *
 * One exception to the "build your own small registry" rule above: the
 * `CONSOLE_MIGRATIONS — the real registry (v3: console_runs)` block near the
 * end of this file imports the real `CONSOLE_MIGRATIONS` (X4 run-registry,
 * slice 3) as a value, to prove the registry's actual v3 entry — not a
 * stand-in — creates a schema whose `CHECK` constraints hold. This does not
 * re-bind `perFile` coverage across the `store/` slice split: `registry.ts`
 * and `runner.ts` are both already this file's own slice (the former is
 * already imported for its `M3LMigration` type above).
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import { applyMigrations } from "../src/store/migrations/runner.js";
import type { M3LMigration } from "../src/store/migrations/registry.js";

/** The exact `console_schema_migrations` shape `registry.ts`'s v1 documents. */
const HISTORY_TABLE_SQL = `
  CREATE TABLE console_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    node_version TEXT NOT NULL,
    sql_digest TEXT NOT NULL
  ) STRICT
`;

/**
 * Every test registry's version 1 — creates the audit-trail table the
 * runner writes history rows into.
 */
function historyTableMigration(): M3LMigration {
  return {
    version: 1,
    name: "create_console_schema_migrations",
    statements: [HISTORY_TABLE_SQL],
  };
}

/** A harmless migration that creates one marker table, named `tableName`. */
function tableMigration(
  version: number,
  name: string,
  tableName: string,
): M3LMigration {
  return {
    version,
    name,
    statements: [`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY)`],
  };
}

/**
 * A migration that creates `tableName`, then issues a second statement
 * guaranteed to fail (inserting into a column the just-created table does
 * not have) — a genuine SQL failure inside the transaction the runner owns,
 * not an injected throw. Proves the runner's rollback undoes the whole
 * migration's DDL, not just the statement that actually failed.
 */
function failingMigration(
  version: number,
  name: string,
  tableName: string,
): M3LMigration {
  return {
    version,
    name,
    statements: [
      `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY)`,
      `INSERT INTO ${tableName} (nonexistent_column) VALUES (1)`,
    ],
  };
}

/**
 * A minimal migration used only in malformed-registry fixtures, where
 * validation fails before any statement would ever run.
 */
function noopMigration(version: number, name: string): M3LMigration {
  return {
    version,
    name,
    statements: ["SELECT 1"],
  };
}

/**
 * Version 2 of a business migration, parameterized by its single SQL
 * statement — used only by the edited-in-place digest test below, where two
 * registries differ solely in this string.
 */
function migrationV2(sql: string): M3LMigration {
  return {
    version: 2,
    name: "creates_v2_table",
    statements: [sql],
  };
}

/** `true` when a table named `tableName` exists in `database`. */
function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

/** Reads `PRAGMA user_version` as a plain number. */
function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : Number.NaN;
}

/** The number of rows currently recorded in `console_schema_migrations`. */
function readHistoryRowCount(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM console_schema_migrations")
    .get();
  const value = row?.["count"];
  return typeof value === "number" ? value : Number.NaN;
}

/**
 * Wraps a real `:memory:` (or already-migrated) backing database, recording
 * every `exec()` call and counting `prepare()` calls, and optionally forcing
 * an `exec()` call matching `execShouldThrow` to throw a synthetic
 * `SQLITE_BUSY`-shaped error (`code: "ERR_SQLITE_ERROR"`, `errcode: 5`).
 * Every other operation delegates to the real backing database, so anything
 * that probes the handle still sees fully correct SQLite behavior — mirrors
 * `tests/store-open.test.ts` and `tests/store-executor.test.ts`'s own
 * `createRecordingDatabase` helpers.
 */
function createRecordingDatabase(options?: {
  real?: DatabaseSync;
  execShouldThrow?: (sql: string) => boolean;
}): {
  handle: DatabaseSync;
  execCalls: string[];
  getPrepareCallCount: () => number;
} {
  const real = options?.real ?? new DatabaseSync(":memory:");
  const execCalls: string[] = [];
  let prepareCallCount = 0;

  const handle = {
    get isOpen() {
      return real.isOpen;
    },
    get isTransaction() {
      return real.isTransaction;
    },
    exec(sql: string) {
      execCalls.push(sql);
      if (options?.execShouldThrow?.(sql) === true) {
        throw Object.assign(new Error(`synthetic busy failure: ${sql}`), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
      }
      real.exec(sql);
    },
    prepare(sql: string) {
      prepareCallCount += 1;
      return real.prepare(sql);
    },
    close() {
      real.close();
    },
  };

  return {
    // Structurally compatible with `M3LSqliteDatabaseHandle` — cast only to
    // satisfy this helper's declared return type, not to bypass a real
    // structural mismatch (the same convention `store-open.test.ts` and
    // `store-executor.test.ts` already use).
    handle: handle as unknown as DatabaseSync,
    execCalls,
    getPrepareCallCount: () => prepareCallCount,
  };
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

describe("applyMigrations — 0 -> N on a fresh database", () => {
  test("returns the count applied and every migration's table exists afterward", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];

    const applied = applyMigrations(database, migrations);

    expect(applied).toBe(3);
    expect(tableExists(database, "t2")).toBe(true);
    expect(tableExists(database, "t3")).toBe(true);
    expect(readUserVersion(database)).toBe(3);
  });
});

describe("applyMigrations — history audit trail", () => {
  test("records one history row per migration, each carrying node_version", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];

    applyMigrations(database, migrations);

    const rows = database
      .prepare(
        "SELECT version, name, node_version FROM console_schema_migrations ORDER BY version",
      )
      .all();

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row["version"])).toEqual([1, 2, 3]);
    expect(rows.map((row) => row["name"])).toEqual([
      "create_console_schema_migrations",
      "creates_t2",
      "creates_t3",
    ]);
    // Accepts either plausible "which Node applied this" representation
    // (`process.version`, `v`-prefixed, or `process.versions.node`,
    // unprefixed) — the contract names the forensic question, not a literal
    // string format.
    for (const row of rows) {
      expect([process.version, process.versions.node]).toContain(
        row["node_version"],
      );
    }
  });
});

describe("applyMigrations — re-opening an already-migrated database (boundary: equal)", () => {
  // Paired with "schema drift — user_version strictly ahead" below: a
  // mutation that flips the runner's `>` refusal check to `>=` would make
  // THIS test start throwing (a `userVersion === highest` database would
  // wrongly be refused) while the drift test's fixture is unaffected either
  // way — together the pair discriminates the boundary.
  test("applies nothing and issues no DDL — proven via a recording fake, not merely 'did not throw'", () => {
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];

    const real = new DatabaseSync(":memory:");
    const firstApplied = applyMigrations(real, migrations);
    expect(firstApplied).toBe(3);

    const { handle, execCalls } = createRecordingDatabase({ real });
    const secondApplied = applyMigrations(handle, migrations);

    expect(secondApplied).toBe(0);
    expect(execCalls.some((sql) => /CREATE TABLE/i.test(sql))).toBe(false);
  });
});

describe("applyMigrations — a failing migration", () => {
  test("rolls back its own DDL AND leaves user_version at the last successfully applied version", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      failingMigration(3, "creates_t3_then_fails", "t3"),
    ];

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    // Half of the guarantee would be proven by either assertion alone —
    // both must hold.
    expect(tableExists(database, "t3")).toBe(false);
    expect(readUserVersion(database)).toBe(2);
    expect(readHistoryRowCount(database)).toBe(2);
  });

  test("retrying with a corrected migration applies just the one remaining version", () => {
    const database = new DatabaseSync(":memory:");
    const failingMigrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      failingMigration(3, "creates_t3_then_fails", "t3_attempt"),
    ];

    captureFailure(() => applyMigrations(database, failingMigrations));
    expect(readUserVersion(database)).toBe(2);

    const correctedMigrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3_then_fails", "t3_fixed"),
    ];

    const applied = applyMigrations(database, correctedMigrations);

    expect(applied).toBe(1);
    expect(readUserVersion(database)).toBe(3);
    expect(tableExists(database, "t3_fixed")).toBe(true);
  });
});

describe("applyMigrations — a BUSY failure", () => {
  test("surfaces as ERR_CONSOLE_STORE_BUSY, not ERR_CONSOLE_STORE_MIGRATION_FAILED", () => {
    const { handle } = createRecordingDatabase({
      execShouldThrow: (sql) => /BEGIN IMMEDIATE/i.test(sql),
    });
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
    ];

    const thrown = captureFailure(() => applyMigrations(handle, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_BUSY");
  });
});

describe("applyMigrations — a migration failure's error context", () => {
  test("carries { version, name } and never the failing SQL text", () => {
    const database = new DatabaseSync(":memory:");
    const leakMarker = "should_never_leak_into_error_context";
    const migrations = [
      historyTableMigration(),
      failingMigration(2, "the_failing_migration", leakMarker),
    ];

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const context = (thrown as M3LConsoleError).context;
    expect(context["version"]).toBe(2);
    expect(context["name"]).toBe("the_failing_migration");
    expect(Object.keys(context)).not.toContain("sql");
    expect(JSON.stringify(context)).not.toContain(leakMarker);
  });
});

describe("schema drift — user_version strictly ahead of the registry", () => {
  // Paired with the "re-opening (boundary: equal)" test above.
  test("fails as ERR_CONSOLE_STORE_SCHEMA_DRIFT, naming both integers", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA user_version = 5");

    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    );
    expect((thrown as M3LConsoleError).message).toContain("5");
    expect((thrown as M3LConsoleError).message).toContain("3");
  });
});

describe("schema drift — a recorded history row's name disagrees with the registry", () => {
  test("fails as ERR_CONSOLE_STORE_SCHEMA_DRIFT", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];
    applyMigrations(database, migrations);

    database.exec(
      "UPDATE console_schema_migrations SET name = 'tampered_name' WHERE version = 2",
    );

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    );
  });
});

describe("schema drift — an edited-in-place migration (changed SQL, same version+name)", () => {
  // The single most valuable test in this file: a released migration's SQL
  // is edited after it already shipped and ran in production. Nothing about
  // `version` or `name` changes, so only a per-version digest of the
  // migration's own declared `statements` can catch it.
  //
  // The digest is computed over `statements` (plain string data) rather
  // than over a function's source text on purpose: keying it on, say,
  // `up.toString()` would make a `prettier --write` pass over `registry.ts`,
  // or a TypeScript emit change, alter the digest for migrations nobody
  // touched — a false positive that would block boot on every existing
  // deployment. Prettier never reformats the contents of a string literal,
  // so a `statements`-keyed digest only moves when the SQL itself does.
  // Do not "simplify" this back to hashing a function body.
  test("a changed statement for an already-applied version fails as ERR_CONSOLE_STORE_SCHEMA_DRIFT on the next apply", () => {
    const database = new DatabaseSync(":memory:");
    const originalMigrations = [
      historyTableMigration(),
      migrationV2("CREATE TABLE original_v2_table (id INTEGER PRIMARY KEY)"),
      tableMigration(3, "creates_t3", "t3"),
    ];
    const applied = applyMigrations(database, originalMigrations);
    expect(applied).toBe(3);

    const editedMigrations = [
      historyTableMigration(),
      migrationV2(
        "CREATE TABLE edited_v2_table (id INTEGER PRIMARY KEY, extra TEXT)",
      ),
      tableMigration(3, "creates_t3", "t3"),
    ];

    const thrown = captureFailure(() =>
      applyMigrations(database, editedMigrations),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    );
  });
});

describe("schema drift — a deleted history row for an already-applied version", () => {
  // The deleted-row arm of the same tampering check `runner.ts` performs for
  // a name/digest mismatch (see the "edited-in-place" test above): a history
  // row missing for a version <= currentVersion is exactly the tampering
  // signal `console_schema_migrations` exists to catch. `runner.ts:180`'s
  // `if (recorded === undefined) continue;` silently skips it instead of
  // throwing `ERR_CONSOLE_STORE_SCHEMA_DRIFT`.
  test("re-applying after a history row was deleted fails as ERR_CONSOLE_STORE_SCHEMA_DRIFT", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
      tableMigration(3, "creates_t3", "t3"),
    ];
    applyMigrations(database, migrations);

    database.exec("DELETE FROM console_schema_migrations WHERE version = 2");

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    );
  });
});

describe("assertNoHistoryDrift — a missing console_schema_migrations table escapes classification", () => {
  // `runner.ts:172` (`database.prepare(...)`) and its `statement.get(...)`
  // are the only DB access in this module NOT wrapped by a classification
  // helper (contrast `readCurrentSchemaVersion`'s explicit try/catch just
  // above it). A `user_version` ahead of 0 but a missing/unreadable
  // `console_schema_migrations` table lets the raw `node:sqlite` error
  // escape `applyMigrations` unclassified, contradicting its documented
  // `@throws` contract.
  test("a user_version past 0 with no console_schema_migrations table throws a classified M3LConsoleError, not a raw error", () => {
    const database = new DatabaseSync(":memory:");
    // user_version = 1 with NO console_schema_migrations table: the
    // "already applied" bookkeeping is present, but the audit trail table
    // itself is missing or unreadable.
    database.exec("PRAGMA user_version = 1");

    const migrations = [
      historyTableMigration(),
      tableMigration(2, "creates_t2", "t2"),
    ];

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_MIGRATION_FAILED",
    );
  });
});

describe("registry validation — malformed registries fail BEFORE the database is touched", () => {
  const MALFORMED_REGISTRIES: readonly [string, M3LMigration[]][] = [
    ["a duplicate version", [noopMigration(1, "a"), noopMigration(1, "b")]],
    ["a version gap", [noopMigration(1, "a"), noopMigration(3, "b")]],
    ["version 0", [noopMigration(0, "a")]],
    ["a negative version", [noopMigration(-1, "a")]],
    ["a non-integer version", [noopMigration(1.5, "a")]],
    ["a version above 2_147_483_647", [noopMigration(2_147_483_648, "a")]],
    ["an empty name", [noopMigration(1, "")]],
    ["a duplicate name", [noopMigration(1, "same"), noopMigration(2, "same")]],
  ];

  test.each(MALFORMED_REGISTRIES)(
    "%s -> ERR_CONSOLE_STORE_MIGRATION_FAILED",
    (_label, migrations) => {
      const database = new DatabaseSync(":memory:");

      const thrown = captureFailure(() =>
        applyMigrations(database, migrations),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_STORE_MIGRATION_FAILED",
      );
    },
  );

  test("a malformed registry fails with zero exec/prepare calls made against the database", () => {
    const { handle, execCalls, getPrepareCallCount } =
      createRecordingDatabase();
    const migrations = [noopMigration(1, "a"), noopMigration(1, "b")];

    const thrown = captureFailure(() => applyMigrations(handle, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    // Proves validation ran BEFORE any attempt to read PRAGMA user_version
    // or begin a transaction — not merely that the call eventually failed.
    expect(execCalls).toHaveLength(0);
    expect(getPrepareCallCount()).toBe(0);
  });
});

describe("interpolation safety — a version crafted as SQL", () => {
  test("is rejected as ERR_CONSOLE_STORE_MIGRATION_FAILED before ever being interpolated", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE keepme (id INTEGER PRIMARY KEY)");
    database.exec("INSERT INTO keepme (id) VALUES (1)");

    // `PRAGMA user_version = ?` is a measured syntax error (node:sqlite
    // does not permit binding a pragma value), so the validated version is
    // interpolated directly — this guard is what makes that safe.
    const hostileVersion = "1; DROP TABLE keepme; --" as unknown as number;
    const migrations: M3LMigration[] = [
      {
        version: hostileVersion,
        name: "hostile",
        statements: ["SELECT 1"],
      },
    ];

    const thrown = captureFailure(() => applyMigrations(database, migrations));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_MIGRATION_FAILED",
    );

    const row = database.prepare("SELECT COUNT(*) AS count FROM keepme").get();
    expect(row?.["count"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CONSOLE_MIGRATIONS — the real registry (v3: console_runs)
//
// Everything below this line exercises the ACTUAL `CONSOLE_MIGRATIONS`
// registry (see the file header's documented exception), not a stand-in
// fixture — because the thing under test here is the real v3 migration's
// `CHECK` constraints, which only exist on the real `console_runs` table.
// ---------------------------------------------------------------------------

/** `true` when an index named `indexName` exists in `database`. */
function indexExists(database: DatabaseSync, indexName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);
  return row !== undefined;
}

/** Applies the real `CONSOLE_MIGRATIONS` registry to a fresh `:memory:` database. */
function createRealMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, CONSOLE_MIGRATIONS);
  return database;
}

/** One `console_runs` row, in the column order `insertRun` binds positionally. */
interface RunRowFixture {
  readonly id: string;
  readonly script: string;
  readonly status: string;
  readonly dry_run: number;
  readonly execution_mode: string;
  readonly parameters_json: string;
  readonly operator: string;
  readonly correlation_id: string;
  readonly queued_at_ms: number;
  readonly started_at_ms: number | null;
  readonly ended_at_ms: number | null;
  readonly outcome: string | null;
  readonly exit_code: number | null;
  readonly failure_message: string | null;
}

/** A fully valid, still-pending `console_runs` row — the "queued" positive control. */
function validQueuedRow(id: string): RunRowFixture {
  return {
    id,
    script: "scripts/example",
    status: "queued",
    dry_run: 0,
    execution_mode: "spawn",
    parameters_json: "{}",
    operator: "alice",
    correlation_id: `corr-${id}`,
    queued_at_ms: 1000,
    started_at_ms: null,
    ended_at_ms: null,
    outcome: null,
    exit_code: null,
    failure_message: null,
  };
}

/** A fully valid, terminal `console_runs` row — the "success" positive control. */
function validTerminalRow(id: string): RunRowFixture {
  return {
    id,
    script: "scripts/example",
    status: "success",
    dry_run: 0,
    execution_mode: "in-process",
    parameters_json: "{}",
    operator: "alice",
    correlation_id: `corr-${id}`,
    queued_at_ms: 1000,
    started_at_ms: 1500,
    ended_at_ms: 2000,
    outcome: "success",
    exit_code: 0,
    failure_message: null,
  };
}

/** Inserts one `console_runs` row, positionally bound in `RunRowFixture`'s declared order. */
function insertRun(database: DatabaseSync, row: RunRowFixture): void {
  database
    .prepare(
      `INSERT INTO console_runs (
        id, script, status, dry_run, execution_mode, parameters_json,
        operator, correlation_id, queued_at_ms, started_at_ms, ended_at_ms,
        outcome, exit_code, failure_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.script,
      row.status,
      row.dry_run,
      row.execution_mode,
      row.parameters_json,
      row.operator,
      row.correlation_id,
      row.queued_at_ms,
      row.started_at_ms,
      row.ended_at_ms,
      row.outcome,
      row.exit_code,
      row.failure_message,
    );
}

describe("CONSOLE_MIGRATIONS — the real registry (v3: console_runs)", () => {
  test("has exactly three migrations, versions strictly increasing and gap-free (1, 2, 3)", () => {
    expect(CONSOLE_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3,
    ]);
  });

  test("v3 has a stable, non-empty name distinct from v1's and v2's", () => {
    const names = CONSOLE_MIGRATIONS.map((migration) => migration.name);

    expect(new Set(names).size).toBe(names.length);
    const v3 = CONSOLE_MIGRATIONS.find((migration) => migration.version === 3);
    expect(v3).toBeDefined();
    expect(v3?.name.length).toBeGreaterThan(0);
  });

  test("applying every migration succeeds and creates console_runs with both its indexes", () => {
    const database = createRealMigratedDatabase();

    expect(tableExists(database, "console_runs")).toBe(true);
    expect(indexExists(database, "console_runs_status_queued_at")).toBe(true);
    expect(indexExists(database, "console_runs_script_status")).toBe(true);
  });

  test("a valid queued row inserts successfully", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertRun(database, validQueuedRow("run-queued")),
    ).not.toThrow();

    const row = database
      .prepare("SELECT status FROM console_runs WHERE id = ?")
      .get("run-queued");
    expect(row?.["status"]).toBe("queued");
  });

  test("a valid terminal row inserts successfully", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertRun(database, validTerminalRow("run-terminal")),
    ).not.toThrow();

    const row = database
      .prepare("SELECT status FROM console_runs WHERE id = ?")
      .get("run-terminal");
    expect(row?.["status"]).toBe("success");
  });

  // Every case below is a single-field departure from an otherwise fully
  // valid row, chosen so that exactly ONE documented CHECK constraint is
  // violated — never merely a proxy like "the row count did not change",
  // which would also hold if the insert had silently no-op'd instead of
  // throwing.
  const CHECK_VIOLATIONS: readonly [string, RunRowFixture][] = [
    [
      "an unknown status value",
      { ...validQueuedRow("v-status"), status: "bogus" },
    ],
    ["a dry_run value of 2", { ...validQueuedRow("v-dryrun"), dry_run: 2 }],
    [
      "an unknown execution_mode value",
      { ...validQueuedRow("v-mode"), execution_mode: "invalid-mode" },
    ],
    [
      "started_at_ms before queued_at_ms",
      {
        ...validQueuedRow("v-started-before-queued"),
        status: "running",
        queued_at_ms: 1000,
        started_at_ms: 500,
      },
    ],
    [
      // Uses validTerminalRow's default status ("success") deliberately —
      // this is the non-interrupted terminal-status case the pairing check
      // still forbids. The 'interrupted' exemption is asserted separately,
      // as an ACCEPTED case, below.
      "ended_at_ms set while started_at_ms is NULL, for a non-interrupted terminal status",
      {
        ...validTerminalRow("v-ended-no-started"),
        started_at_ms: null,
      },
    ],
    [
      "ended_at_ms before started_at_ms",
      {
        ...validTerminalRow("v-ended-before-started"),
        started_at_ms: 2000,
        ended_at_ms: 1000,
      },
    ],
    [
      "a terminal status with ended_at_ms NULL",
      {
        ...validTerminalRow("v-terminal-no-ended"),
        ended_at_ms: null,
        outcome: null,
        exit_code: null,
      },
    ],
    [
      "a pending status with ended_at_ms set",
      {
        ...validQueuedRow("v-pending-ended-set"),
        started_at_ms: 1500,
        ended_at_ms: 2000,
        outcome: "success",
        exit_code: 0,
      },
    ],
    [
      "outcome NULL while ended_at_ms is set",
      {
        ...validTerminalRow("v-outcome-null-ended-set"),
        outcome: null,
        exit_code: null,
      },
    ],
    [
      "outcome set while ended_at_ms is NULL",
      {
        ...validQueuedRow("v-outcome-set-ended-null"),
        outcome: "success",
      },
    ],
  ];

  test.each(CHECK_VIOLATIONS)("rejects a row with %s", (_label, row) => {
    const database = createRealMigratedDatabase();

    expect(() => insertRun(database, row)).toThrow();
  });

  test("accepts an interrupted row with ended_at_ms set and started_at_ms NULL — a run that ended without ever starting (e.g. SIGKILL while queued)", () => {
    const database = createRealMigratedDatabase();
    const row: RunRowFixture = {
      ...validQueuedRow("v-interrupted-never-started"),
      status: "interrupted",
      ended_at_ms: 9000,
      outcome: "interrupted",
    };

    expect(() => insertRun(database, row)).not.toThrow();

    const stored = database
      .prepare("SELECT status, started_at_ms FROM console_runs WHERE id = ?")
      .get("v-interrupted-never-started");
    expect(stored?.["status"]).toBe("interrupted");
    expect(stored?.["started_at_ms"]).toBeNull();
  });

  test("STRICT is honest about what it does not enforce: an integer bound to script (TEXT) is silently accepted", () => {
    // MEASURED, same finding `registry.ts`'s own TSDoc records for v1/v2:
    // `STRICT` checks storage-class compatibility, not column-level types —
    // an INTEGER is a convertible storage class for a TEXT column, so
    // `STRICT` alone does not reject it. This table's actual invariants
    // (status vocabulary, dry_run boolean-ness, the FSM pairing between
    // status/ended_at_ms/outcome) are enforced entirely by the `CHECK`
    // constraints exercised above, not by `STRICT`.
    const database = createRealMigratedDatabase();
    const row = validQueuedRow("v-strict-int-script");

    expect(() =>
      insertRun(database, {
        ...row,
        script: 12_345 as unknown as string,
      }),
    ).not.toThrow();

    const stored = database
      .prepare("SELECT script FROM console_runs WHERE id = ?")
      .get("v-strict-int-script");
    // node:sqlite binds a plain JS number as SQLITE_FLOAT, so the value
    // STRICT's storage-class coercion casts into the TEXT column is
    // "12345.0" — not "12345" — but it IS a stored string, not a rejection.
    // That coercion detail is exactly why STRICT is not column-level type
    // enforcement: the point this test proves is that the row was accepted
    // and stored as text at all, whatever its exact textual form.
    expect(typeof stored?.["script"]).toBe("string");
    expect(stored?.["script"]).toBe("12345.0");
  });
});
