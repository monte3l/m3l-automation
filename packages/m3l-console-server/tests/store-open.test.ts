/**
 * Tests for src/store/store.ts — `openConsoleStore` (X3 console-persistence,
 * slice A4, ADR-0069).
 *
 * This file imports only `src/store/store.ts` — never
 * `src/store/executor.ts` or `src/store/sqlite-driver.ts` directly — so v8's
 * `perFile` coverage does not get re-bound across the `store/` slice split.
 * `openConsoleStore` naturally exercises the executor and driver
 * transitively at runtime (a `:memory:` open really does run queries through
 * them); that is expected and fine, it just means this file names none of
 * those modules in an `import`.
 *
 * `openConsoleStore` and `close()` landed synchronous, so every call here is
 * a plain (non-`await`ed) call; failures are captured with `captureFailure`
 * below, which is itself a straightforward synchronous try/catch.
 *
 * No filesystem I/O anywhere in this file: every case uses `:memory:` (no
 * parent-directory step to reach) or an injected `createDatabase` fake. The
 * real-file cases (WAL sidecars, a second writer, a non-SQLite file) belong
 * to the integration pass, which another slice owns.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { openConsoleStore } from "../src/store/store.js";

/**
 * Calls `run`, capturing whatever it throws synchronously as a single
 * `unknown` value. Returns `undefined` on success.
 */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Wraps a real `:memory:` database, recording every `exec()` call, letting a
 * caller force a specific `exec()` call to throw by SQL content, and
 * counting `close()` calls. Every other operation delegates to the real
 * backing database, so `assertSqliteSupport`'s own probing (which runs
 * before the pragma sequence under test) still observes fully correct
 * SQLite behavior.
 */
function createRecordingDatabase(options?: {
  execShouldThrow?: (sql: string) => boolean;
}): {
  handle: DatabaseSync;
  execCalls: string[];
  getCloseCallCount: () => number;
} {
  const real = new DatabaseSync(":memory:");
  const execCalls: string[] = [];
  let closeCallCount = 0;

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
      return real.prepare(sql);
    },
    close() {
      closeCallCount += 1;
      real.close();
    },
  };

  return {
    handle: handle as unknown as DatabaseSync,
    execCalls,
    getCloseCallCount: () => closeCallCount,
  };
}

/**
 * Wraps a real `:memory:` database whose `close()` throws on the FIRST
 * call and succeeds on every subsequent call — proves whether a second
 * `close()` after a failed first one still attempts the underlying close,
 * or silently no-ops on an unreleased handle.
 */
function createDatabaseThrowingOnFirstClose(): {
  handle: DatabaseSync;
  getCloseCallCount: () => number;
} {
  const real = new DatabaseSync(":memory:");
  let closeCallCount = 0;

  const handle = {
    get isOpen() {
      return real.isOpen;
    },
    get isTransaction() {
      return real.isTransaction;
    },
    exec(sql: string) {
      real.exec(sql);
    },
    prepare(sql: string) {
      return real.prepare(sql);
    },
    close() {
      closeCallCount += 1;
      if (closeCallCount === 1) {
        throw new Error("synthetic first-close failure");
      }
      real.close();
    },
  };

  return {
    handle: handle as unknown as DatabaseSync,
    getCloseCallCount: () => closeCallCount,
  };
}

/**
 * Wraps a real `:memory:` database whose `isOpen` is STICKY `true` — it
 * never flips to `false`, even after `close()` runs — so a store handle
 * that merely forwards `database.isOpen` (rather than tracking its own
 * `closed` flag) cannot ever report `isOpen: false`.
 */
function createDatabaseWithStickyIsOpen(): { handle: DatabaseSync } {
  const real = new DatabaseSync(":memory:");

  const handle = {
    isOpen: true,
    get isTransaction() {
      return real.isTransaction;
    },
    exec(sql: string) {
      real.exec(sql);
    },
    prepare(sql: string) {
      return real.prepare(sql);
    },
    close() {
      real.close();
    },
  };

  return { handle: handle as unknown as DatabaseSync };
}

