/**
 * `store/executor` — the {@link M3LStoreQueryExecutor} implementation over
 * the {@link M3LSqliteDatabaseHandle} port, plus transaction support
 * (`withTransaction`, and `nested()` savepoints via the
 * {@link M3LStoreTransaction} it hands the callback).
 *
 * Two measured `node:sqlite` facts drive this file's shape (see
 * `store/sqlite-driver.ts`'s headline TSDoc for the full table):
 *
 * - Rows come back **null-prototype** (`Object.getPrototypeOf(row) === null`).
 *   Every row this module yields is normalized to an ordinary object before
 *   it ever reaches a caller.
 * - `setReadBigInts` is a **per-statement**, not per-database, flag. Because
 *   prepared statements are cached here by SQL text, the flag is set on
 *   every single call — including explicitly clearing it — so a later plain
 *   read of the same cached SQL never inherits a bigint read from an earlier
 *   call.
 *
 * @packageDocumentation
 */
import { chainSecondaryFailure } from "../errors/chain-secondary-failure.js";
import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import type {
  M3LSqliteDatabaseHandle,
  M3LSqliteStatementHandle,
} from "./sqlite-driver.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
  M3LStoreTransaction,
  M3LStoreWriteResult,
} from "./types.js";

/**
 * Converts a raw, possibly null-prototype row from the driver into an
 * ordinary object — `node:sqlite` measurably returns
 * `[Object: null prototype]` rows, which fails `toStrictEqual` and any
 * `instanceof Object` check a caller might reasonably make. No cast is
 * needed: {@link M3LSqliteStatementHandle}'s `get`/`all` are already typed to
 * {@link M3LStoreRow}, so the spread alone both strips the null prototype and
 * satisfies the return type.
 */
function normalizeRow(row: M3LStoreRow): M3LStoreRow {
  return { ...row };
}

/**
 * Splits {@link M3LStoreParameters} into the argument list a
 * {@link M3LSqliteStatementHandle} method accepts: a positional array is
 * spread as anonymous parameters, while a named-parameter record is passed
 * through as the statement's single first argument.
 */
function toStatementArguments(
  parameters: M3LStoreParameters | undefined,
): readonly unknown[] {
  if (parameters === undefined) return [];
  return Array.isArray(parameters) ? parameters : [parameters];
}

/**
 * Looks up (or prepares and caches) the statement for `sql`. Cached by SQL
 * text so a repeated query reuses its prepared statement rather than
 * re-preparing on every call.
 */
function getCachedStatement(
  database: M3LSqliteDatabaseHandle,
  cache: Map<string, M3LSqliteStatementHandle>,
  sql: string,
): M3LSqliteStatementHandle {
  const cached = cache.get(sql);
  if (cached !== undefined) return cached;
  const statement = database.prepare(sql);
  cache.set(sql, statement);
  return statement;
}

/**
 * Runs `operation`, classifying any thrown value into an
 * {@link M3LConsoleError} with `phase: "query"`. An already-typed
 * `M3LConsoleError` (e.g. raised deeper in the call stack) is re-thrown
 * unchanged rather than double-wrapped.
 */
function executeOrThrow<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(
      classifyStoreFailure(cause),
      "query",
      "console store query failed",
      cause,
    );
  }
}

/**
 * Builds the {@link M3LStoreQueryExecutor} methods (`all`/`get`/`run`/
 * `script`) over `database`, sharing `cache` with any caller so a
 * transaction and its enclosing executor reuse the same prepared
 * statements.
 */
function createQueryExecutor(
  database: M3LSqliteDatabaseHandle,
  cache: Map<string, M3LSqliteStatementHandle>,
): M3LStoreQueryExecutor {
  return {
    all(
      sql: string,
      parameters?: M3LStoreParameters,
      options?: M3LStoreReadOptions,
    ): readonly M3LStoreRow[] {
      return executeOrThrow(() => {
        const statement = getCachedStatement(database, cache, sql);
        statement.setReadBigInts(options?.readBigInts === true);
        const rows = statement.all(...toStatementArguments(parameters));
        return rows.map((row) => normalizeRow(row));
      });
    },
    get(
      sql: string,
      parameters?: M3LStoreParameters,
      options?: M3LStoreReadOptions,
    ): M3LStoreRow | undefined {
      return executeOrThrow(() => {
        const statement = getCachedStatement(database, cache, sql);
        statement.setReadBigInts(options?.readBigInts === true);
        const row = statement.get(...toStatementArguments(parameters));
        return row === undefined ? undefined : normalizeRow(row);
      });
    },
    run(sql: string, parameters?: M3LStoreParameters): M3LStoreWriteResult {
      return executeOrThrow(() => {
        const statement = getCachedStatement(database, cache, sql);
        const result = statement.run(...toStatementArguments(parameters));
        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        };
      });
    },
    script(sql: string): void {
      executeOrThrow(() => {
        database.exec(sql);
      });
    },
  };
}

/** A monotonically increasing counter used to name nested `SAVEPOINT`s uniquely. */
let savepointSequence = 0;

