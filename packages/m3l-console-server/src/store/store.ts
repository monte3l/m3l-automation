/**
 * `store/store` — `openConsoleStore`, the ADR-0069 embedded-persistence
 * lifecycle: resolving the parent directory, opening the `node:sqlite`
 * handle, re-verifying it via `assertSqliteSupport`, and applying the
 * pragma sequence every console-store consumer depends on.
 *
 * In this PR (A4) the opened store exposes the query executor directly
 * plus open/close lifecycle; the migration runner and the first typed
 * repository land in PR B.
 *
 * Measured facts this module's shape rests on (see
 * `store/sqlite-driver.ts`'s headline TSDoc for the full table, re-asserted
 * by `tests/store-driver.test.ts` on the Node 24 floor):
 *
 * | Claim | Measured |
 * | --- | --- |
 * | Pragma order | `journal_mode = WAL` must be set **before** `synchronous` and `foreign_keys` — setting it after a migration has already written would be a different, worse operation. |
 * | `journal_mode = WAL` | Only observable on a **file** database; `:memory:` reports `memory` regardless (WAL is assertable only in the integration pass, against a real file). |
 * | Missing parent directory | `node:sqlite` does **not** create it (errcode 14, `CANTOPEN`) — this module creates it itself, before ever calling the factory. |
 * | `SQLITE_BUSY` (errcode 5) | Prevented via `timeout` (the builtin's own busy handler, `@since` v24.0.0, on-floor) — **never retried**. A `BUSY` that survives the busy handler means a second writer genuinely exists; retrying would turn a real configuration fault into intermittent latency instead of a diagnosable `ERR_CONSOLE_STORE_BUSY`. |
 *
 * @packageDocumentation
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import type {
  M3LSqliteDatabaseFactory,
  M3LSqliteDatabaseHandle,
} from "./sqlite-driver.js";
import { assertSqliteSupport, openSqliteDatabase } from "./sqlite-driver.js";
import { createStoreExecutor } from "./executor.js";
import type { M3LStoreQueryExecutor } from "./types.js";

/**
 * Options accepted by {@link openConsoleStore}.
 *
 * @example
 * ```ts
 * const options: OpenConsoleStoreOptions = {
 *   location: ":memory:",
 *   busyTimeoutMs: 5_000,
 * };
 * ```
 */
export interface OpenConsoleStoreOptions {
  /**
   * An absolute file path, or the literal `":memory:"`. Programmatic-only:
   * `config/paths.ts` rejects `":memory:"` for the configured database
   * path — this option exists so tests (and, deliberately, nothing else)
   * can request an in-memory store.
   */
  readonly location: string;
  /**
   * The busy timeout, in milliseconds, forwarded to the database factory as
   * `timeout` — `node:sqlite`'s own busy handler (`@since` v24.0.0,
   * on-floor). A `BUSY` that survives this timeout is never retried; see
   * this module's headline TSDoc.
   */
  readonly busyTimeoutMs?: number;
  /**
   * Test seam: builds the {@link M3LSqliteDatabaseHandle} instead of the
   * real {@link openSqliteDatabase}. Never used outside tests.
   */
  readonly createDatabase?: M3LSqliteDatabaseFactory;
}

/**
 * An opened console store: the query executor, plus open/close lifecycle.
 * Deliberately not named `M3LConsoleStore` — that name (alongside
 * `M3LConsoleStoreUnit`) is reserved for PR B, once a repository sits
 * alongside the executor.
 *
 * @example
 * ```ts
 * function countWidgets(store: M3LConsoleStoreHandle): number {
 *   const row = store.get("SELECT COUNT(*) AS count FROM widgets");
 *   return typeof row?.["count"] === "number" ? row["count"] : 0;
 * }
 * ```
 */
export interface M3LConsoleStoreHandle extends M3LStoreQueryExecutor {
  /** `true` until `close()` has been called. */
  readonly isOpen: boolean;
  /** The `location` this store was opened with. */
  readonly location: string;
  /**
   * The schema version read once from `PRAGMA user_version` at open time,
   * never re-read per access — this PR (A4/A5) has no migrations, so it is
   * always `0`; the migration PR changes the value, not this field's shape.
   */
  readonly schemaVersion: number;
  /** Closes the underlying database handle. Idempotent — a second call is a no-op. */
  close(): void;
}

/**
 * Runs `step`, closing `database` before re-throwing on any failure — a
 * failure part-way through opening must never leak a live handle (or the
 * WAL file it would leave behind). An already-typed `M3LConsoleError` (from
 * {@link assertSqliteSupport}) is re-thrown unchanged; anything else is
 * classified with `phase: "open"`.
 */
