/**
 * `store/migrations/registry` — the ordered, version-controlled set of
 * schema migrations the console store applies at open (ADR-0069).
 *
 * A plain TypeScript array, not `migrations/*.sql` files:
 * `tsconfig.build.json` includes only `src/**\/*.ts` and there is no
 * asset-copy step, so a `.sql` file would never reach `dist/`. A
 * file-scanning runner would work in-repo and fail in the built package —
 * silently, and only in production.
 *
 * @packageDocumentation
 */

/**
 * One schema migration. Declared entirely as data — `version`, `name`, and
 * the `statements` it applies — never as an `up(executor)` function.
 *
 * **Why `statements`, not `up(executor)`:** `store/migrations/runner.ts`
 * computes a per-version drift digest (`sql_digest`, recorded in
 * `console_schema_migrations`) so an already-applied migration that gets
 * edited in place — same `version`, same `name`, different SQL — is caught
 * on the next boot instead of silently drifting from what actually ran in
 * production. That digest has to be computed over *something* stable. If a
 * migration were declared as an `up(executor)` function, the only available
 * source to digest would be the function's own source text
 * (`up.toString()`) — and that text changes whenever `prettier --write`
 * reformats this file, or a TypeScript version emits function bodies
 * differently, even though the migration's actual SQL never moved. A drift
 * detector whose entire job is separating real tampering from formatting
 * noise must not itself be formatting-noise-triggered; a false-positive
 * `ERR_CONSOLE_STORE_SCHEMA_DRIFT` at boot on every existing deployment is
 * far worse than never detecting drift at all.
 *
 * Declaring the SQL as plain string data instead fixes this on three
 * counts: the digest covers exactly what changes the schema; `prettier`
 * never reformats the *contents* of a string literal, so the digest is
 * stable across formatting and toolchain changes; and it removes any need
 * for a migration to `BEGIN`/`COMMIT` on its own, since it can no longer run
 * arbitrary code — the runner owns the one transaction each migration runs
 * inside.
 *
 * If a future migration genuinely needs procedural logic (e.g. a data
 * backfill), it can add an optional procedural step at that point, with the
 * digest still computed over `statements` only and the trade-off recorded
 * where it is taken. ADR-0069's forward-only, JSONL-is-authoritative
 * discipline means a backfill is normally "delete the file and re-index"
 * rather than migration code, so this may never come up.
 *
 * @example
 * ```ts
 * const migration: M3LMigration = {
 *   version: 3,
 *   name: "add_widgets_table",
 *   statements: ["CREATE TABLE widgets (id INTEGER PRIMARY KEY) STRICT"],
 * };
 * ```
 */
export interface M3LMigration {
  /** 1-based; the full registry must be strictly increasing and gap-free. */
  readonly version: number;
  /** Recorded in the audit trail; renaming an already-applied migration is drift. */
  readonly name: string;
  /**
   * The DDL statements this migration applies, in order, inside the one
   * transaction the runner owns for this migration. Digested (as a whole)
   * into the `sql_digest` recorded alongside this migration's history row —
   * see this interface's own TSDoc for why the digest is computed over this
   * field and never over a function body.
   */
  readonly statements: readonly string[];
}

/** The exact DDL for `console_schema_migrations`, `CONSOLE_MIGRATIONS`' v1. */
const CREATE_SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE console_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    node_version TEXT NOT NULL,
    sql_digest TEXT NOT NULL
  ) STRICT
`;

/** The exact DDL for `console_meta`, `CONSOLE_MIGRATIONS`' v2. */
const CREATE_META_TABLE = `
  CREATE TABLE console_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT
`;

/**
 * The console store's ordered migration set, applied in full by
 * `store/migrations/runner.ts`'s `applyMigrations` at every store open.
 *
 * Every table here is declared `STRICT`. Be honest about what that buys:
 * measured, an integer bound into a `TEXT STRICT` column is silently
 * accepted (`STRICT` checks storage-class compatibility, and SQLite treats
 * an integer as convertible text) — it is **not** the column-level type
 * enforcement its name suggests. `STRICT` is kept here for the failure mode
 * it does prevent: a `BLOB` or `NULL` landing in a column that was never
 * declared to accept one, which a non-`STRICT` table would otherwise store
 * without complaint.
 *
 * - **v1** creates `console_schema_migrations`, the audit trail
 *   `applyMigrations` writes one row into per successfully applied
 *   migration. `node_version` is deliberate: it is what lets a later
 *   operator answer "which Node applied this migration?" when triaging a
 *   schema surprise, a question `applied_at_ms` alone cannot answer.
 * - **v2** creates `console_meta`, a closed key/value table backing the
 *   metadata repository built on top of it elsewhere in this package. This
 *   migration only creates the table; it does not populate it.
 *
 * Forward-only, deliberately with no `down`: ADR-0069's `node:sqlite` store
 * only *indexes* authoritative JSONL, so recovering from a bad migration is
 * "delete the `.sqlite` file and re-index from JSONL" — strictly safer than
 * a reverse migration that would have to be correct against whatever partial
 * state a failed forward migration left behind.
 *
 * @example
 * ```ts
 * import { applyMigrations } from "@m3l-automation/m3l-console-server/store/migrations/runner";
 * import { CONSOLE_MIGRATIONS } from "@m3l-automation/m3l-console-server/store/migrations/registry";
 *
 * applyMigrations(database, CONSOLE_MIGRATIONS);
 * ```
 */
export const CONSOLE_MIGRATIONS: readonly M3LMigration[] = [
  {
    version: 1,
    name: "create_console_schema_migrations",
    statements: [CREATE_SCHEMA_MIGRATIONS_TABLE],
  },
  {
    version: 2,
    name: "create_console_meta",
    statements: [CREATE_META_TABLE],
  },
];
