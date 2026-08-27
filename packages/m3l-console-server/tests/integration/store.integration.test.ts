/**
 * Integration tests for `src/store/store.ts` (`openConsoleStore`) and
 * `src/store/sqlite-driver.ts` (`openSqliteDatabase`) — X3 console
 * persistence, slice A6, ADR-0069.
 *
 * Written against the `src/store/store.ts` contract while it was being
 * implemented concurrently — same posture as `http-server.integration.test.ts`
 * when it was written. Because this whole file imports `openConsoleStore`
 * at the top, every test here (including the ones that only touch
 * `src/store/sqlite-driver.ts`) would have failed collection together had
 * `store.ts` still been missing when this suite first ran.
 *
 * Everything here needs a REAL file on disk or a second real OS process/
 * connection, which is exactly why these live in the integration pass and
 * not the unit pass (see `vitest.integration.config.ts`): `:memory:` cannot
 * demonstrate WAL journal mode, sidecar files, or single-writer contention
 * between two independent connections.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Bare named imports (not `fsp.mkdtemp(...)` member calls): the repo's
// `no-restricted-syntax` guard bans mutating `fs`/`fsp`/`fsPromises`
// *member-expression* calls in tests (the #25 smell: mkdtempSync/writeFileSync
// against /tmp in a *unit* test making it green only when the live tree
// happens to match). A bare identifier call is unaffected, and this file is
// explicitly an integration test whose entire point is real filesystem I/O —
// see `packages/m3l-common/tests/checkpoint.test.ts:61-67` for the same
// pattern and rationale.
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";

import { M3LConsoleError } from "../../src/errors/console-error.js";
import { openSqliteDatabase } from "../../src/store/sqlite-driver.js";
import { openConsoleStore } from "../../src/store/store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "m3l-console-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Captures whatever `run` throws synchronously or rejects with, as `unknown`. */
async function captureFailure(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("openConsoleStore — a real file-backed database", () => {
  test("journal_mode reports 'wal' — only assertable against a real file, never :memory:", () => {
    const store = openConsoleStore({ location: join(dir, "wal.sqlite") });
    try {
      expect(store.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    } finally {
      store.close();
    }
  });

  test("a write leaves -wal and -shm sidecars next to the main file", async () => {
    // Qualifies ADR-0071's "trivial to back up" claim: copying only the main
    // file while a `-wal` sidecar exists is NOT a consistent backup — the
    // committed data can be split across both files. A real backup procedure
    // must either checkpoint first or copy all three files atomically.
    const location = join(dir, "sidecars.sqlite");
    const store = openConsoleStore({ location });
    try {
      store.script("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      store.run("INSERT INTO t (v) VALUES ($v)", { v: "hello" });

      await expect(stat(`${location}-wal`)).resolves.toMatchObject({});
      await expect(stat(`${location}-shm`)).resolves.toMatchObject({});
    } finally {
      store.close();
    }
  });

  test("re-opening an existing store leaves the schema version unchanged", () => {
    // PR A applies no migrations at all (contract: applyMigrations is PR B),
    // so this is a regression lock that today merely proves re-opening does
    // not corrupt or reset `PRAGMA user_version` — re-validate the assertion
    // still discriminates once PR B's migrations make the version non-zero.
    const location = join(dir, "reopen.sqlite");

    const first = openConsoleStore({ location });
    const firstVersion = first.get("PRAGMA user_version");
    first.close();

    const second = openConsoleStore({ location });
    try {
      const secondVersion = second.get("PRAGMA user_version");
      expect(secondVersion).toEqual(firstVersion);
    } finally {
      second.close();
    }
  });
});

describe("openConsoleStore — file permissions (wiring defect regression)", () => {
  // `store.ts` calls `mkdirSync(dirname(location), { recursive: true })`
  // with no `mode`, and `node:sqlite` creates the database file itself with
  // no mode either — so under a default `umask 022` the directory, the
  // `.sqlite` file, and its `-wal`/`-shm` sidecars all end up
  // world-readable. ADR-0069/0070 put operator audit data in this store, so
  // that permissiveness is a real leak, not a cosmetic nit. This machine's
  // ambient `umask` may happen to mask the defect (that is environment
  // luck, not a control) — `process.umask` is set explicitly for the
  // duration of this test so the assertion does not depend on the runner's
  // ambient umask.
  const originalUmask = process.umask();

  afterEach(() => {
    process.umask(originalUmask);
  });

  test.skipIf(process.platform === "win32")(
    "[wiring defect] the console directory is 0700 and the .sqlite/-wal/-shm files are each 0600 under umask 022",
    async () => {
      process.umask(0o022);

      const location = join(dir, "perm-check", "console.sqlite");
      const store = openConsoleStore({ location });
      try {
        // Write a row while the store is open — the sidecars only exist
        // while WAL is checkpointed-but-not-yet-closed (mirrors the
        // existing "a write leaves -wal and -shm sidecars" test above).
        store.script("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        store.run("INSERT INTO t (v) VALUES ($v)", { v: "hello" });

        const directoryMode =
          (await stat(join(dir, "perm-check"))).mode & 0o777;
        const databaseMode = (await stat(location)).mode & 0o777;
        const walMode = (await stat(`${location}-wal`)).mode & 0o777;
        const shmMode = (await stat(`${location}-shm`)).mode & 0o777;

        expect(directoryMode).toBe(0o700);
        expect(databaseMode).toBe(0o600);
        expect(walMode).toBe(0o600);
        expect(shmMode).toBe(0o600);
      } finally {
        store.close();
      }
    },
  );
});

describe("openConsoleStore — a non-SQLite file", () => {
  test("[non-SQLite file] surfaces as ERR_CONSOLE_STORE_UNSUPPORTED", async () => {
    // Empirically verified against the real, already-shipped
    // `assertSqliteSupport` (src/store/sqlite-driver.ts): opening a junk file
    // via `new DatabaseSync(location)` does NOT throw — the failure (errcode
    // 26, SQLITE_NOTADB) only surfaces on the FIRST `prepare()`/read call.
    // `assertPortShape`'s `database.prepare("SELECT 1 AS one")` is that first
    // call, and `assertSqliteSupport`'s catch unconditionally wraps ANY
    // failure it observes as ERR_CONSOLE_STORE_UNSUPPORTED. So a corrupt/
    // non-database file is indistinguishable, today, from a genuine
    // `node:sqlite` API-shape drift — it never reaches `classifyStoreFailure`
    // at all, and does NOT come out as ERR_CONSOLE_STORE_OPEN_FAILED despite
    // errcode 26 mapping to "unopenable" -> "_OPEN_FAILED" in the
    // classification table. That table only governs a *factory* throw and a
    // post-assertSqliteSupport pragma/query failure. Flagged as a finding for
    // whoever implements store.ts: this conflates a data problem with an
    // environment problem under one code.
    const location = join(dir, "junk.sqlite");
    await writeFile(location, "not a database, just junk bytes");

    const thrown = await captureFailure(() => openConsoleStore({ location }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
    );
  });
});

describe("openConsoleStore — a parent path that is a regular file", () => {
  test("a real ENOTDIR surfaces as ERR_CONSOLE_STORE_OPEN_FAILED", async () => {
    // Step 1 of the documented open sequence ("ensure the parent directory
    // exists") runs before the factory is ever called, so this failure is
    // NOT swallowed by assertSqliteSupport the way the non-SQLite-file case
    // above is. ENOTDIR carries no `code` node:sqlite recognizes
    // (`ERR_SQLITE_ERROR` / `ERR_INVALID_STATE` / `ERR_OUT_OF_RANGE`), so
    // classifyStoreFailure falls through to "unknown", which storeError maps
    // to `_OPEN_FAILED` at phase "open" — the same row unopenable/constraint/
    // sql/outOfRange all share.
    const regularFile = join(dir, "not-a-dir");
    await writeFile(regularFile, "i am a file, not a directory");
    const location = join(regularFile, "subdir", "db.sqlite");

    const thrown = await captureFailure(() => openConsoleStore({ location }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_OPEN_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("openSqliteDatabase — readOnly against a missing file", () => {
  test("fails immediately, proving the flag actually reaches the builtin", () => {
    // Measured: unknown constructor options are silently ignored, so "the
    // option was accepted" would assert nothing. This proves the opposite —
    // that `readOnly` really changes behavior — because a missing file with
    // `readOnly: true` cannot be created and must fail, while a plain
    // read-write open of the same missing path would silently create it.
    const location = join(dir, "missing.sqlite");

    let thrown: unknown;
    try {
      openSqliteDatabase(location, { readOnly: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 14 });
  });
});

describe("openSqliteDatabase — single-writer semantics on a real file", () => {
  test("a second writer, while the first holds BEGIN IMMEDIATE, gets errcode 5", () => {
    const location = join(dir, "single-writer.sqlite");
    const first = openSqliteDatabase(location);
    first.exec("BEGIN IMMEDIATE");

    const second = openSqliteDatabase(location, { timeout: 50 });
    let thrown: unknown;
    try {
      second.exec("BEGIN IMMEDIATE");
    } catch (error) {
      thrown = error;
    } finally {
      second.close();
      first.exec("ROLLBACK");
      first.close();
    }

    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
  });
});

describe("openSqliteDatabase — busy timeout", () => {
  test("a competing writer's failure is delayed by roughly the configured timeout", () => {
    // The only honest test of `timeout`: node:sqlite silently ignores unknown
    // constructor options, so this measures the OBSERVABLE consequence (a
    // delayed failure) rather than asserting the option was merely accepted.
    const location = join(dir, "busy-timeout.sqlite");
    const timeoutMs = 300;

    const first = openSqliteDatabase(location);
    first.exec("BEGIN IMMEDIATE");

    const second = openSqliteDatabase(location, { timeout: timeoutMs });
    const start = Date.now();
    let thrown: unknown;
    try {
      second.exec("BEGIN IMMEDIATE");
    } catch (error) {
      thrown = error;
    } finally {
      second.close();
      first.exec("ROLLBACK");
      first.close();
    }
    const elapsedMs = Date.now() - start;

    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
    // Lower bound with margin, not an exact duration — a busy handler that
    // gives up almost instantly (e.g. a dropped `timeout` option) would fail
    // this even though it "throws the right error", which is exactly the gap
    // this test closes.
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 0.6);
  });
});
