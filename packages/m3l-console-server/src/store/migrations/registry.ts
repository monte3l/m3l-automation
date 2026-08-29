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

import { runStatusCheckList } from "../run-status.js";

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
 * The exact DDL for `console_runs`, `CONSOLE_MIGRATIONS`' v3 (X4
 * run-registry). The `status` vocabulary is generated from
 * {@link runStatusCheckList} rather than hand-typed here a second time —
 * that function's entire purpose is to be the one place this list is
 * spelled out.
 *
 * Two measured findings about the FSM-shaped `CHECK` constraints below, from
 * exercising them against a real `:memory:` database — record both here so a
 * later edit does not reintroduce either hole:
 *
 * **(a) The `ended_at_ms >= started_at_ms` and `started_at_ms IS NOT NULL`
 * checks are load-bearing as a PAIR for every status except one deliberate
 * exemption.** SQLite treats a `CHECK` that evaluates to SQL `NULL` as
 * *satisfied*, not violated — so
 * `CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)` does **not**
 * fire when `started_at_ms` is `NULL` and `ended_at_ms` is not: the
 * comparison itself evaluates to `NULL`. For every status other than
 * `'interrupted'`, that state (`ended_at_ms` set, `started_at_ms` `NULL`) is
 * rejected only because the sibling
 * `CHECK (ended_at_ms IS NULL OR started_at_ms IS NOT NULL OR status = 'interrupted')`
 * independently forbids it — so for those statuses the pair must still be
 * edited, or removed, together, or this hole silently reopens.
 *
 * For `status = 'interrupted'`, the NULL-satisfaction is **deliberate, not a
 * hole**: a run can end without ever having started — a `SIGKILL` while it
 * sat `queued` produces exactly this — and boot reconciliation
 * (`reconcileOrphaned`, `store/runs-repository.ts`) must be able to record
 * that outcome without fabricating a `started_at_ms`. Fabricating one would
 * destroy an operationally decisive distinction (`started_at_ms IS NULL`
 * means "never executed, safe to re-launch"; `IS NOT NULL` means "killed
 * mid-execution, may have left side effects") and would make any
 * `ended - started` duration silently include the queue wait. Only
 * `'interrupted'` is exempted — no other terminal status may legitimately
 * end without starting, so the pairing still holds everywhere else.
 *
 * **(b) The status/ended_at_ms pairing check is NOT vulnerable to that
 * trap**, and it is worth saying why: `status` is `NOT NULL`, so
 * `status IN ('queued','running')` is always a determinate `0`/`1`, never
 * `NULL` — and `x IS NULL` is *itself* always determinate (`IS NULL` never
 * evaluates to `NULL`). So
 * `CHECK ((status IN ('queued','running')) = (ended_at_ms IS NULL))` can
 * never be satisfied-by-`NULL`; it genuinely means "pending iff not yet
 * ended, terminal iff ended" with no gap.
 *
 * **This constant was edited in place, not additively migrated, and that is
 * only safe right now.** `store/migrations/runner.ts` digests each
 * migration's `statements` to detect an already-applied migration being
 * edited underneath a deployment. v3 has never shipped — X4 is unmerged — so
 * no deployment can observe this edit as drift. This window closes at merge:
 * once v3 has been applied anywhere, correcting it further would need a new,
 * additive v4 migration instead.
 */
const CREATE_CONSOLE_RUNS_TABLE = `
  CREATE TABLE console_runs (
    id TEXT PRIMARY KEY,
    script TEXT NOT NULL,
    status TEXT NOT NULL CHECK (${runStatusCheckList()}),
    dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('spawn','in-process')),
    parameters_json TEXT NOT NULL,
    operator TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    queued_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    ended_at_ms INTEGER,
    outcome TEXT,
    exit_code INTEGER,
    failure_message TEXT,
    CHECK (started_at_ms IS NULL OR started_at_ms >= queued_at_ms),
    CHECK (
      ended_at_ms IS NULL
      OR started_at_ms IS NOT NULL
      OR status = 'interrupted'
    ),
    CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    CHECK ((status IN ('queued','running')) = (ended_at_ms IS NULL)),
    CHECK ((outcome IS NULL) = (ended_at_ms IS NULL))
  ) STRICT
`;

/** `console_runs`' first index: the run queue/board scan order. */
const CREATE_CONSOLE_RUNS_STATUS_INDEX = `
  CREATE INDEX console_runs_status_queued_at ON console_runs (status, queued_at_ms)
`;

/** `console_runs`' second index: per-script status lookups. */
const CREATE_CONSOLE_RUNS_SCRIPT_INDEX = `
  CREATE INDEX console_runs_script_status ON console_runs (script, status)
`;

/**
 * The exact DDL for `console_sessions`, `CONSOLE_MIGRATIONS`' v4 (X6
 * workbench-sessions module, slice 1). The `status` vocabulary is a
 * console-local `open`/`closed` pair — deliberately NOT
 * {@link runStatusCheckList}'s run-status vocabulary, which describes one
 * run's own lifecycle, not a session's.
 *
 * The `CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL))` constraint
 * mirrors `console_runs`' own status/`ended_at_ms` pairing (see
 * {@link CREATE_CONSOLE_RUNS_TABLE}'s finding (b)): `status` is `NOT NULL`,
 * so `status = 'closed'` is always a determinate `0`/`1`, never `NULL`, and
 * `closed_at_ms IS NOT NULL` is itself always determinate — so this pairing
 * can never be satisfied-by-`NULL`. It genuinely means "open iff never
 * closed, closed iff `closed_at_ms` is set", with no gap.
 */
const CREATE_CONSOLE_SESSIONS_TABLE = `
  CREATE TABLE console_sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    operator TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL))
  ) STRICT
`;

/** `console_sessions`' index: the session board scan order. */
const CREATE_CONSOLE_SESSIONS_STATUS_INDEX = `
  CREATE INDEX console_sessions_status_updated_at ON console_sessions (status, updated_at_ms)
`;

/**
 * The exact DDL for `console_session_steps`, `CONSOLE_MIGRATIONS`' v4. One
 * step within a session's ordered plan, referencing `console_sessions(id)`
 * and, once claimed, an underlying `console_runs(id)` (X4's run registry) —
 * that second reference is deliberately NOT a `REFERENCES` foreign key: a
 * step can be inserted (and even claimed/finished) before, or entirely
 * without, an underlying run existing, so a hard FK here would reject
 * otherwise-valid rows.
 *
 * The `status` vocabulary, and every FSM-shaped `CHECK` constraint below, are
 * reproduced verbatim from {@link CREATE_CONSOLE_RUNS_TABLE} — same
 * {@link runStatusCheckList} vocabulary, same five `CHECK` constraints, same
 * two measured findings about how they interact (see that constant's own
 * TSDoc for the full explanation, not repeated here): a step's lifecycle is
 * the same FSM shape as a run's, just scoped to one session's ordinal
 * position rather than to a script invocation.
 */
const CREATE_CONSOLE_SESSION_STEPS_TABLE = `
  CREATE TABLE console_session_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES console_sessions(id),
    ordinal INTEGER NOT NULL,
    operation TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL CHECK (${runStatusCheckList()}),
    result_ref TEXT,
    queued_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    ended_at_ms INTEGER,
    outcome TEXT,
    failure_message TEXT,
    UNIQUE (session_id, ordinal),
    CHECK (started_at_ms IS NULL OR started_at_ms >= queued_at_ms),
    CHECK (
      ended_at_ms IS NULL
      OR started_at_ms IS NOT NULL
      OR status = 'interrupted'
    ),
    CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    CHECK ((status IN ('queued','running')) = (ended_at_ms IS NULL)),
    CHECK ((outcome IS NULL) = (ended_at_ms IS NULL))
  ) STRICT
`;

/** `console_session_steps`' index: ordinal-ordered scan within a session. */
const CREATE_CONSOLE_SESSION_STEPS_INDEX = `
  CREATE INDEX console_session_steps_session_ordinal ON console_session_steps (session_id, ordinal)
`;

/**
 * The exact DDL for `console_session_bindings`, `CONSOLE_MIGRATIONS`' v4. A
 * named reference a session's plan can bind a later step's parameter to
 * (e.g. `"step-1.result"`), scoped to one session.
 */
const CREATE_CONSOLE_SESSION_BINDINGS_TABLE = `
  CREATE TABLE console_session_bindings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES console_sessions(id),
    reference TEXT NOT NULL,
    expected_type TEXT NOT NULL,
    multi_select INTEGER NOT NULL CHECK (multi_select IN (0, 1)),
    created_at_ms INTEGER NOT NULL
  ) STRICT
`;

/** `console_session_bindings`' index: creation-ordered scan within a session. */
const CREATE_CONSOLE_SESSION_BINDINGS_INDEX = `
  CREATE INDEX console_session_bindings_session ON console_session_bindings (session_id, created_at_ms)
`;

/**
 * The exact DDL for `console_session_decisions`, `CONSOLE_MIGRATIONS`' v4. An
 * operator decision point raised by one step, referencing both
 * `console_sessions(id)` and `console_session_steps(id)`.
 *
 * Both `CHECK` constraints pairing `status = 'answered'` against
 * `answered_at_ms`/`answer_json` share {@link CREATE_CONSOLE_SESSIONS_TABLE}'s
 * own determinacy argument: `status` is `NOT NULL`, so neither pairing can
 * ever be satisfied-by-`NULL`.
 */
const CREATE_CONSOLE_SESSION_DECISIONS_TABLE = `
  CREATE TABLE console_session_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES console_sessions(id),
    step_id TEXT NOT NULL REFERENCES console_session_steps(id),
    prompt TEXT NOT NULL,
    options_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'answered')),
    answer_json TEXT,
    created_at_ms INTEGER NOT NULL,
    answered_at_ms INTEGER,
    CHECK ((status = 'answered') = (answered_at_ms IS NOT NULL)),
    CHECK ((status = 'answered') = (answer_json IS NOT NULL))
  ) STRICT
`;

/** `console_session_decisions`' index: per-session status scan (the pending-decisions board). */
const CREATE_CONSOLE_SESSION_DECISIONS_INDEX = `
  CREATE INDEX console_session_decisions_session_status ON console_session_decisions (session_id, status)
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
 * without complaint. A further measured refinement, from v3's own
 * `console_runs`: `node:sqlite` binds a plain JS `number` as `SQLITE_FLOAT`,
 * so an integer bound into a `TEXT STRICT` column (e.g. `script`) stores as
 * `"12345.0"` — a REAL-to-TEXT storage-class cast, not `"12345"` — and is
 * still accepted, not rejected. Three tables now share this same
 * `STRICT`-is-not-type-enforcement caveat.
 *
 * - **v1** creates `console_schema_migrations`, the audit trail
 *   `applyMigrations` writes one row into per successfully applied
 *   migration. `node_version` is deliberate: it is what lets a later
 *   operator answer "which Node applied this migration?" when triaging a
 *   schema surprise, a question `applied_at_ms` alone cannot answer.
 * - **v2** creates `console_meta`, a closed key/value table backing the
 *   metadata repository built on top of it elsewhere in this package. This
 *   migration only creates the table; it does not populate it.
 * - **v3** creates `console_runs` (X4 run-registry) and its two indexes: one
 *   run per script invocation, its FSM-shaped lifecycle enforced entirely by
 *   `CHECK` constraints (see the DDL constant just above this one for two
 *   measured findings about how those constraints interact). The `status`
 *   vocabulary is `store/run-status.ts`'s `M3LRunStatus`, generated into the
 *   `CHECK` via {@link runStatusCheckList} rather than spelled out a second
 *   time here.
 * - **v4** creates the four X6 workbench-sessions tables and their four
 *   indexes: `console_sessions` (one operator session), `console_session_steps`
 *   (an ordered plan within a session, reusing `console_runs`' own FSM `CHECK`
 *   shape and {@link runStatusCheckList} vocabulary), `console_session_bindings`
 *   (named references a later step's parameter can bind to), and
 *   `console_session_decisions` (an operator decision point raised by a step).
 *   `console_session_steps` and `console_session_decisions` carry `REFERENCES`
 *   foreign keys — enforced only once `store/store.ts`'s own
 *   `PRAGMA foreign_keys = ON` is set, per that pragma's documented ordering.
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
  {
    version: 3,
    name: "create_console_runs",
    statements: [
      CREATE_CONSOLE_RUNS_TABLE,
      CREATE_CONSOLE_RUNS_STATUS_INDEX,
      CREATE_CONSOLE_RUNS_SCRIPT_INDEX,
    ],
  },
  {
    version: 4,
    name: "create_console_sessions",
    statements: [
      CREATE_CONSOLE_SESSIONS_TABLE,
      CREATE_CONSOLE_SESSIONS_STATUS_INDEX,
      CREATE_CONSOLE_SESSION_STEPS_TABLE,
      CREATE_CONSOLE_SESSION_STEPS_INDEX,
      CREATE_CONSOLE_SESSION_BINDINGS_TABLE,
      CREATE_CONSOLE_SESSION_BINDINGS_INDEX,
      CREATE_CONSOLE_SESSION_DECISIONS_TABLE,
      CREATE_CONSOLE_SESSION_DECISIONS_INDEX,
    ],
  },
];
