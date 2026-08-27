/**
 * `store/migrations/runner` - `applyMigrations`, the ADR-0069 schema
 * migration runner over {@link M3LMigration}. Validates the registry,
 * consults the authoritative `PRAGMA user_version`, detects drift against
 * the recorded audit trail, and applies every pending migration in its own
 * `BEGIN IMMEDIATE` transaction.
 *
 * `PRAGMA user_version` is authoritative - measured transactional (see
 * `store/sqlite-driver.ts`'s headline TSDoc), and readable even on a
 * schema-less database, so there is no chicken-and-egg version table to
 * bootstrap. `console_schema_migrations` (created by
 * `store/migrations/registry.ts`'s v1) is an **audit trail, not control
 * flow**: this module never reads it to decide what to apply, only to
 * detect that an already-applied migration has been edited in place.
 *
 * Forward-only, no `down`: ADR-0069's `node:sqlite` store only *indexes*
 * authoritative JSONL, so recovering from a bad migration is "delete the
 * `.sqlite` file and re-index from JSONL" - strictly safer than a reverse
 * migration that would have to be correct against whatever partial state a
 * failed forward migration left behind.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import { M3LConsoleError } from "../../errors/console-error.js";
import { classifyStoreFailure, storeError } from "../failures.js";
import type { M3LSqliteDatabaseHandle } from "../sqlite-driver.js";
import { readUserVersion } from "../sqlite-driver.js";

import type { M3LMigration } from "./registry.js";

/** The largest version this runner accepts - SQLite's `user_version` is a signed 32-bit integer. */
const MAX_MIGRATION_VERSION = 2_147_483_647;

/**
 * `true` when `version` is a positive integer within SQLite's signed
 * 32-bit `user_version` range. The single predicate both
 * {@link validateRegistry} and every later reader of this file must agree
 * on for "is this version safe to interpolate into `PRAGMA user_version`".
 */
function isValidMigrationVersion(version: number): boolean {
  return (
    Number.isInteger(version) && version > 0 && version <= MAX_MIGRATION_VERSION
  );
}

/**
 * Builds the `ERR_CONSOLE_STORE_MIGRATION_FAILED` error for a registry that
 * fails validation. Never wraps a caught value - a malformed registry is a
 * static defect in the migration list itself, not a runtime failure - and
 * never carries the offending `name`/`version` in `context`, since either
 * could itself be a hostile or non-string/non-numeric value and `context`
 * must stay safe to log unconditionally.
 */
function registryInvalid(reason: string): M3LConsoleError {
  return new M3LConsoleError(
    "ERR_CONSOLE_STORE_MIGRATION_FAILED",
    `console store migration registry is invalid: ${reason}`,
  );
}

/**
 * Validates `migrations` before anything else in {@link applyMigrations}
 * runs - in particular, before the database is ever read from. Enforces:
 * versions start at 1, are strictly increasing and gap-free (equivalently,
 * unique and matching array position), each a positive integer within
 * SQLite's signed 32-bit range; and names are non-empty and unique.
 *
 * This is also where {@link isValidMigrationVersion} is enforced for every
 * migration in the registry - the single guard that makes every later
 * `PRAGMA user_version = <version>` interpolation in this file safe, since
 * `applyMigrations` never reaches its per-migration loop without first
 * calling this function.
 */
function validateRegistry(migrations: readonly M3LMigration[]): void {
  const seenNames = new Set<string>();
  let expectedVersion = 1;

  for (const migration of migrations) {
    if (!isValidMigrationVersion(migration.version)) {
      throw registryInvalid(
        "every migration version must be a positive integer no greater than 2147483647",
      );
    }
    if (migration.version !== expectedVersion) {
      throw registryInvalid(
        "migration versions must start at 1 and increase by exactly 1 with no gaps or duplicates",
      );
    }
    if (typeof migration.name !== "string" || migration.name.length === 0) {
      throw registryInvalid("every migration name must be non-empty");
    }
    if (seenNames.has(migration.name)) {
      throw registryInvalid("migration names must be unique");
    }

    seenNames.add(migration.name);
    expectedVersion += 1;
  }
}

