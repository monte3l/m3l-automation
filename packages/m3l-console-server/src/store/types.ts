/**
 * `store/types` — the seam types every store consumer and every store
 * implementation is written against.
 *
 * No runtime code lives in this file (no functions, no classes, no
 * initialized consts) — it is types only, so it carries no coverage entry
 * of its own. `M3LStoreQueryExecutor` is the port repositories consume;
 * `store/sqlite-driver.ts` and `store/executor.ts` are what implement it
 * against the real `node:sqlite` builtin.
 *
 * @packageDocumentation
 */

/**
 * A value a bound parameter may carry.
 *
 * @example
 * ```ts
 * const value: M3LStoreInputValue = 42;
 * ```
 */
type M3LStoreInputValue = string | number | bigint | null | Uint8Array;

/**
 * A value a column may yield.
 *
 * @example
 * ```ts
 * const value: M3LStoreOutputValue = "hello";
 * ```
 */
type M3LStoreOutputValue = string | number | bigint | null | Uint8Array;

/**
 * Bound parameters for a statement: named (`$k` / `:k` / `@k`) or
 * positional.
 *
 * @example
 * ```ts
 * const named: M3LStoreParameters = { id: 1 };
 * const positional: M3LStoreParameters = [1, "label"];
 * ```
 */
export type M3LStoreParameters =
  Readonly<Record<string, M3LStoreInputValue>> | readonly M3LStoreInputValue[];

/**
 * One result row, normalized to an ordinary object — never the
 * null-prototype object `node:sqlite` itself yields.
 *
 * The spread normalization (`store/executor.ts`'s `normalizeRow`) is safe
 * against prototype pollution: a plain object spread performs
 * `CreateDataProperty`, never a prototype-chain write. A column literally
 * named `__proto__`, however, still becomes an **own** key of the normalized
 * row (not the prototype) — a future reader iterating this type with
 * `target[k] = row[k]` over `Object.keys(row)` must still treat `__proto__`
 * as a dangerous key to guard against, even though the spread itself is fine.
 *
 * @example
 * ```ts
 * function readId(row: M3LStoreRow): M3LStoreRow["id"] {
 *   return row["id"];
 * }
 * ```
 */
export type M3LStoreRow = Readonly<Record<string, M3LStoreOutputValue>>;

/**
 * Per-call read options for {@link M3LStoreQueryExecutor.all} and
 * {@link M3LStoreQueryExecutor.get}.
 *
 * @example
 * ```ts
 * const options: M3LStoreReadOptions = { readBigInts: true };
 * ```
 */
export interface M3LStoreReadOptions {
  /**
   * Read INTEGER columns as `bigint`. Required for any column that can
   * exceed `Number.MAX_SAFE_INTEGER` — measured, `node:sqlite` throws
   * `ERR_OUT_OF_RANGE` on such a read rather than truncating.
   */
  readonly readBigInts?: boolean;
}

/**
 * The outcome of a write (`INSERT` / `UPDATE` / `DELETE`).
 *
 * @example
 * ```ts
 * function wasInserted(result: M3LStoreWriteResult): boolean {
 *   return result.changes > 0;
 * }
 * ```
 */
export interface M3LStoreWriteResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * The port every repository is written against. Never leaves `store/` —
 * repositories receive it (or a {@link M3LStoreTransaction}) by injection,
 * never a concrete driver type.
 *
 * Deliberately has no `iterate` method: measured, calling `close()` on the
 * underlying `node:sqlite` handle while a live iterator is still open
 * succeeds silently, handing the caller a cursor over a closed database.
 * Streaming reads arrive with the row that needs one, behind a repository
 * method that owns the cursor's lifetime for its own duration.
 *
 * SQLite cannot bind a table/column identifier as a parameter (only values
 * bind) — so any identifier that must vary in a query can never come from a
 * caller-supplied value; it must be validated against a code-side allowlist
 * before it is interpolated.
 *
 * @example
 * ```ts
 * function countWidgets(executor: M3LStoreQueryExecutor): number {
 *   const row = executor.get("SELECT COUNT(*) AS count FROM widgets");
 *   return typeof row?.["count"] === "number" ? row["count"] : 0;
 * }
 * ```
 */
export interface M3LStoreQueryExecutor {
  all(
    sql: string,
    parameters?: M3LStoreParameters,
    options?: M3LStoreReadOptions,
  ): readonly M3LStoreRow[];
  get(
    sql: string,
    parameters?: M3LStoreParameters,
    options?: M3LStoreReadOptions,
  ): M3LStoreRow | undefined;
  run(sql: string, parameters?: M3LStoreParameters): M3LStoreWriteResult;
  /** DDL / multi-statement script. Unparameterized by construction. */
  script(sql: string): void;
}

/**
 * An {@link M3LStoreQueryExecutor} scoped to a single transaction, adding
 * `nested()` for savepoint-backed sub-transactions.
 *
 * @example
 * ```ts
 * function withNested(transaction: M3LStoreTransaction): number {
 *   return transaction.nested((inner) => inner.run("DELETE FROM t").changes);
 * }
 * ```
 */
export interface M3LStoreTransaction extends M3LStoreQueryExecutor {
  /**
   * Runs `work` in a `SAVEPOINT`; only its writes are discarded (via
   * `ROLLBACK TO`) if it throws — the enclosing transaction's own writes
   * are unaffected.
   */
  nested<T>(work: (transaction: M3LStoreTransaction) => T): T;
}
