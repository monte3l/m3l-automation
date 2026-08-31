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

  // #807. `run()` was the one query method that never called
  // `setReadBigInts`, so `lastInsertRowid` came back as a JS number and any
  // rowid above 2^53 was silently truncated — no throw, no warning. An
  // `INTEGER PRIMARY KEY` this large is reachable in practice (an explicit
  // id, or an `AUTOINCREMENT` sequence seeded high), and the corruption is
  // worst where it matters most: the identity of a row just written.
  test("run() returns an exact bigint for a rowid above Number.MAX_SAFE_INTEGER", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 — not representable as a number

    const result = executor.run(
      "INSERT INTO widgets (id, name) VALUES (?, ?)",
      [huge, "huge"],
    );

    expect(typeof result.lastInsertRowid).toBe("bigint");
    expect(result.lastInsertRowid).toBe(huge);
    // The precise failure this locks out: 9007199254740993 rounds to
    // ...992 the moment it is read as a double.
    expect(result.lastInsertRowid).not.toBe(9_007_199_254_740_992n);
  });

  test("run() still returns a plain number for a rowid inside the safe-integer range", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    const result = executor.run("INSERT INTO widgets (name) VALUES (?)", [
      "small",
    ]);

    expect(typeof result.lastInsertRowid).toBe("number");
    expect(result.lastInsertRowid).toBe(1);
    expect(result.changes).toBe(1);
  });

  // SQLite's INTEGER PRIMARY KEY accepts negative rowids, so a narrowing that
  // only bounds the top corrupts the negative tail exactly as the original
  // defect corrupted the positive one.
  test("run() returns a plain number for a small negative rowid", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);

    const result = executor.run(
      "INSERT INTO widgets (id, name) VALUES (?, ?)",
      [-42, "negative"],
    );

    expect(typeof result.lastInsertRowid).toBe("number");
    expect(result.lastInsertRowid).toBe(-42);
  });

  // The assertion that actually pins narrowRowid's LOWER bound: a rowid this
  // negative is only exact as a bigint. Dropping the `>= MIN_SAFE_INTEGER`
  // half of the check leaves the small-negative test above green and only
  // this one red — verified by mutation.
  test("run() returns an exact bigint for a rowid below Number.MIN_SAFE_INTEGER", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    const veryNegative = -9_007_199_254_740_993n; // -(2^53 + 1)

    const result = executor.run(
      "INSERT INTO widgets (id, name) VALUES (?, ?)",
      [veryNegative, "very negative"],
    );

    expect(typeof result.lastInsertRowid).toBe("bigint");
    expect(result.lastInsertRowid).toBe(veryNegative);
    expect(result.lastInsertRowid).not.toBe(-9_007_199_254_740_992n);
  });

  // The second half of #807, unreported: because statements are cached by SQL
  // text and `run()` never set the flag, a prior bigint READ of the same SQL
  // left it set and the next `run()` silently inherited it. This mirrors the
  // get()-side leak test above, on the write path.
  test("a prior bigint read does not leak into a later run() on the same cached SQL", () => {
    const database = freshDatabase();
    const executor = createStoreExecutor(database);
    // One SQL text reached through BOTH methods is what makes the leak
    // possible at all — the cache is keyed on this string, so `get()` and
    // `run()` here share a single prepared statement and its flag.
    // `RETURNING` is what makes an INSERT legitimately readable via `get()`.
    const sql = "INSERT INTO widgets (name) VALUES (?) RETURNING id";

    const returned = executor.get(sql, ["first"], { readBigInts: true });
    expect(typeof returned?.["id"]).toBe("bigint");

    const result = executor.run(sql, ["second"]);

    expect(typeof result.lastInsertRowid).toBe("number");
    expect(result.lastInsertRowid).toBe(2);
    expect(result.changes).toBe(1);
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

/**
 * Wraps a real `:memory:` database (with the `widgets` schema already
 * applied), throwing `error` for any `exec()` call where `shouldThrow(sql)`
 * is `true`; every other `exec`/`prepare`/`close` call delegates to the real
 * backing database. Unlike `createRecordingDatabase`, this lets a test
 * supply an arbitrary error shape (e.g. a specific `errcode`) rather than a
 * generic synthetic failure.
 */
function createDatabaseWithExecFailure(
  shouldThrow: (sql: string) => boolean,
  error: unknown,
): DatabaseSync {
  const real = freshDatabase();
  const handle = {
    get isOpen() {
      return real.isOpen;
    },
    get isTransaction() {
      return real.isTransaction;
    },
    exec(sql: string) {
      if (shouldThrow(sql)) throw error;
      real.exec(sql);
    },
    prepare(sql: string) {
      return real.prepare(sql);
    },
    close() {
      real.close();
    },
  };
  return handle as unknown as DatabaseSync;
}

/**
 * Builds an `ERR_SQLITE_ERROR`-shaped error with `errcode: 5` (SQLITE_BUSY,
 * per `store/sqlite-driver.ts`'s measured table) — mimics a real
 * `node:sqlite` "competing writer" failure at `BEGIN IMMEDIATE` without a
 * real second writer/process.
 */
function buildBusyError(): NodeJS.ErrnoException {
  const error = new Error("database is locked") as NodeJS.ErrnoException & {
    errcode?: number;
  };
  error.code = "ERR_SQLITE_ERROR";
  error.errcode = 5;
  return error;
}

describe("withTransaction — its own BEGIN IMMEDIATE/COMMIT calls escape classification [MUST-FIX, PR #706 finding 1]", () => {
  // withTransaction's own TSDoc advertises BEGIN IMMEDIATE failing fast under
  // a competing writer as the BUSY design's entire premise — this is the
  // headline case: that exact failure must surface as
  // ERR_CONSOLE_STORE_BUSY, not the raw node:sqlite error.
  test("a BEGIN IMMEDIATE failure with errcode 5 surfaces as ERR_CONSOLE_STORE_BUSY, not a raw node:sqlite error", () => {
    const busyError = buildBusyError();
    const faulty = createDatabaseWithExecFailure(
      (sql) => sql === "BEGIN IMMEDIATE",
      busyError,
    );

    let thrown: unknown;
    try {
      withTransaction(faulty, () => undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_BUSY");
  });

  test("a COMMIT failure surfaces as an M3LConsoleError classified for phase 'query', not a raw error", () => {
    const commitFailure = new Error("commit boom");
    const faulty = createDatabaseWithExecFailure(
      (sql) => sql === "COMMIT",
      commitFailure,
    );

    let thrown: unknown;
    try {
      withTransaction(faulty, (tx: TestTransaction) => {
        tx.run("INSERT INTO widgets (name) VALUES (?)", ["x"]);
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });

  test("a SAVEPOINT failure inside nested() surfaces as an M3LConsoleError, not a raw error", () => {
    const savepointFailure = new Error("savepoint boom");
    const faulty = createDatabaseWithExecFailure(
      (sql) => sql.startsWith("SAVEPOINT "),
      savepointFailure,
    );

    let thrown: unknown;
    try {
      withTransaction(faulty, (tx: TestTransaction) => {
        tx.nested(() => undefined);
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
  });
});

/**
 * Walks `start`'s `cause` chain (including `start` itself), returning `true`
 * the first time `predicate` matches a node. Guards against a cyclical chain
 * with a `seen` set.
 */
function causeChainIncludes(
  start: unknown,
  predicate: (value: unknown) => boolean,
): boolean {
  const seen = new Set<unknown>();
  let current = start;
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    if (predicate(current)) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

describe("withTransaction — a failing ROLLBACK after a classified work failure [SHOULD-FIX, PR #706 finding 3]", () => {
  // The existing "a failing ROLLBACK" test above throws a plain Error with
  // no prior `cause`, so it passes identically whether or not the original
  // cause is preserved — that is why this double-fault case survived: it
  // needs `work` to fail through `executeOrThrow` FIRST (so the thrown
  // M3LConsoleError already carries a real cause), and THEN have the
  // ROLLBACK also fail.
  test("does not overwrite the original error's cause — it stays reachable by walking the chain", () => {
    const rollbackFailure = new Error("rollback failed");
    const faulty = createDatabaseWithExecFailure(
      (sql) => sql.trim().toUpperCase().startsWith("ROLLBACK"),
      rollbackFailure,
    );

    let thrown: unknown;
    try {
      withTransaction(faulty, (tx: TestTransaction) => {
        // A genuinely invalid statement: forces executeOrThrow to classify
        // the raw node:sqlite failure into a real M3LConsoleError whose
        // `cause` is that raw failure — the "already carries a cause" case.
        tx.run("INSERT INTO nonexistent_table (name) VALUES (?)", ["x"]);
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const workFailure = thrown as M3LConsoleError;

    // Regression lock for a bug that used to overwrite `.cause`
    // unconditionally, discarding the original node:sqlite failure that made
    // `work` throw in the first place. `chainSecondaryFailure` walks to the
    // first free `cause` slot instead of replacing it, so the rollback
    // failure is chained in without replacing the original.
    expect(workFailure.cause).toBeDefined();
    expect(workFailure.cause).not.toBe(rollbackFailure);

    // The rollback failure must be chained on somewhere...
    expect(
      causeChainIncludes(workFailure, (value) => value === rollbackFailure),
    ).toBe(true);
    // ...WITHOUT replacing the original node:sqlite failure that caused
    // `work` to fail in the first place.
    expect(
      causeChainIncludes(
        workFailure,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { code?: unknown }).code === "ERR_SQLITE_ERROR",
      ),
    ).toBe(true);
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