function prepareOrCloseAndThrow<T>(
  database: M3LSqliteDatabaseHandle,
  location: string,
  step: () => T,
): T {
  try {
    return step();
  } catch (cause) {
    try {
      database.close();
    } catch {
      /* best-effort — the failure below is what the caller needs to see */
    }
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(
      classifyStoreFailure(cause),
      "open",
      "failed to prepare the console store after opening it",
      cause,
      { location },
    );
  }
}

/**
 * Opens the ADR-0069 console store: ensures the parent directory exists
 * (skipped for `":memory:"`), opens the database, re-verifies it via
 * {@link assertSqliteSupport}, and applies the pragma sequence
 * (`journal_mode = WAL`, then `synchronous = NORMAL`, then
 * `foreign_keys = ON`, strictly in that order).
 *
 * A blank `location` is rejected before the factory is ever called. Any
 * failure once the database is open results in `close()` being called
 * before the error is re-thrown, so a failed boot never leaks a handle.
 *
 * @param options - See {@link OpenConsoleStoreOptions}.
 * @returns The opened {@link M3LConsoleStoreHandle}.
 * @throws {@link M3LConsoleError} — `ERR_CONSOLE_STORE_OPEN_FAILED` for a
 * blank location or an unclassified open failure, `ERR_CONSOLE_STORE_BUSY`
 * for a factory `SQLITE_BUSY`, or `ERR_CONSOLE_STORE_UNSUPPORTED` from
 * {@link assertSqliteSupport}.
 *
 * @example
 * ```ts
 * const store = openConsoleStore({ location: ":memory:" });
 * store.script("CREATE TABLE widgets (id INTEGER PRIMARY KEY)");
 * store.close();
 * ```
 */
/**
 * Rejects a blank `location` before anything else runs — in particular,
 * before the factory is ever called.
 */
function assertValidLocation(location: string): void {
  if (location === "") {
    throw storeError(
      "unopenable",
      "open",
      "console store location must not be blank",
      undefined,
      { location },
    );
  }
}

/**
 * Ensures `location`'s parent directory exists, skipped entirely for
 * `":memory:"` — `node:sqlite` measurably does not create a missing parent
 * directory itself (errcode 14, `CANTOPEN`).
 */
function ensureParentDirectory(location: string): void {
  if (location === ":memory:") return;
  try {
    mkdirSync(dirname(location), { recursive: true });
  } catch (cause) {
    throw storeError(
      classifyStoreFailure(cause),
      "open",
      "failed to ensure the console store's parent directory exists",
      cause,
      { location },
    );
  }
}

/**
 * Opens the database handle via `factory`, classifying any factory throw
 * with `phase: "open"` (e.g. a `SQLITE_BUSY` factory failure becomes
 * `ERR_CONSOLE_STORE_BUSY`).
 */
function openDatabaseHandle(
  factory: M3LSqliteDatabaseFactory,
  location: string,
  busyTimeoutMs: number | undefined,
): M3LSqliteDatabaseHandle {
  try {
    return factory(
      location,
      busyTimeoutMs === undefined ? {} : { timeout: busyTimeoutMs },
    );
  } catch (cause) {
    throw storeError(
      classifyStoreFailure(cause),
      "open",
      "failed to open the console store database",
      cause,
      { location },
    );
  }
}

/**
 * Reads `PRAGMA user_version` once, at open — never re-read per access, so
 * the handle's `schemaVersion` stays stable for its whole lifetime (see
 * {@link M3LConsoleStoreHandle.schemaVersion}'s TSDoc).
 */
function readSchemaVersion(database: M3LSqliteDatabaseHandle): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = (row as Record<string, unknown> | undefined)?.["user_version"];
  return typeof value === "number" ? value : 0;
}

/**
 * Builds the {@link M3LConsoleStoreHandle} returned to callers, wiring its
 * `isOpen`/`close()` lifecycle to `database` on top of the executor.
 */
function buildConsoleStoreHandle(
  database: M3LSqliteDatabaseHandle,
  location: string,
  schemaVersion: number,
): M3LConsoleStoreHandle {
  const executor = createStoreExecutor(database);
  let closed = false;

  return {
    ...executor,
    get isOpen(): boolean {
      return database.isOpen;
    },
    location,
    schemaVersion,
    close(): void {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

export function openConsoleStore(
  options: OpenConsoleStoreOptions,
): M3LConsoleStoreHandle {
  assertValidLocation(options.location);
  ensureParentDirectory(options.location);

  const factory = options.createDatabase ?? openSqliteDatabase;
  const database = openDatabaseHandle(
    factory,
    options.location,
    options.busyTimeoutMs,
  );

  const schemaVersion = prepareOrCloseAndThrow(
    database,
    options.location,
    () => {
      assertSqliteSupport(database);
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
      database.exec("PRAGMA foreign_keys = ON");
      return readSchemaVersion(database);
    },
  );

  return buildConsoleStoreHandle(database, options.location, schemaVersion);
}
