/**
 * Tests for src/store/executor.ts — `createStoreExecutor` and
 * `withTransaction` (X3 console-persistence, slice A4, ADR-0069).
 *
 * Real `:memory:` `node:sqlite` databases (via the real `DatabaseSync`
 * driver) cover every happy path — no filesystem, real SQL, real error
 * objects. A handful of branches are unreachable through a real database
 * (counting how many times `prepare()` is called for the statement-cache
 * assertion; a `ROLLBACK` that itself throws) and use a thin fake handle
 * that WRAPS a real backing `:memory:` database and intercepts/records
 * specific calls, rather than reimplementing SQLite semantics. This keeps
 * every other operation (including `assertSqliteSupport`'s own probing)
 * genuinely correct.
 *
 * This file imports only `src/store/executor.ts` — never
 * `src/store/sqlite-driver.ts` or `src/store/store.ts` — so v8's `perFile`
 * coverage does not get re-bound across the `store/` slice split. Fakes are
 * passed as plain object literals; `createStoreExecutor`/`withTransaction`
 * accept them structurally (the port is a structural interface, per the
 * contract), so no type needs to be imported from `sqlite-driver.ts` to
 * build one.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createStoreExecutor, withTransaction } from "../src/store/executor.js";

/**
 * A minimal local stand-in for `M3LStoreTransaction`, typed just for the two
 * members these tests actually call (`run`/`nested`). `store/types.ts`
 * doesn't exist yet, so this can't be imported — it exists only to give
 * `withTransaction`'s callback parameter an explicit type in RED (where the
 * real signature is unresolved and callback params would otherwise fall back
 * to implicit `any`). Once `withTransaction` exists, its real callback
 * parameter type is a strict superset of this and remains assignable.
 */
interface TestTransaction {
  run(
    sql: string,
    parameters?: unknown,
  ): { changes: number; lastInsertRowid: number | bigint };
  nested<T>(work: (transaction: TestTransaction) => T): T;
}

/** A fresh `:memory:` database with one simple table to exercise queries against. */
function freshDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
  return database;
}

/**
 * Wraps a real `:memory:` database, recording every `exec()` call and every
 * `prepare()` call, and optionally forcing a specific `exec()` call to throw.
 * Every other operation delegates to the real backing database, so anything
 * that probes the handle (e.g. `assertSqliteSupport`, run internally by
 * `store/store.ts`) still sees fully correct SQLite behavior.
 */
function createRecordingDatabase(options?: {
  execShouldThrow?: (sql: string) => boolean;
}): {
  handle: DatabaseSync;
  execCalls: string[];
  getPrepareCallCount: () => number;
} {
  const real = new DatabaseSync(":memory:");
  // Matches freshDatabase()'s schema — without this, any call touching
  // `widgets` fails with a genuine "no such table: widgets" at prepare()
  // time, and the statement-cache assertion below is never reached.
  real.exec(
    "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
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
        throw new Error(`synthetic exec failure: ${sql}`);
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
    // satisfy this helper's own declared return type, not to bypass a real
    // structural mismatch.
    handle: handle as unknown as DatabaseSync,
    execCalls,
    getPrepareCallCount: () => prepareCallCount,
  };
}

describe("createStoreExecutor — all/get/run against a real database", () => {
  test("run() inserts a row and reports changes + lastInsertRowid", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    const result = executor.run("INSERT INTO widgets (name) VALUES (?)", [
      "gizmo",
    ]);

    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(1);
  });

  test("all() returns every matching row", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (name) VALUES (?)", ["a"]);
    executor.run("INSERT INTO widgets (name) VALUES (?)", ["b"]);

    const rows = executor.all("SELECT name FROM widgets ORDER BY name");

    expect(rows).toEqual([{ name: "a" }, { name: "b" }]);
  });

  test("get() returns the single matching row", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (name) VALUES (?)", ["solo"]);

    const row = executor.get("SELECT name FROM widgets WHERE name = ?", [
      "solo",
    ]);

    expect(row).toEqual({ name: "solo" });
  });

  test("get() returns undefined when no row matches", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    const row = executor.get("SELECT name FROM widgets WHERE name = ?", [
      "missing",
    ]);

    expect(row).toBeUndefined();
  });
});