/**
 * Runs `work` inside a `SAVEPOINT`, releasing it on success or rolling back
 * to it (and re-throwing the original error, chaining any rollback failure
 * onto its cause chain via {@link chainSecondaryFailure}) on failure. The
 * `SAVEPOINT`/`RELEASE` statements this issues on the success path are
 * classified through {@link executeOrThrow}, like `withTransaction`'s own
 * `BEGIN IMMEDIATE`/`COMMIT`; the `ROLLBACK TO`/`RELEASE` pair issued on
 * failure is not (see `withTransaction`'s TSDoc for why).
 */
function runNested<T>(
  database: M3LSqliteDatabaseHandle,
  cache: Map<string, M3LSqliteStatementHandle>,
  work: (transaction: M3LStoreTransaction) => T,
): T {
  savepointSequence += 1;
  const savepoint = `m3l_console_store_savepoint_${String(savepointSequence)}`;
  executeOrThrow(() => {
    database.exec(`SAVEPOINT ${savepoint}`);
  });
  try {
    const result = work(createTransactionExecutor(database, cache));
    executeOrThrow(() => {
      database.exec(`RELEASE ${savepoint}`);
    });
    return result;
  } catch (cause) {
    try {
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
    } catch (rollbackCause) {
      chainSecondaryFailure(cause, rollbackCause);
    }
    throw cause;
  }
}

/**
 * Builds the {@link M3LStoreTransaction} handed to `withTransaction`'s (and
 * `nested`'s) callback: the same query methods as
 * {@link createQueryExecutor}, plus `nested()`.
 */
function createTransactionExecutor(
  database: M3LSqliteDatabaseHandle,
  cache: Map<string, M3LSqliteStatementHandle>,
): M3LStoreTransaction {
  const executor = createQueryExecutor(database, cache);
  return {
    ...executor,
    nested<T>(work: (transaction: M3LStoreTransaction) => T): T {
      return runNested(database, cache, work);
    },
  };
}

/**
 * Builds an {@link M3LStoreQueryExecutor} over `database`, with its own
 * statement cache.
 *
 * @param database - An already-open {@link M3LSqliteDatabaseHandle}.
 * @returns An executor whose `all`/`get`/`run`/`script` methods classify
 * every failure into an `M3LConsoleError` with `phase: "query"`.
 *
 * @example
 * ```ts
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * const executor = createStoreExecutor(database);
 * executor.script("CREATE TABLE widgets (id INTEGER PRIMARY KEY)");
 * ```
 */
export function createStoreExecutor(
  database: M3LSqliteDatabaseHandle,
): M3LStoreQueryExecutor {
  return createQueryExecutor(database, new Map());
}

/**
 * Runs `work` inside a `BEGIN IMMEDIATE` transaction: committed on success,
 * rolled back on failure.
 *
 * `BEGIN IMMEDIATE`, not `BEGIN`, is used deliberately — it acquires the
 * write lock up front, so a competing writer fails immediately at `BEGIN`
 * rather than deadlocking partway through `work`. That failure (and every
 * other transaction-control statement this function issues directly —
 * `BEGIN IMMEDIATE` and `COMMIT` here, `SAVEPOINT`/`RELEASE` in `nested()`)
 * is routed through the same {@link executeOrThrow} classification the query
 * methods use, with `phase: "query"` — so a competing writer's own
 * `BEGIN IMMEDIATE` failure surfaces as `ERR_CONSOLE_STORE_BUSY`, never a
 * raw `node:sqlite` error. The `ROLLBACK` issued on failure is deliberately
 * NOT routed through it (see the `catch` block below).
 *
 * A throwing `work` is rolled back and the **original error is re-thrown
 * with its identity intact** (never wrapped). If the `ROLLBACK` itself
 * fails, that failure is chained onto the original error's cause chain
 * (see {@link chainSecondaryFailure}) rather than replacing its `cause` —
 * the original failure is what the caller needs to see, all the way down.
 *
 * @param database - An already-open {@link M3LSqliteDatabaseHandle}.
 * @param work - Runs with a {@link M3LStoreTransaction} scoped to this
 * transaction; its return value becomes `withTransaction`'s own return
 * value on commit.
 * @returns Whatever `work` returned, after a successful `COMMIT`.
 *
 * @example
 * ```ts
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * withTransaction(database, (tx) => {
 *   tx.run("INSERT INTO widgets (id) VALUES (?)", [1]);
 * });
 * ```
 */
export function withTransaction<T>(
  database: M3LSqliteDatabaseHandle,
  work: (transaction: M3LStoreTransaction) => T,
): T {
  const cache = new Map<string, M3LSqliteStatementHandle>();
  // Deliberately OUTSIDE the try below: a `BEGIN IMMEDIATE` failure (e.g. a
  // competing writer, ERR_CONSOLE_STORE_BUSY) means no transaction was ever
  // opened, so there is nothing for the catch's `ROLLBACK` to undo.
  executeOrThrow(() => {
    database.exec("BEGIN IMMEDIATE");
  });
  try {
    const result = work(createTransactionExecutor(database, cache));
    executeOrThrow(() => {
      database.exec("COMMIT");
    });
    return result;
  } catch (cause) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackCause) {
      chainSecondaryFailure(cause, rollbackCause);
    }
    throw cause;
  }
}
