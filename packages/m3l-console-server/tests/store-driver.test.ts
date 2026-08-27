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
} from "../src/store/sqlite-driver.js";
import type {
  M3LSqliteDatabaseHandle,
  M3LSqliteStatementHandle,
} from "../src/store/sqlite-driver.js";

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
