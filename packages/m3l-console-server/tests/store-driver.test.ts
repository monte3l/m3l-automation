/**
 * Tests for `src/store/sqlite-driver.ts` — X3 console-persistence slice A3
 * (ADR-0069). This file IS the ADR-0069 stability checkpoint: it drives the
 * REAL `node:sqlite` builtin through `openSqliteDatabase`, so CI re-runs it
 * on the Node 24 floor on every push. A future Node patch that moves the
 * bigint trap, a constraint errcode, or the transactional-PRAGMA behaviour
 * makes THIS file go red with a legible message, instead of surfacing as
 * silent corruption in production.
 *
 * Uses `:memory:` throughout — no filesystem I/O anywhere in this file.
 *
 * Imports only `src/store/sqlite-driver.ts` (its own slice), plus
 * `src/errors/console-error.ts` for the `assertSqliteSupport` rejection
 * assertion. It deliberately does NOT import `src/store/failures.ts` —
 * `perFile` v8 coverage binds a src file to every test file that imports
 * it, so a cross-slice import would re-bind coverage across the layer.
 */
import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  assertSqliteSupport,
  openSqliteDatabase,
  readUserVersion,
} from "../src/store/sqlite-driver.js";
import type {
  M3LSqliteDatabaseHandle,
  M3LSqliteStatementHandle,
} from "../src/store/sqlite-driver.js";
import type { M3LStoreRow } from "../src/store/types.js";

/** Reads a scalar column off a port-level row without assuming a prototype. */
function readColumn(row: unknown, column: string): unknown {
  return (row as Record<string, unknown>)[column];
}

/** Parses a `sqlite_version()` string ("3.53.4") into comparable number parts. */
function parseVersion(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/** `true` when `left` is numerically >= `right`, comparing major/minor/patch in order. */
function versionAtLeast(
  left: readonly number[],
  right: readonly number[],
): boolean {
  for (let index = 0; index < right.length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) return true;
    if (leftPart < rightPart) return false;
  }
  return true;
}

describe("openSqliteDatabase — port conformance", () => {
  test("a real :memory: handle exposes every member the port consumes", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      expect(typeof database.exec).toBe("function");
      expect(typeof database.prepare).toBe("function");
      expect(typeof database.close).toBe("function");
      expect(typeof database.isOpen).toBe("boolean");
      expect(typeof database.isTransaction).toBe("boolean");

      const statement = database.prepare("SELECT 1 AS one");
      expect(typeof statement.run).toBe("function");
      expect(typeof statement.get).toBe("function");
      expect(typeof statement.all).toBe("function");
      expect(typeof statement.setReadBigInts).toBe("function");
    } finally {
      database.close();
    }
  });
});