/**
 * Wraps a real `:memory:` database whose `PRAGMA user_version` reads
 * behave normally for `assertSqliteSupport`'s own round-trip probe (which
 * reads it three times: before/during/after a `BEGIN IMMEDIATE` — see
 * `sqlite-driver.ts`'s `assertUserVersionRoundTrip`), but returns a
 * non-number shape on every read AFTER that — i.e. exactly the read
 * `store.ts`'s own `readSchemaVersion` performs once the pragma sequence
 * has run. This isolates the defect under test (`readSchemaVersion`
 * collapsing an unreadable value to `0`) from `assertSqliteSupport`'s own,
 * already-correct throw-on-corruption behavior.
 */
function createDatabaseWithCorruptedFinalUserVersionRead(): {
  handle: DatabaseSync;
} {
  const real = new DatabaseSync(":memory:");
  /** The number of `PRAGMA user_version` reads `assertUserVersionRoundTrip` performs before `readSchemaVersion` ever runs. */
  const ROUND_TRIP_PROBE_READS = 3;
  let userVersionReadCount = 0;

  const handle = {
    get isOpen() {
      return real.isOpen;
    },
    get isTransaction() {
      return real.isTransaction;
    },
    exec(sql: string) {
      real.exec(sql);
    },
    prepare(sql: string) {
      if (sql === "PRAGMA user_version") {
        userVersionReadCount += 1;
        if (userVersionReadCount > ROUND_TRIP_PROBE_READS) {
          return {
            run: (): never => {
              throw new Error("unexpected run() on the corrupted statement");
            },
            get: () => ({ user_version: "not-a-number" }),
            all: (): never => {
              throw new Error("unexpected all() on the corrupted statement");
            },
            setReadBigInts: () => {
              /* no-op */
            },
          };
        }
      }
      return real.prepare(sql);
    },
    close() {
      real.close();
    },
  };

  return { handle: handle as unknown as DatabaseSync };
}

describe("openConsoleStore — :memory: happy path", () => {
  test("opens, reports isOpen true, and exposes its location", () => {
    const store = openConsoleStore({ location: ":memory:" });

    expect(store.isOpen).toBe(true);
    expect(store.location).toBe(":memory:");

    const closeFailure = captureFailure(() => store.close());
    expect(closeFailure).toBeUndefined();
  });
});

describe("openConsoleStore — pragma order (recording fake)", () => {
  test("issues journal_mode = WAL before synchronous and foreign_keys", () => {
    const { handle, execCalls } = createRecordingDatabase();

    openConsoleStore({
      location: ":memory:",
      createDatabase: () => handle,
    });

    const journalModeIndex = execCalls.findIndex((sql) =>
      /journal_mode/i.test(sql),
    );
    const synchronousIndex = execCalls.findIndex((sql) =>
      /synchronous/i.test(sql),
    );
    const foreignKeysIndex = execCalls.findIndex((sql) =>
      /foreign_keys/i.test(sql),
    );

    expect(journalModeIndex).toBeGreaterThanOrEqual(0);
    expect(synchronousIndex).toBeGreaterThanOrEqual(0);
    expect(foreignKeysIndex).toBeGreaterThanOrEqual(0);

    // The ORDER is the guarantee under test — a mutation that moves
    // journal_mode later must fail this, not merely "each pragma ran".
    expect(journalModeIndex).toBeLessThan(synchronousIndex);
    expect(journalModeIndex).toBeLessThan(foreignKeysIndex);
  });
});