describe("createStoreExecutor — bound parameters", () => {
  test("accepts positional (array) parameters", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (id, name) VALUES (?, ?)", [1, "pos"]);

    const row = executor.get("SELECT * FROM widgets WHERE id = ?", [1]);

    expect(row).toEqual({ id: 1, name: "pos" });
  });

  test("accepts named parameters", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (id, name) VALUES ($id, $name)", {
      $id: 7,
      $name: "named",
    });

    const row = executor.get("SELECT * FROM widgets WHERE id = $id", {
      $id: 7,
    });

    expect(row).toEqual({ id: 7, name: "named" });
  });
});

describe("createStoreExecutor — row normalization", () => {
  // Measured: raw `node:sqlite` rows are `[Object: null prototype]`. This
  // asserts the EXECUTOR'S OUTPUT after normalization — not a raw driver
  // row — so it fails if the executor stops converting rows to ordinary
  // objects.
  test("all() yields ordinary-prototype rows, not null-prototype ones", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (id, name) VALUES (?, ?)", [1, "x"]);

    const rows = executor.all("SELECT * FROM widgets");

    for (const row of rows) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    }
    expect(rows).toEqual([{ id: 1, name: "x" }]);
  });

  test("get() also yields an ordinary-prototype row", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (id, name) VALUES (?, ?)", [1, "y"]);

    const row = executor.get("SELECT * FROM widgets WHERE id = ?", [1]);

    expect(row).toBeDefined();
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row).toEqual({ id: 1, name: "y" });
  });
});

describe("createStoreExecutor — readBigInts", () => {
  test("reads a value above Number.MAX_SAFE_INTEGER as bigint when options.readBigInts is set", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    const huge = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    executor.run("INSERT INTO widgets (id, name) VALUES (?, ?)", [
      huge,
      "huge",
    ]);

    const row = executor.get(
      "SELECT id FROM widgets WHERE name = ?",
      ["huge"],
      { readBigInts: true },
    );

    expect(typeof row?.["id"]).toBe("bigint");
    expect(row?.["id"]).toBe(huge);
  });

  // This is the exact bug caching introduces: because statements are cached
  // by SQL text, `setReadBigInts` must be applied per call, not once at
  // prepare time — otherwise a later plain call against the SAME cached SQL
  // silently inherits the flag. Using an in-range value here means a leak
  // shows up as a `typeof` mismatch (bigint where a number is expected),
  // rather than as an unrelated ERR_OUT_OF_RANGE throw.
  test("readBigInts does not leak across a cached statement into a later plain call", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    executor.run("INSERT INTO widgets (id, name) VALUES (?, ?)", [42, "small"]);
    const sql = "SELECT id FROM widgets WHERE name = ?";

    const bigRow = executor.get(sql, ["small"], { readBigInts: true });
    expect(typeof bigRow?.["id"]).toBe("bigint");
    expect(bigRow?.["id"]).toBe(42n);

    const plainRow = executor.get(sql, ["small"]);
    expect(typeof plainRow?.["id"]).toBe("number");
    expect(plainRow?.["id"]).toBe(42);
  });
});

describe("createStoreExecutor — statement cache", () => {
  test("reuses a prepared statement across repeated identical SQL", () => {
    const { handle, getPrepareCallCount } = createRecordingDatabase();
    const executor = createStoreExecutor(handle);
    executor.run("INSERT INTO widgets (name) VALUES (?)", ["a"]);
    const prepareCallsAfterInsert = getPrepareCallCount();

    executor.all("SELECT name FROM widgets");
    executor.all("SELECT name FROM widgets");
    executor.all("SELECT name FROM widgets");

    // Three identical SELECT calls must add exactly ONE prepare() call — the
    // rest are cache hits. Without caching this would be
    // `prepareCallsAfterInsert + 3`.
    expect(getPrepareCallCount()).toBe(prepareCallsAfterInsert + 1);
  });
});

