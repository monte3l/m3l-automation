/**
 * `store/sqlite-driver` — the ONLY module in this package that imports
 * `node:sqlite`.
 *
 * Everything above `store/` talks to the structural
 * {@link M3LSqliteDatabaseHandle} / {@link M3LSqliteStatementHandle} ports
 * below, never to `node:sqlite`'s own `DatabaseSync` / `StatementSync`
 * classes directly — `export type X = DatabaseSync` is exactly what makes a
 * seam unreplaceable, so only the members this package actually consumes are
 * named here. That discipline is what makes ADR-0069's recorded fallbacks
 * (a packaged `sqlite` dependency, or a degraded JSONL-only mode) cheap to
 * adopt later: swapping either in replaces **this file plus a factory
 * injection** (`OpenConsoleStoreOptions.createDatabase` in `store/store.ts`)
 * **and nothing else** — every repository, the executor, and the failure
 * classifier are all written against the port, not the builtin.
 *
 * `assertSqliteSupport` is the ADR-0069 **stability checkpoint**, run once
 * at every store open: it re-verifies the specific shape and behaviour this
 * package depends on, so a future Node patch that removes a member or
 * changes a documented behaviour surfaces as a named
 * `ERR_CONSOLE_STORE_UNSUPPORTED` at boot — the recorded trigger condition
 * for adopting a fallback — instead of silent corruption in production.
 *
 * Observed on Node v26.7.0, SQLite 3.53.4 (`tests/store-driver.test.ts`
 * re-asserts these on the Node 24 floor on every CI push — these are
 * observations pinned so a future reader does not "simplify" them away, not
 * universal guarantees):
 *
 * | Claim | Measured |
 * | --- | --- |
 * | `PRAGMA user_version` is transactional | **Yes.** Set inside `BEGIN IMMEDIATE`, `ROLLBACK` reverts it. This is why it, not a table, is the authoritative schema-version store. |
 * | `PRAGMA user_version = ?` | **Syntax error** (`ERR_SQLITE_ERROR`, `near "?": syntax error`). The version must be interpolated as a validated integer, never bound. |
 * | `errcode` values | **Extended** result codes. NOT NULL → 1299, UNIQUE → 2067, CANTOPEN → 14, BUSY → 5. Both 1299 and 2067 are `& 0xff === 19` (constraint) — classify on `errcode & 0xff`, never the raw literal. |
 * | Error `code` values | **Three**: `ERR_SQLITE_ERROR` (SQL), `ERR_INVALID_STATE` (use-after-close / double-close), `ERR_OUT_OF_RANGE` (bigint overflow). |
 * | Reading INTEGER \> `MAX_SAFE_INTEGER` | **Throws** `ERR_OUT_OF_RANGE` (a `RangeError`); does not truncate. Needs per-statement `setReadBigInts(true)`, after which the value reads as a `bigint`. |
 * | `enableForeignKeyConstraints` | Defaults **on** — `PRAGMA foreign_keys` reads `1` with no option passed; `{ enableForeignKeyConstraints: false }` reads `0`. A test asserting `true → 1` guards nothing; `false → 0` is the only discriminating arm. |
 * | Unknown constructor options | **Silently ignored** (no throw). "The option was accepted" asserts nothing, on any version. |
 * | Rows | **Null-prototype** objects (`Object.getPrototypeOf(row) === null`). `toEqual` works, `toStrictEqual` does not — the executor must normalize rows to ordinary objects. |
 * | `expandedSQL` | **Interpolates bound values** — never loggable. |
 * | `journal_mode = WAL` | Works on a file DB; `:memory:` reports `memory`, so WAL is only assertable in the integration pass. |
 * | Missing parent directory | errcode 14 — `node:sqlite` does **not** create it. |
 * | `close()` with a live `iterate()` | Succeeds silently, leaving a cursor over a closed database. This is why the port below exposes no `iterate`: a caller handed such a cursor would read from — or corrupt — memory that should already be gone. |
 * | Second writer on one file | errcode 5 — single-writer semantics are real (ADR-0069 accepts them until X16). |
 *
 * **Above-floor APIs are BANNED here.** Per `@types/node`'s own `@since`
 * tags, db-level `readBigInts`/`returnArrays` are v24.4.0 and
 * `createTagStore` is v26.1.0, while this package's `engines.node` floor is
 * `>=24` (admitting 24.0.x–24.3.x). Because `node:sqlite` silently ignores
 * unknown constructor options rather than throwing, using any of these
 * would be an **undetectable no-op** on 24.0–24.3 rather than a build or
 * runtime failure. The per-statement `setReadBigInts(true)` (`@since`
 * v22.5.0, on-floor) is used instead of the db-level option.
 *
 * @packageDocumentation
 */