describe("PRAGMA user_version", () => {
  test("round-trips through exec with an interpolated integer", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec("PRAGMA user_version = 7");
      const row = database.prepare("PRAGMA user_version").get();
      expect(readColumn(row, "user_version")).toBe(7);
    } finally {
      database.close();
    }
  });

  test("throws ERR_SQLITE_ERROR ('near \"?\": syntax error') when bound as a parameter instead of interpolated", () => {
    // This is why the migration runner must interpolate a validated integer
    // rather than bind one.
    const database = openSqliteDatabase(":memory:");
    try {
      let thrown: unknown;
      try {
        database.prepare("PRAGMA user_version = ?").run(7);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as NodeJS.ErrnoException;
      expect(error.code).toBe("ERR_SQLITE_ERROR");
      expect(error.message).toContain('near "?": syntax error');
    } finally {
      database.close();
    }
  });

  test("is transactional: a ROLLBACK reverts a user_version set inside BEGIN IMMEDIATE", () => {
    // This is the property that makes user_version the authoritative version
    // store instead of a table.
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec("PRAGMA user_version = 0");
      database.exec("BEGIN IMMEDIATE");
      database.exec("PRAGMA user_version = 42");
      database.exec("ROLLBACK");

      const row = database.prepare("PRAGMA user_version").get();
      expect(readColumn(row, "user_version")).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("isTransaction", () => {
  test.each<["COMMIT" | "ROLLBACK"]>([["COMMIT"], ["ROLLBACK"]])(
    "flips true on BEGIN and back to false on %s",
    (closingStatement) => {
      const database = openSqliteDatabase(":memory:");
      try {
        expect(database.isTransaction).toBe(false);
        database.exec("BEGIN");
        expect(database.isTransaction).toBe(true);
        database.exec(closingStatement);
        expect(database.isTransaction).toBe(false);
      } finally {
        database.close();
      }
    },
  );
});

describe("savepoint nesting", () => {
  test("ROLLBACK TO discards only the inner writes, the outer write survives", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
      database.exec("BEGIN IMMEDIATE");
      database.exec("INSERT INTO t (id, label) VALUES (1, 'outer')");
      database.exec("SAVEPOINT sp1");
      database.exec("INSERT INTO t (id, label) VALUES (2, 'inner')");
      database.exec("ROLLBACK TO sp1");
      database.exec("RELEASE sp1");
      database.exec("COMMIT");

      const rows = database.prepare("SELECT id FROM t ORDER BY id").all();
      const ids = rows.map((row: unknown) => readColumn(row, "id"));
      expect(ids).toEqual([1]);
    } finally {
      database.close();
    }
  });
});

describe("bigint reads", () => {
  // 2^63 - 1: representable in SQLite's signed 64-bit INTEGER, but above
  // Number.MAX_SAFE_INTEGER (2^53 - 1).
  const ABOVE_SAFE_INTEGER_LITERAL = "9223372036854775807";

  test("reading an INTEGER above Number.MAX_SAFE_INTEGER throws ERR_OUT_OF_RANGE rather than truncating", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE big (n INTEGER)");
      database.exec(
        `INSERT INTO big (n) VALUES (${ABOVE_SAFE_INTEGER_LITERAL})`,
      );

      const statement = database.prepare("SELECT n FROM big");
      let thrown: unknown;
      try {
        statement.get();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as NodeJS.ErrnoException).code).toBe("ERR_OUT_OF_RANGE");
    } finally {
      database.close();
    }
  });

  test("the same read yields a bigint once setReadBigInts(true) is set on the statement", () => {
    // Confirms setReadBigInts is what makes the flag mandatory rather than
    // an optimization: the same column, the same statement text, reads
    // successfully only once the flag is set.
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE big (n INTEGER)");
      database.exec(
        `INSERT INTO big (n) VALUES (${ABOVE_SAFE_INTEGER_LITERAL})`,
      );

      const statement = database.prepare("SELECT n FROM big");
      statement.setReadBigInts(true);
      const row = statement.get();
      const value = readColumn(row, "n");
      expect(typeof value).toBe("bigint");
      expect(value).toBe(9223372036854775807n);
    } finally {
      database.close();
    }
  });
});

describe("constraint family", () => {
  test("NOT NULL and UNIQUE violations carry different errcodes but the same errcode & 0xff === 19", () => {
    // A classifier written against the literal errcodes alone would pass a
    // test that only checked one of these — assert the masking explicitly.
    const database = openSqliteDatabase(":memory:");
    try {
      database.exec(
        "CREATE TABLE c (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
      );
      database.prepare("INSERT INTO c (id, name) VALUES (?, ?)").run(1, "a");

      let notNullError: unknown;
      try {
        database.exec("INSERT INTO c (id, name) VALUES (2, NULL)");
      } catch (error) {
        notNullError = error;
      }

      let uniqueError: unknown;
      try {
        database.prepare("INSERT INTO c (id, name) VALUES (?, ?)").run(3, "a");
      } catch (error) {
        uniqueError = error;
      }

      const notNull = notNullError as NodeJS.ErrnoException & {
        errcode: number;
      };
      const unique = uniqueError as NodeJS.ErrnoException & { errcode: number };

      expect(notNull.errcode).toBe(1299);
      expect(unique.errcode).toBe(2067);
      expect(notNull.errcode).not.toBe(unique.errcode);
      expect(notNull.errcode & 0xff).toBe(19);
      expect(unique.errcode & 0xff).toBe(19);
    } finally {
      database.close();
    }
  });
});