describe("createStoreExecutor — script()", () => {
  test("runs multi-statement DDL", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    executor.script(
      "CREATE TABLE extra (id INTEGER PRIMARY KEY); " +
        "INSERT INTO extra (id) VALUES (1); " +
        "INSERT INTO extra (id) VALUES (2);",
    );

    const rows = executor.all("SELECT id FROM extra ORDER BY id");
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("withTransaction — commit and rollback", () => {
  test("commits work's writes on success", () => {
    const database = freshDatabase();

    withTransaction(database, (tx: TestTransaction) => {
      tx.run("INSERT INTO widgets (name) VALUES (?)", ["committed"]);
    });

    const executor = createStoreExecutor(database);
    expect(executor.all("SELECT name FROM widgets")).toEqual([
      { name: "committed" },
    ]);
  });

  test("rolls back all writes when the callback throws, re-throwing the ORIGINAL error identity", () => {
    const database = freshDatabase();
    const originalError = new Error("boom");

    let thrown: unknown;
    try {
      withTransaction(database, (tx: TestTransaction) => {
        tx.run("INSERT INTO widgets (name) VALUES (?)", ["doomed"]);
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    // Identity, not just "threw" — a wrapper that lost identity would still
    // pass a bare `toThrow` assertion.
    expect(thrown).toBe(originalError);

    const executor = createStoreExecutor(database);
    expect(executor.all("SELECT name FROM widgets")).toEqual([]);
  });
});

describe("withTransaction — nested() savepoints", () => {
  test("discards only the inner writes; the outer transaction's writes survive", () => {
    const database = freshDatabase();

    withTransaction(database, (tx: TestTransaction) => {
      tx.run("INSERT INTO widgets (name) VALUES (?)", ["outer"]);

      let innerFailure: unknown;
      try {
        tx.nested((nestedTx: TestTransaction) => {
          nestedTx.run("INSERT INTO widgets (name) VALUES (?)", ["inner"]);
          throw new Error("inner failure");
        });
      } catch (error) {
        innerFailure = error;
      }
      expect(innerFailure).toBeInstanceOf(Error);
    });

    const executor = createStoreExecutor(database);
    const rows = executor.all("SELECT name FROM widgets ORDER BY name");
    expect(rows).toEqual([{ name: "outer" }]);
  });
});

describe("withTransaction — a failing ROLLBACK", () => {
  test("chains the rollback failure as cause, without shadowing the original error", () => {
    const real = freshDatabase();
    const rollbackFailure = new Error("rollback failed");
    const originalError = new Error("work failed");

    const faulty = {
      get isOpen() {
        return real.isOpen;
      },
      get isTransaction() {
        return real.isTransaction;
      },
      exec(sql: string) {
        if (sql.trim().toUpperCase().startsWith("ROLLBACK")) {
          throw rollbackFailure;
        }
        real.exec(sql);
      },
      prepare(sql: string) {
        return real.prepare(sql);
      },
      close() {
        real.close();
      },
    } as unknown as DatabaseSync;

    let thrown: unknown;
    try {
      withTransaction(faulty, () => {
        throw originalError;
      });
    } catch (error) {
      thrown = error;
    }

    // Unreachable with a real database — the original error is still the
    // thrown one, but the rollback failure must be reachable through the
    // cause chain rather than shadowing it.
    expect(thrown).toBe(originalError);
    expect((thrown as Error).cause).toBe(rollbackFailure);
  });
});

describe("createStoreExecutor — query failure classification (phase: query)", () => {
  test("a syntax error is raised as ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    let thrown: unknown;
    try {
      executor.all("SELEKT * FROM widgets");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("use-after-close is raised as ERR_CONSOLE_STORE_CLOSED", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    database.close();

    let thrown: unknown;
    try {
      executor.all("SELECT * FROM widgets");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });
});