import { DatabaseSync } from "node:sqlite";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * The structural port over a prepared statement. Named for only the four
 * members this package consumes — `node:sqlite`'s own `StatementSync` has
 * many more, deliberately not named here.
 *
 * @example
 * ```ts
 * function countChanges(statement: M3LSqliteStatementHandle): number {
 *   return Number(statement.run().changes);
 * }
 * ```
 */
export interface M3LSqliteStatementHandle {
  run(...parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): readonly unknown[];
  /**
   * Reads INTEGER columns as `bigint` for subsequent calls on this
   * statement. Must be set **per call** by the executor when
   * {@link M3LStoreReadOptions.readBigInts} is requested — statements are
   * cached, so setting it once at prepare time would leak the flag onto a
   * later non-bigint read of the same statement text.
   */
  setReadBigInts(enabled: boolean): void;
}

/**
 * The structural port over a database connection. Named for only the
 * members this package consumes — never a direct alias of `DatabaseSync`,
 * which would make the seam unreplaceable.
 *
 * Deliberately has no `iterate` method, for the same reason
 * {@link M3LStoreQueryExecutor} does not: measured, `close()` with a live
 * iterator succeeds silently instead of throwing.
 *
 * @example
 * ```ts
 * function isOpenAndIdle(database: M3LSqliteDatabaseHandle): boolean {
 *   return database.isOpen && !database.isTransaction;
 * }
 * ```
 */
export interface M3LSqliteDatabaseHandle {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): M3LSqliteStatementHandle;
  close(): void;
}

/**
 * Options accepted when opening a database through
 * {@link M3LSqliteDatabaseFactory}. A narrow, named subset of
 * `node:sqlite`'s own `DatabaseSyncOptions` — only what `store/store.ts`
 * actually needs to pass through.
 *
 * @example
 * ```ts
 * const options: M3LSqliteOpenOptions = {
 *   timeout: 5_000,
 *   enableForeignKeyConstraints: false,
 * };
 * ```
 */
interface M3LSqliteOpenOptions {
  readonly readOnly?: boolean;
  /** The busy timeout in milliseconds — `node:sqlite`'s own busy handler (`@since` v24.0.0, on-floor). */
  readonly timeout?: number;
  readonly enableForeignKeyConstraints?: boolean;
}

/**
 * Builds an {@link M3LSqliteDatabaseHandle} for `location`. The seam
 * `store/store.ts`'s `OpenConsoleStoreOptions.createDatabase` overrides for
 * tests, and the one factory a future fallback persistence strategy would
 * replace.
 *
 * @example
 * ```ts
 * function openInMemory(factory: M3LSqliteDatabaseFactory): M3LSqliteDatabaseHandle {
 *   return factory(":memory:");
 * }
 * ```
 */
export type M3LSqliteDatabaseFactory = (
  location: string,
  options?: M3LSqliteOpenOptions,
) => M3LSqliteDatabaseHandle;

/**
 * The default {@link M3LSqliteDatabaseFactory}, backed by the real
 * `node:sqlite` builtin. Annotated with the port type rather than inferred:
 * that annotation is the compile-time proof `DatabaseSync` actually
 * conforms to {@link M3LSqliteDatabaseHandle}, and `isolatedDeclarations`
 * requires it on every exported const regardless.
 *
 * @example
 * ```ts
 * const database = openSqliteDatabase(":memory:");
 * database.close();
 * ```
 */
export const openSqliteDatabase: M3LSqliteDatabaseFactory = (
  location,
  options,
) =>
  options === undefined
    ? new DatabaseSync(location)
    : new DatabaseSync(location, options);

/** Splits a `sqlite_version()` string (e.g. `"3.53.4"`) into comparable numeric parts. */
function parseSqliteVersion(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/** `true` when `left` is numerically \>= `right`, comparing major/minor/patch in order. */
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

/** Reads `PRAGMA user_version` as an integer, throwing if the shape is not what `node:sqlite` is known to return. */
function readUserVersion(database: M3LSqliteDatabaseHandle): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = (row as Record<string, unknown> | undefined)?.["user_version"];
  if (typeof value !== "number") {
    throw new Error("PRAGMA user_version did not return a number");
  }
  return value;
}