describe("close()", () => {
  test("a double close() throws ERR_INVALID_STATE, not ERR_SQLITE_ERROR", () => {
    // This is the fact that makes `closed` a distinct classification kind
    // from a generic SQL failure.
    const database = openSqliteDatabase(":memory:");
    database.close();

    let thrown: unknown;
    try {
      database.close();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as NodeJS.ErrnoException;
    expect(error.code).toBe("ERR_INVALID_STATE");
    expect(error.code).not.toBe("ERR_SQLITE_ERROR");
  });
});

describe("enableForeignKeyConstraints", () => {
  // Measured: foreign_keys defaults ON, so a test asserting `true -> 1` with
  // no option passed would guard NOTHING — every implementation, buggy or
  // not, produces 1 by default. `false` is the only arm that discriminates
  // whether the option is actually wired through to the real handle.
  test("{ enableForeignKeyConstraints: false } yields PRAGMA foreign_keys 0", () => {
    const database = openSqliteDatabase(":memory:", {
      enableForeignKeyConstraints: false,
    });
    try {
      const row = database.prepare("PRAGMA foreign_keys").get();
      expect(readColumn(row, "foreign_keys")).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("sqlite_version()", () => {
  test("is at least 3.37 (what STRICT tables need), compared numerically", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const row = database.prepare("SELECT sqlite_version() AS version").get();
      const version = readColumn(row, "version");
      expect(typeof version).toBe("string");
      expect(versionAtLeast(parseVersion(version as string), [3, 37])).toBe(
        true,
      );
    } finally {
      database.close();
    }
  });
});

describe("assertSqliteSupport", () => {
  test("accepts a real :memory: handle", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      expect(() => {
        assertSqliteSupport(database);
      }).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("rejects a handle whose statement is missing setReadBigInts with ERR_CONSOLE_STORE_UNSUPPORTED", () => {
    const fakeStatement: Pick<M3LSqliteStatementHandle, "run" | "get" | "all"> =
      {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => [],
      };
    const fakeDatabase = {
      isOpen: true,
      isTransaction: false,
      exec: () => undefined,
      prepare: () => fakeStatement,
      close: () => undefined,
      // Intentionally invalid: this fake never conforms to
      // M3LSqliteDatabaseHandle because its statement lacks setReadBigInts —
      // that is precisely the shape assertSqliteSupport must reject.
    } as unknown as M3LSqliteDatabaseHandle;

    let thrown: unknown;
    try {
      assertSqliteSupport(fakeDatabase);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
    );
  });
});

describe("readUserVersion — exported directly [MUST-FIX, PR #706 finding 2]", () => {
  // `readUserVersion` is exported and documented `@throws Error` — any
  // caller other than `store/store.ts` (which happens to wrap it) gets a
  // bare, non-M3LError value with no code and no cause chain. This is the
  // driver's own established code for "the builtin is not behaving as this
  // package requires" (the same code `assertSqliteSupport`'s tripwires
  // below assert) — it must be raised here directly, not only by the
  // wrapper.
  test("throws ERR_CONSOLE_STORE_UNSUPPORTED, not a bare Error, when PRAGMA user_version does not read back as a number", () => {
    const fakeDatabase = {
      isOpen: true,
      isTransaction: false,
      exec: () => undefined,
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => ({ user_version: "not-a-number" }),
        all: () => [],
        setReadBigInts: () => undefined,
      }),
      close: () => undefined,
    } as unknown as M3LSqliteDatabaseHandle;

    let thrown: unknown;
    try {
      readUserVersion(fakeDatabase);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
    );
  });
});

/**
 * A stubbed statement whose only real behaviour is `get()` returning a
 * fixed row — `run`/`all`/`setReadBigInts` are unused by every path these
 * tripwires exercise, but are still real no-op functions so the fake
 * remains structurally assignable to {@link M3LSqliteStatementHandle}
 * without a cast.
 */
function stubStatement(row: M3LStoreRow): M3LSqliteStatementHandle {
  return {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => row,
    all: () => [],
    setReadBigInts: () => undefined,
  };
}

describe("assertSqliteSupport — checkpoint tripwires unreachable with a real handle", () => {
  // A genuine node:sqlite handle can never take any of these branches today:
  // isOpen/isTransaction are always booleans, PRAGMA user_version always
  // round-trips transactionally, and sqlite_version() always reports a real
  // semver string above the floor. Each case below crafts a narrow fake —
  // mostly a real :memory: handle with one call intercepted — to prove the
  // branch exists and reports ERR_CONSOLE_STORE_UNSUPPORTED, for a FUTURE
  // node:sqlite that changes one of those behaviours. Do not delete these as
  // dead code: they are the ADR-0069 checkpoint's tripwires, not redundant
  // coverage of the happy path.

  test("rejects a handle whose isOpen is not a boolean", () => {
    const fakeStatement = stubStatement({ one: 1 });
    const fakeDatabase = {
      isOpen: undefined,
      isTransaction: false,
      exec: () => undefined,
      prepare: () => fakeStatement,
      close: () => undefined,
    } as unknown as M3LSqliteDatabaseHandle;

    let thrown: unknown;
    try {
      assertSqliteSupport(fakeDatabase);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
    );
  });

  test("rejects a handle whose isTransaction is not a boolean", () => {
    const fakeStatement = stubStatement({ one: 1 });
    const fakeDatabase = {
      isOpen: true,
      isTransaction: "no",
      exec: () => undefined,
      prepare: () => fakeStatement,
      close: () => undefined,
    } as unknown as M3LSqliteDatabaseHandle;

    let thrown: unknown;
    try {
      assertSqliteSupport(fakeDatabase);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
    );
  });

  test("rejects a handle whose user_version probe would overflow Number.isSafeInteger", () => {
    const real = openSqliteDatabase(":memory:");
    try {
      const fakeDatabase: M3LSqliteDatabaseHandle = {
        get isOpen() {
          return real.isOpen;
        },
        get isTransaction() {
          return real.isTransaction;
        },
        exec: (sql) => {
          real.exec(sql);
        },
        prepare: (sql) =>
          sql === "PRAGMA user_version"
            ? stubStatement({ user_version: Number.MAX_SAFE_INTEGER })
            : real.prepare(sql),
        close: () => {
          real.close();
        },
      };

      let thrown: unknown;
      try {
        assertSqliteSupport(fakeDatabase);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_STORE_UNSUPPORTED",
      );
    } finally {
      if (real.isOpen) real.close();
    }
  });

  test("rejects a handle whose user_version read-back does not match what was written", () => {
    const real = openSqliteDatabase(":memory:");
    try {
      const fakeDatabase: M3LSqliteDatabaseHandle = {
        get isOpen() {
          return real.isOpen;
        },
        get isTransaction() {
          return real.isTransaction;
        },
        exec: (sql) => {
          real.exec(sql);
        },
        prepare: (sql) =>
          sql === "PRAGMA user_version"
            ? // Always reports the same value regardless of the write the
              // caller just issued — this is what a broken round-trip looks
              // like from the caller's side.
              stubStatement({ user_version: 5 })
            : real.prepare(sql),
        close: () => {
          real.close();
        },
      };

      let thrown: unknown;
      try {
        assertSqliteSupport(fakeDatabase);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_STORE_UNSUPPORTED",
      );
    } finally {
      if (real.isOpen) real.close();
    }
  });

  test("rejects a handle reporting sqlite_version() below the 3.37 floor", () => {
    const real = openSqliteDatabase(":memory:");
    try {
      const fakeDatabase: M3LSqliteDatabaseHandle = {
        get isOpen() {
          return real.isOpen;
        },
        get isTransaction() {
          return real.isTransaction;
        },
        exec: (sql) => {
          real.exec(sql);
        },
        prepare: (sql) =>
          sql === "SELECT sqlite_version() AS version"
            ? stubStatement({ version: "3.36.0" })
            : real.prepare(sql),
        close: () => {
          real.close();
        },
      };

      let thrown: unknown;
      try {
        assertSqliteSupport(fakeDatabase);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_STORE_UNSUPPORTED",
      );
    } finally {
      if (real.isOpen) real.close();
    }
  });

  test("accepts sqlite_version() equal to the floor at every compared part (versionAtLeast's fall-through arm)", () => {
    // [3, 37, 0] vs the floor [3, 37]: both compared parts are equal, so
    // versionAtLeast's loop never takes its `>` or `<` return and instead
    // falls through to `return true` after the loop — the arm a version
    // strictly above the floor (the real handle's own version) never hits.
    const real = openSqliteDatabase(":memory:");
    try {
      const fakeDatabase: M3LSqliteDatabaseHandle = {
        get isOpen() {
          return real.isOpen;
        },
        get isTransaction() {
          return real.isTransaction;
        },
        exec: (sql) => {
          real.exec(sql);
        },
        prepare: (sql) =>
          sql === "SELECT sqlite_version() AS version"
            ? stubStatement({ version: "3.37.0" })
            : real.prepare(sql),
        close: () => {
          real.close();
        },
      };

      expect(() => {
        assertSqliteSupport(fakeDatabase);
      }).not.toThrow();
    } finally {
      if (real.isOpen) real.close();
    }
  });
});
