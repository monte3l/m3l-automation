/**
 * Tests for `src/store/failures.ts` — X3 console-persistence slice A3
 * (ADR-0069). `failures.ts` is a pure classification module with no
 * `node:sqlite` import and no I/O, which is exactly how these failure
 * branches get unit coverage without a real lock, a real corrupt file, or a
 * real second writer.
 *
 * Imports only `src/store/failures.ts` (its own slice) and
 * `src/errors/console-error.ts` for the `M3LConsoleError`/`M3LConsoleErrorCode`
 * shape `storeError` returns. Deliberately does NOT import
 * `src/store/sqlite-driver.ts` — `perFile` v8 coverage binds a src file to
 * every test file that imports it, so a cross-slice import would re-bind
 * coverage across the layer. The leak test below imports `node:sqlite`
 * directly (not the driver module) to produce one real native failure.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleErrorCode } from "../src/errors/console-error.js";
import { classifyStoreFailure, storeError } from "../src/store/failures.js";
import type {
  M3LStoreFailureKind,
  M3LStorePhase,
} from "../src/store/failures.js";

describe("classifyStoreFailure", () => {
  test.each<[unknown, M3LStoreFailureKind]>([
    [{ code: "ERR_SQLITE_ERROR", errcode: 5 }, "busy"],
    // 261 & 0xff === 5 — proves the classifier masks with `& 0xff` rather
    // than switching on the raw extended errcode literal.
    [{ code: "ERR_SQLITE_ERROR", errcode: 261 }, "busy"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 1299 }, "constraint"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 2067 }, "constraint"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 14 }, "unopenable"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 26 }, "unopenable"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 1 }, "sql"],
    [{ code: "ERR_INVALID_STATE" }, "closed"],
    [
      Object.assign(new RangeError("value out of range"), {
        code: "ERR_OUT_OF_RANGE",
      }),
      "outOfRange",
    ],
    [new Error("a plain error"), "unknown"],
    ["a plain string is not an object", "unknown"],
    [null, "unknown"],
  ])("classifies %j as %s", (cause, expectedKind) => {
    expect(classifyStoreFailure(cause)).toBe(expectedKind);
  });

  test("an object carrying both code ERR_INVALID_STATE and a busy-looking errcode classifies as closed, not busy", () => {
    // A retry loop that treated a closed handle as busy would spin forever
    // against it — ERR_INVALID_STATE must be checked before the errcode
    // switch, not after.
    const hostile = { code: "ERR_INVALID_STATE", errcode: 5 };

    expect(classifyStoreFailure(hostile)).toBe("closed");
    expect(classifyStoreFailure(hostile)).not.toBe("busy");
  });

  test("a throwing code getter classifies as unknown instead of propagating the getter's throw", () => {
    // A classifier used on the failure path must not itself throw.
    const hostile: { readonly code: string } = {
      get code(): string {
        throw new Error("hostile getter");
      },
    };

    expect(classifyStoreFailure(hostile)).toBe("unknown");
  });
});

describe("storeError", () => {
  // Every (kind, phase) pair reachable in PR A. `phase: "migrate"` is a PR B
  // concern (ERR_CONSOLE_STORE_MIGRATION_FAILED does not exist yet) and is
  // deliberately excluded, per the contract.
  test.each<[M3LStoreFailureKind, M3LStorePhase, M3LConsoleErrorCode]>([
    ["busy", "open", "ERR_CONSOLE_STORE_BUSY"],
    ["busy", "query", "ERR_CONSOLE_STORE_BUSY"],
    ["closed", "open", "ERR_CONSOLE_STORE_CLOSED"],
    ["closed", "query", "ERR_CONSOLE_STORE_CLOSED"],
    ["unopenable", "open", "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["unopenable", "query", "ERR_CONSOLE_STORE_QUERY_FAILED"],
    ["constraint", "open", "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["constraint", "query", "ERR_CONSOLE_STORE_QUERY_FAILED"],
    ["sql", "open", "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["sql", "query", "ERR_CONSOLE_STORE_QUERY_FAILED"],
    ["outOfRange", "open", "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["outOfRange", "query", "ERR_CONSOLE_STORE_QUERY_FAILED"],
    ["unknown", "open", "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["unknown", "query", "ERR_CONSOLE_STORE_QUERY_FAILED"],
  ])("storeError(%s, %s, ...) maps to %s", (kind, phase, expectedCode) => {
    const error = storeError(
      kind,
      phase,
      "a safe, non-interpolated message",
      new Error("original"),
    );

    expect(error).toBeInstanceOf(M3LConsoleError);
    expect(error.code).toBe(expectedCode);
  });
});

describe("storeError — leak discipline", () => {
  test("never surfaces a bound secret through message, context, or the cause chain, and never carries SQL-shaped context keys", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE secrets (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)",
      );

      // Assembled at runtime from two substrings, never a single source
      // literal — gitleaks scans source text and this repo has no
      // `.gitleaksignore` (see `.claude/rules/tests.md` and
      // `diagnostics-run-report.test.ts:144-148`).
      const SECRET_PREFIX = "sk" + "_live_";
      const SECRET = SECRET_PREFIX + "9f3c1a7e2b0d4f6a";

      database
        .prepare("INSERT INTO secrets (id, label) VALUES (?, ?)")
        .run(1, SECRET);

      let nativeCause: unknown;
      try {
        database
          .prepare("INSERT INTO secrets (id, label) VALUES (?, ?)")
          .run(2, SECRET);
      } catch (error) {
        nativeCause = error;
      }
      expect(nativeCause).toBeInstanceOf(Error);

      // Simulates a careless call site handing storeError a context bag
      // built from the failing statement's diagnostic surface — exactly the
      // shape a naive "log everything" implementation would construct.
      const hostileContext: Record<string, unknown> = {
        sql: "INSERT INTO secrets (id, label) VALUES (2, ?)",
        parameters: [2, SECRET],
        bindings: [2, SECRET],
        expandedSQL: `INSERT INTO secrets (id, label) VALUES (2, '${SECRET}')`,
        errstr: `constraint failed carrying ${SECRET}`,
      };

      const consoleError = storeError(
        "constraint",
        "query",
        "insert into secrets failed",
        nativeCause,
        hostileContext,
      );

      expect(consoleError.message).not.toContain(SECRET);

      const serializedContext = JSON.stringify(consoleError.context);
      expect(serializedContext).not.toContain(SECRET);

      const contextKeys = Object.keys(consoleError.context);
      for (const forbiddenKey of [
        "sql",
        "parameters",
        "bindings",
        "expandedSQL",
        "errstr",
      ]) {
        expect(contextKeys).not.toContain(forbiddenKey);
      }

      // Full serialized cause chain: walk `.cause` links, serializing each
      // link's own message plus its enumerable own properties, and assert
      // the secret appears in none of them.
      const seen = new Set<unknown>();
      const chainParts: string[] = [];
      let node: unknown = consoleError;
      while (
        node !== null &&
        node !== undefined &&
        typeof node === "object" &&
        !seen.has(node)
      ) {
        seen.add(node);
        const record = node as { message?: unknown; cause?: unknown };
        chainParts.push(
          typeof record.message === "string" ? record.message : "",
        );
        chainParts.push(JSON.stringify(node));
        node = record.cause;
      }
      expect(chainParts.join("\n")).not.toContain(SECRET);
    } finally {
      database.close();
    }
  });
});

describe("storeError — message is never augmented with cause detail", () => {
  // The leak test above plants a secret as a *bound parameter* and asserts
  // the secret is absent from `message` — but SQLite's own diagnostic text
  // names the offending *identifier* (a table/column name), never the bound
  // value, so that assertion holds even if `storeError` were to interpolate
  // `cause.message` straight into the mapped message. That leaves a real gap:
  // `errstr` is forbidden alongside `sql`/bound parameters/`expandedSQL`
  // regardless of whether it happens to carry a secret in a given call. This
  // test drives a genuine `node:sqlite` failure (not a hand-built fixture) so
  // `cause.message` is real SQLite `errstr` text, and asserts `message` is
  // *exactly* the safe string passed in — never that string plus any
  // fragment of `cause`'s message. Do not delete this as redundant with the
  // leak test: it is the only test that would catch the identifier-leaking
  // shape of the mutation described above.

  test("a constraint-violation cause's identifier-bearing message never reaches the mapped message", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE secrets (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)",
      );
      database.prepare("INSERT INTO secrets (id, label) VALUES (?, ?)").run(
        1,
        // Assembled at runtime from two substrings, never a single source
        // literal (see the leak test above and `.claude/rules/tests.md`).
        "sk" + "_live_placeholder",
      );

      let nativeCause: unknown;
      try {
        database.prepare("INSERT INTO secrets (id, label) VALUES (?, ?)").run(
          2,
          // Assembled at runtime, same rationale as above.
          "sk" + "_live_placeholder",
        );
      } catch (error) {
        nativeCause = error;
      }
      expect(nativeCause).toBeInstanceOf(Error);
      const causeMessage = (nativeCause as Error).message;
      // Sanity-check the fixture: the real SQLite errstr must actually name
      // the column, or this test would pass for the wrong reason (an empty
      // cause message).
      expect(causeMessage).toContain("secrets.label");

      const safeMessage = "a safe, non-interpolated message";
      const consoleError = storeError(
        "constraint",
        "query",
        safeMessage,
        nativeCause,
      );

      expect(consoleError.message).toBe(safeMessage);
      expect(consoleError.message).not.toContain("secrets.label");
      expect(consoleError.cause).toBe(nativeCause);
    } finally {
      database.close();
    }
  });

  test("a syntax-error cause's statement-echoing message never reaches the mapped message", () => {
    const database = new DatabaseSync(":memory:");
    try {
      let nativeCause: unknown;
      try {
        database.exec("SELCT * FROM nowhere");
      } catch (error) {
        nativeCause = error;
      }
      expect(nativeCause).toBeInstanceOf(Error);
      const causeMessage = (nativeCause as Error).message;
      // Sanity-check the fixture: SQLite's syntax-error errstr echoes a
      // fragment of the offending statement.
      expect(causeMessage).toContain("SELCT");

      const safeMessage = "a safe, non-interpolated message";
      const consoleError = storeError("sql", "query", safeMessage, nativeCause);

      expect(consoleError.message).toBe(safeMessage);
      expect(consoleError.message).not.toContain("SELCT");
      expect(consoleError.cause).toBe(nativeCause);
    } finally {
      database.close();
    }
  });
});
