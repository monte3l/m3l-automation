/**
 * `store/meta-repository` — `createConsoleMetaRepository`, the
 * {@link M3LConsoleMetaRepository} built over `console_meta` (created by
 * `store/migrations/registry.ts`'s v2) and `console_schema_migrations`
 * (created by v1).
 *
 * A repository here is a plain FUNCTION over the injected
 * {@link M3LStoreQueryExecutor} port — never a class holding a `DatabaseSync`
 * — so it is exactly as testable against a `SAVEPOINT`-backed
 * `M3LStoreTransaction` as it is against the top-level store, and every
 * failure branch here is reachable from a plain unit test with no real file
 * lock or corrupt database required.
 *
 * `console_meta` is a CLOSED key/value set: today, exactly `"store.id"` and
 * `"store.created.at.ms"`. `store.id` is the deployment identity ADR-0069's
 * "one database per deployment" discipline implies — a later slice (X7,
 * audit export) needs it to prove that a JSONL stream and the SQLite index
 * built on top of it came from the SAME store, not two deployments whose
 * files happened to get copied next to each other. That is why this
 * repository exists in this foundation PR rather than being deferred to X7
 * itself: X7 only needs to *read* an identity that was minted long before it
 * ships.
 *
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";

import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import type { M3LStoreQueryExecutor, M3LStoreRow } from "./types.js";

/** The `console_meta` key backing {@link M3LConsoleStoreIdentity.id}. */
const KEY_STORE_ID = "store.id";
/** The `console_meta` key backing {@link M3LConsoleStoreIdentity.createdAtMs}. */
const KEY_STORE_CREATED_AT_MS = "store.created.at.ms";

/**
 * The console store's deployment identity: a random id and the
 * epoch-millisecond timestamp it was first minted at, both persisted so
 * every later boot of the SAME database reuses them rather than minting a
 * fresh identity per process.
 *
 * @example
 * ```ts
 * function isFreshStore(identity: M3LConsoleStoreIdentity): boolean {
 *   return Date.now() - identity.createdAtMs < 1_000;
 * }
 * ```
 */
export interface M3LConsoleStoreIdentity {
  /** A random, opaque identifier minted once per database and reused forever after. */
  readonly id: string;
  /** The epoch-millisecond timestamp {@link id} was first minted at. */
  readonly createdAtMs: number;
}

/**
 * One `console_schema_migrations` audit row, as `history()` reports it.
 *
 * @example
 * ```ts
 * function describeEntry(entry: M3LMigrationHistoryEntry): string {
 *   return `v${String(entry.version)} (${entry.name}) via ${entry.nodeVersion}`;
 * }
 * ```
 */
export interface M3LMigrationHistoryEntry {
  /** The migration's 1-based version. */
  readonly version: number;
  /** The migration's registry name at the time it was applied. */
  readonly name: string;
  /** The `process.version` of the Node build that applied this migration. */
  readonly nodeVersion: string;
}

/**
 * The console store's metadata repository: the deployment
 * {@link M3LConsoleStoreIdentity} plus the migration audit trail.
 *
 * @example
 * ```ts
 * function bootLine(repository: M3LConsoleMetaRepository): string {
 *   const identity = repository.describe();
 *   return `store ${identity.id}, ${String(repository.history().length)} migrations applied`;
 * }
 * ```
 */
export interface M3LConsoleMetaRepository {
  /**
   * Mints this store's {@link M3LConsoleStoreIdentity} on its very first
   * call across the database's whole lifetime, and reuses the PERSISTED
   * identity on every call after that — including from a fresh repository
   * instance built over the same database in a later process, since the
   * identity round-trips through `console_meta` rather than living in
   * per-instance memory.
   */
  describe(): M3LConsoleStoreIdentity;
  /** The migration audit trail from `console_schema_migrations`, oldest first. */
  history(): readonly M3LMigrationHistoryEntry[];
}

/**
 * Runs `operation`, classifying any thrown value into an
 * {@link M3LConsoleError} — in particular, a closed database's
 * `ERR_INVALID_STATE` becomes `ERR_CONSOLE_STORE_CLOSED`. An already-typed
 * `M3LConsoleError` (e.g. raised by a production `M3LStoreQueryExecutor`
 * that classifies its own failures) is re-thrown unchanged rather than
 * double-wrapped — this repository's own executor may or may not already
 * classify failures, so both cases must work.
 */
function runMetaOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(
      classifyStoreFailure(cause),
      "query",
      "console meta repository operation failed",
      cause,
    );
  }
}

/**
 * Inserts `key`/`value` into `console_meta` only if `key` is not already
 * present — `ON CONFLICT ... DO NOTHING`, never `INSERT OR REPLACE`, since a
 * replace would clobber an identity a previous boot already minted.
 */
function insertIfAbsent(
  executor: M3LStoreQueryExecutor,
  key: string,
  value: string,
): void {
  executor.run(
    "INSERT INTO console_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    [key, value],
  );
}

/** Reads one `console_meta` value by `key`, or `undefined` when absent. */
function readMetaValue(
  executor: M3LStoreQueryExecutor,
  key: string,
): string | undefined {
  const row: M3LStoreRow | undefined = executor.get(
    "SELECT value FROM console_meta WHERE key = ?",
    [key],
  );
  // `console_meta.value` is `TEXT NOT NULL` — a present row's value is
  // always a string; the only real uncertainty this reads through is
  // whether a row for `key` exists at all, which the return type's
  // `| undefined` already carries.
  return row?.["value"] as string | undefined;
}

/**
 * Mints (idempotently) and returns this store's {@link M3LConsoleStoreIdentity}.
 *
 * Deliberately read-after-write rather than trusting the `INSERT`'s own
 * result: `ON CONFLICT DO NOTHING`'s write outcome tells a caller whether
 * ITS OWN insert won the race, not what value is actually persisted — a
 * concurrent second caller that lost the race would otherwise report the
 * value it tried (and failed) to write, rather than the one a competing
 * caller actually persisted. Reading back after the (possibly no-op) insert
 * is the only form that is correct under a concurrent second minter.
 */
function describeStore(
  executor: M3LStoreQueryExecutor,
): M3LConsoleStoreIdentity {
  insertIfAbsent(executor, KEY_STORE_ID, randomUUID());
  insertIfAbsent(executor, KEY_STORE_CREATED_AT_MS, String(Date.now()));

  const id = readMetaValue(executor, KEY_STORE_ID);
  const createdAtMsText = readMetaValue(executor, KEY_STORE_CREATED_AT_MS);

  if (id === undefined || createdAtMsText === undefined) {
    // Unreachable under correct operation: the two inserts above guarantee
    // both rows exist by the time this reads them back. Guarded anyway —
    // silently returning a fabricated identity would be worse than a loud
    // failure if this invariant is ever violated.
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "console store identity is missing from console_meta immediately after minting it",
    );
  }

  return { id, createdAtMs: Number(createdAtMsText) };
}

/** Projects one raw `console_schema_migrations` row into a {@link M3LMigrationHistoryEntry}. */
function toHistoryEntry(row: M3LStoreRow): M3LMigrationHistoryEntry {
  return {
    version: Number(row["version"]),
    name: String(row["name"]),
    nodeVersion: String(row["node_version"]),
  };
}

/** Reads every `console_schema_migrations` row, oldest first. */
function readHistory(
  executor: M3LStoreQueryExecutor,
): readonly M3LMigrationHistoryEntry[] {
  const rows = executor.all(
    "SELECT version, name, node_version FROM console_schema_migrations ORDER BY version ASC",
  );
  return rows.map((row) => toHistoryEntry(row));
}

/**
 * Builds a {@link M3LConsoleMetaRepository} over `executor`.
 *
 * @param executor - The {@link M3LStoreQueryExecutor} port this repository
 * reads and writes through — the top-level store's own executor, or a
 * transaction's, closed over rather than held as a class field.
 * @returns The {@link M3LConsoleMetaRepository}.
 *
 * @example
 * ```ts
 * import { createStoreExecutor } from "@m3l-automation/m3l-console-server/store/executor";
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * const repository = createConsoleMetaRepository(createStoreExecutor(database));
 * const identity = repository.describe();
 * ```
 */
export function createConsoleMetaRepository(
  executor: M3LStoreQueryExecutor,
): M3LConsoleMetaRepository {
  return {
    describe(): M3LConsoleStoreIdentity {
      return runMetaOperation(() => describeStore(executor));
    },
    history(): readonly M3LMigrationHistoryEntry[] {
      return runMetaOperation(() => readHistory(executor));
    },
  };
}