/**
 * Digests `statements` into the `sql_digest` recorded alongside a
 * migration's history row. Deliberately trivial and fully reproducible: a
 * SHA-256 over the statements joined with a single space, so two registries
 * with identical statement lists always produce the identical digest, and
 * any change to the statements - reordering, adding, editing one character -
 * changes it.
 */
function computeStatementsDigest(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join(" ")).digest("hex");
}

/**
 * Reads the console store's current `PRAGMA user_version`, classifying any
 * read failure as a `"migrate"`-phase store error rather than letting a raw
 * `node:sqlite` (or `sqlite-driver.ts` strictness) error escape unclassified.
 */
function readCurrentSchemaVersion(database: M3LSqliteDatabaseHandle): number {
  try {
    return readUserVersion(database);
  } catch (cause) {
    throw storeError(
      classifyStoreFailure(cause),
      "migrate",
      "failed to read the console store's current schema version",
      cause,
    );
  }
}

/**
 * Refuses a database whose `user_version` is strictly ahead of the
 * registry's highest known version - the rollback-deploy case, where an
 * older binary would otherwise silently mis-read columns it does not know
 * about. Equal is fine (nothing pending); only strictly greater is refused.
 */
function assertNotAheadOfRegistry(
  currentVersion: number,
  highestVersion: number,
): void {
  if (currentVersion <= highestVersion) return;
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    `console store schema is ahead of the registry: the database reports user_version ${String(currentVersion)}, but the highest migration this build knows is version ${String(highestVersion)}`,
    { context: { schemaVersion: currentVersion, version: highestVersion } },
  );
}

/**
 * Detects an edited-in-place migration: for every migration already applied
 * (`migration.version <= currentVersion`), its recorded
 * `console_schema_migrations` row must still agree on `name` and
 * `sql_digest`. A disagreement means the migration's declared SQL (or name)
 * changed after it already ran in production - the one case this runner's
 * persisted history table exists to catch.
 */
function assertNoHistoryDrift(
  database: M3LSqliteDatabaseHandle,
  migrations: readonly M3LMigration[],
  currentVersion: number,
): void {
  // Nothing has ever been applied yet, so console_schema_migrations may not
  // even exist — a validated registry always starts at version 1, so
  // currentVersion > 0 already implies that migration (the one that creates
  // this very table) has run. Returning here, rather than merely letting the
  // loop below iterate zero times, is what keeps this function from ever
  // touching the database on a fresh open.
  if (currentVersion === 0) return;

  const statement = database.prepare(
    "SELECT name, sql_digest FROM console_schema_migrations WHERE version = ?",
  );

  for (const migration of migrations) {
    if (migration.version > currentVersion) continue;

    const recorded = statement.get(migration.version);
    if (recorded === undefined) continue;

    const digest = computeStatementsDigest(migration.statements);
    if (
      recorded["name"] !== migration.name ||
      recorded["sql_digest"] !== digest
    ) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
        `console store migration ${String(migration.version)} no longer matches its recorded history - it appears to have been edited after it was applied`,
        { context: { version: migration.version, name: migration.name } },
      );
    }
  }
}