/**
 * Asserts every member {@link M3LStoreQueryExecutor} and
 * {@link M3LStoreTransaction} consume is actually present and callable, on
 * both the database handle and a freshly prepared statement.
 */
function assertPortShape(database: M3LSqliteDatabaseHandle): void {
  if (
    typeof database.exec !== "function" ||
    typeof database.prepare !== "function" ||
    typeof database.close !== "function" ||
    typeof database.isOpen !== "boolean" ||
    typeof database.isTransaction !== "boolean"
  ) {
    throw new Error(
      "node:sqlite database handle is missing a member the store driver depends on",
    );
  }

  const statement = database.prepare("SELECT 1 AS one");
  if (
    typeof statement.run !== "function" ||
    typeof statement.get !== "function" ||
    typeof statement.all !== "function" ||
    typeof statement.setReadBigInts !== "function"
  ) {
    throw new Error(
      "node:sqlite statement handle is missing a member the store driver depends on",
    );
  }
}

/**
 * Asserts the transactional `PRAGMA user_version` property this package's
 * migration story rests on: setting it inside `BEGIN IMMEDIATE` and rolling
 * back must restore the original value exactly.
 */
function assertUserVersionRoundTrip(database: M3LSqliteDatabaseHandle): void {
  const before = readUserVersion(database);
  const probe = before + 1;

  database.exec("BEGIN IMMEDIATE");
  database.exec(`PRAGMA user_version = ${String(probe)}`);
  const during = readUserVersion(database);
  database.exec("ROLLBACK");
  const after = readUserVersion(database);

  if (during !== probe || after !== before) {
    throw new Error("PRAGMA user_version did not round-trip transactionally");
  }
}

/** The minimum `sqlite_version()` major/minor this driver requires — what `STRICT` tables need. */
const MINIMUM_SQLITE_VERSION_MAJOR = 3;
const MINIMUM_SQLITE_VERSION_MINOR = 37;
const MINIMUM_SUPPORTED_SQLITE_VERSION: readonly number[] = [
  MINIMUM_SQLITE_VERSION_MAJOR,
  MINIMUM_SQLITE_VERSION_MINOR,
];

/** Asserts `sqlite_version()` is at least {@link MINIMUM_SUPPORTED_SQLITE_VERSION}. */
function assertSqliteVersionAtLeast337(
  database: M3LSqliteDatabaseHandle,
): void {
  const row = database.prepare("SELECT sqlite_version() AS version").get();
  const version = (row as Record<string, unknown> | undefined)?.["version"];
  if (
    typeof version !== "string" ||
    !versionAtLeast(
      parseSqliteVersion(version),
      MINIMUM_SUPPORTED_SQLITE_VERSION,
    )
  ) {
    throw new Error(
      `sqlite_version() reported an unsupported version: ${JSON.stringify(version)}`,
    );
  }
}

/**
 * The ADR-0069 stability checkpoint, run once at every store open (before
 * any pragma or migration is applied). Re-verifies, against the live
 * handle: every member {@link M3LSqliteDatabaseHandle} and
 * {@link M3LSqliteStatementHandle} name, the transactional
 * `PRAGMA user_version` round-trip, and `sqlite_version() \>= 3.37`.
 *
 * This converts "the builtin changed under us" from mystery corruption at
 * some later, unrelated point into a single named
 * `ERR_CONSOLE_STORE_UNSUPPORTED` at boot — precisely the trigger condition
 * ADR-0069 records for adopting one of its fallback persistence strategies.
 *
 * @param database - The handle to verify, already open.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_STORE_UNSUPPORTED`
 * if any check fails.
 *
 * @example
 * ```ts
 * const database = openSqliteDatabase(":memory:");
 * assertSqliteSupport(database);
 * ```
 */
export function assertSqliteSupport(database: M3LSqliteDatabaseHandle): void {
  try {
    assertPortShape(database);
    assertUserVersionRoundTrip(database);
    assertSqliteVersionAtLeast337(database);
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_UNSUPPORTED",
      "the node:sqlite builtin no longer provides the shape or behaviour the console store driver depends on — see ADR-0069's recorded fallback strategies",
      { cause },
    );
  }
}