describe("openConsoleStore — a factory throw is classified by errcode", () => {
  test.each<[string, number, string]>([
    ["CANTOPEN (errcode 14)", 14, "ERR_CONSOLE_STORE_OPEN_FAILED"],
    ["BUSY (errcode 5)", 5, "ERR_CONSOLE_STORE_BUSY"],
  ])("errcode %s -> %s -> %s", (_label, errcode, expectedCode) => {
    const synthetic = Object.assign(new Error("synthetic sqlite failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode,
    });

    const thrown = captureFailure(() =>
      openConsoleStore({
        location: ":memory:",
        createDatabase: () => {
          throw synthetic;
        },
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(expectedCode);
  });
});

describe("openConsoleStore — use-after-close", () => {
  test("a query call after close() yields ERR_CONSOLE_STORE_CLOSED", () => {
    const store = openConsoleStore({ location: ":memory:" });
    store.close();

    let thrown: unknown;
    try {
      store.get("SELECT 1 AS value");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });
});

describe("openConsoleStore — close()", () => {
  test("is idempotent — a second call is a no-op, never a throw", () => {
    const store = openConsoleStore({ location: ":memory:" });

    const firstCloseFailure = captureFailure(() => store.close());
    const secondCloseFailure = captureFailure(() => store.close());

    expect(firstCloseFailure).toBeUndefined();
    expect(secondCloseFailure).toBeUndefined();
  });

  // `store.ts`'s `close()` sets the local `closed` flag to `true` BEFORE
  // calling `database.close()` — so when the underlying close throws, the
  // handle was never actually released, but the flag already reads
  // "closed". A subsequent call (which the documented contract says must
  // be a safe no-op RETRY) instead short-circuits on `if (closed) return;`
  // and never attempts the underlying close again.
  test("[wiring defect] a second call still attempts the underlying close() after the first one throws", () => {
    const { handle, getCloseCallCount } = createDatabaseThrowingOnFirstClose();
    const store = openConsoleStore({
      location: ":memory:",
      createDatabase: () => handle,
    });

    expect(() => store.close()).toThrow("synthetic first-close failure");
    expect(getCloseCallCount()).toBe(1);

    // The retry: a failed close() left the handle unreleased, so this must
    // reach `database.close()` again, not silently no-op.
    store.close();
    expect(getCloseCallCount()).toBe(2);
  });
});

describe("openConsoleStore — isOpen after close() (wiring defect regression)", () => {
  // `isOpen` forwards `database.isOpen` directly, ignoring the store
  // handle's own `closed` flag — so the two can disagree permanently if the
  // underlying database ever reports `isOpen` unreliably after `close()`.
  test("[wiring defect] reports isOpen: false once close() has been called, even when database.isOpen never flips", () => {
    const { handle } = createDatabaseWithStickyIsOpen();
    const store = openConsoleStore({
      location: ":memory:",
      createDatabase: () => handle,
    });

    store.close();

    expect(store.isOpen).toBe(false);
  });
});

describe("openConsoleStore — an unreadable PRAGMA user_version (wiring defect regression)", () => {
  // `readSchemaVersion` collapses ANY non-number `PRAGMA user_version`
  // shape to `0` — the "unmigrated, run every migration from scratch"
  // value, which against a POPULATED database is the dangerous direction.
  // It must fail loudly instead.
  test("[wiring defect] opening fails with M3LConsoleError rather than silently reporting schemaVersion: 0", () => {
    const { handle } = createDatabaseWithCorruptedFinalUserVersionRead();

    const thrown = captureFailure(() =>
      openConsoleStore({
        location: ":memory:",
        createDatabase: () => handle,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
  });
});

describe("openConsoleStore — a failure after a successful open", () => {
  test("closes the database before re-throwing", () => {
    const { handle, getCloseCallCount } = createRecordingDatabase({
      execShouldThrow: (sql) => /journal_mode/i.test(sql),
    });

    const thrown = captureFailure(() =>
      openConsoleStore({
        location: ":memory:",
        createDatabase: () => handle,
      }),
    );

    // Otherwise a failed boot leaks a handle and leaves a WAL behind — the
    // mutation this pins is deleting the `close()` call on this path.
    expect(thrown).toBeDefined();
    expect(getCloseCallCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("openConsoleStore — an invalid location", () => {
  test("fails with the factory call count still 0", () => {
    let factoryCallCount = 0;

    const thrown = captureFailure(() =>
      openConsoleStore({
        location: "",
        createDatabase: () => {
          factoryCallCount += 1;
          return new DatabaseSync(":memory:");
        },
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    // The count, not merely "it failed" — proving validation ran BEFORE any
    // attempt to open, not after a failed open was caught and reclassified.
    expect(factoryCallCount).toBe(0);
  });
});

describe("openConsoleStore — busyTimeoutMs", () => {
  test("reaches the database factory as `timeout`", () => {
    let receivedOptions: unknown;
    const real = new DatabaseSync(":memory:");

    openConsoleStore({
      location: ":memory:",
      busyTimeoutMs: 4_000,
      createDatabase: (_location: string, options?: { timeout?: number }) => {
        receivedOptions = options;
        return real;
      },
    });

    expect((receivedOptions as { timeout?: number } | undefined)?.timeout).toBe(
      4_000,
    );
  });
});