/**
 * Applies one migration inside its own `BEGIN IMMEDIATE` transaction:
 * `BEGIN IMMEDIATE` -\> each of `migration.statements` in order -\> a
 * history row into `console_schema_migrations` -\> the
 * `PRAGMA user_version = <migration.version>` statement -\> `COMMIT`. Any
 * failure rolls back the whole transaction and re-throws, wrapped with
 * `{ version, name }` context - never the failing SQL text or bound values.
 *
 * `BEGIN IMMEDIATE`, not `BEGIN`, is deliberate: it acquires the write lock
 * up front, so a competing writer fails immediately at `BEGIN` rather than
 * deadlocking partway through this migration's DDL.
 *
 * `migration.version` is interpolated directly into the
 * `PRAGMA user_version` statement - `PRAGMA user_version = ?` is a
 * measured syntax error, so it cannot be bound. This is safe only because
 * {@link validateRegistry} already ran, unconditionally, before
 * {@link applyMigrations} ever reaches this function - see that function's
 * own TSDoc.
 */
function applyOneMigration(
  database: M3LSqliteDatabaseHandle,
  migration: M3LMigration,
): void {
  const errorContext = { version: migration.version, name: migration.name };

  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    throw storeError(
      classifyStoreFailure(cause),
      "migrate",
      "failed to begin the console store migration transaction",
      cause,
      errorContext,
    );
  }

  try {
    for (const sql of migration.statements) {
      database.exec(sql);
    }

    database
      .prepare(
        "INSERT INTO console_schema_migrations (version, name, applied_at_ms, node_version, sql_digest) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        migration.version,
        migration.name,
        Date.now(),
        process.version,
        computeStatementsDigest(migration.statements),
      );

    database.exec(`PRAGMA user_version = ${String(migration.version)}`);
    database.exec("COMMIT");
  } catch (cause) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* best-effort - the failure below is what the caller needs to see */
    }
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(
      classifyStoreFailure(cause),
      "migrate",
      "console store migration failed",
      cause,
      errorContext,
    );
  }
}

/**
 * Applies every pending migration in `migrations` to `database`, returning
 * how many were actually applied.
 *
 * Sequence:
 * 1. {@link validateRegistry} - before the database is touched at all.
 * 2. Read `PRAGMA user_version` (the authoritative current schema version).
 * 3. Refuse a database strictly ahead of the registry's highest version
 *    ({@link assertNotAheadOfRegistry}) - equal is fine, nothing pending.
 * 4. Detect an edited-in-place migration against the recorded history
 *    ({@link assertNoHistoryDrift}).
 * 5. Apply every migration whose version is greater than the current
 *    version, in order, each in its own transaction
 *    ({@link applyOneMigration}).
 *
 * @param database - An already-open {@link M3LSqliteDatabaseHandle}.
 * @param migrations - The ordered migration registry to apply, typically
 * `store/migrations/registry.ts`'s `CONSOLE_MIGRATIONS`.
 * @returns The number of migrations actually applied (`0` when the database
 * is already fully up to date).
 * @throws {@link M3LConsoleError} - `ERR_CONSOLE_STORE_MIGRATION_FAILED` for
 * an invalid registry or a failed migration, `ERR_CONSOLE_STORE_SCHEMA_DRIFT`
 * for a database ahead of the registry or an edited-in-place migration, or
 * `ERR_CONSOLE_STORE_BUSY` for a `SQLITE_BUSY` encountered while migrating.
 *
 * @example
 * ```ts
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 * import { CONSOLE_MIGRATIONS } from "@m3l-automation/m3l-console-server/store/migrations/registry";
 *
 * const database = openSqliteDatabase(":memory:");
 * const applied = applyMigrations(database, CONSOLE_MIGRATIONS);
 * ```
 */
export function applyMigrations(
  database: M3LSqliteDatabaseHandle,
  migrations: readonly M3LMigration[],
): number {
  validateRegistry(migrations);

  const lastMigration = migrations[migrations.length - 1];
  const highestVersion =
    lastMigration === undefined ? 0 : lastMigration.version;
  const currentVersion = readCurrentSchemaVersion(database);

  assertNotAheadOfRegistry(currentVersion, highestVersion);
  assertNoHistoryDrift(database, migrations, currentVersion);

  let appliedCount = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    applyOneMigration(database, migration);
    appliedCount += 1;
  }

  return appliedCount;
}
