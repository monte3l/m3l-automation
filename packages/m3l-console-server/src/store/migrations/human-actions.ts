/**
 * `store/migrations/human-actions` — the `console_human_actions` DDL and the
 * migrations that shape its closed `action` vocabulary.
 *
 * Split out of `./registry.ts` under ADR-0072's file-size ceiling: that file
 * had 1,408 bytes of headroom against the ~1,950 a new migration needs, and
 * every future action kind forces another one. This follows the same
 * precedent as `orchestrator-types.ts` and `audit-repository-types.ts`.
 *
 * **Why a new migration per action kind.** The vocabulary lives in an inline
 * SQLite `CHECK` constraint, and SQLite cannot `ALTER` a `CHECK` — so
 * widening it means recreating the table. Migration v6 is shipped and may
 * not be edited, hence v7 below. Note the v6 `CHECK`s on `target_kind` and
 * `outcome` already admit `'artifact'` and `'served'` respectively, so only
 * the `action` list ever needs recreating.
 *
 * @packageDocumentation
 */

/**
 * The exact DDL for `console_human_actions`, `CONSOLE_MIGRATIONS`' v6 (X7
 * human-action audit index, slice 4b). An INDEX over the JSONL audit trail,
 * never the record of truth: it carries only the queryable dimensions
 * (`store/audit-repository.ts` reads/writes it) — never `parameterNames`,
 * `parameterRefs`, or `detail`, which live in the stream only.
 *
 * `id INTEGER PRIMARY KEY` is a plain rowid alias: a row carries no natural
 * key, since the rebuild path is a full truncate-and-reinsert
 * (`store/audit-repository.ts`'s `deleteAll` + `insertAll`), so no dedupe
 * key is needed and none is invented.
 *
 * The trailing `CHECK` mirrors `M3LHumanActionTarget`'s own discriminated
 * union (`audit/record.ts`), whose `script` variant is the only one
 * carrying `scriptName`: `script_name` is present if and only if
 * `target_kind = 'script'`. This pairing is guarded by three layers, this
 * `CHECK` being the last of them, not a restatement of a guarantee the
 * others already hold unconditionally: `store/audit-repository.ts`'s own
 * `M3LHumanActionIndexInput` is a discriminated union on `targetKind`, which
 * forbids the illegal pairing at the typed call site; that module's
 * `requireValidTarget` runtime guard rejects it with
 * `ERR_CONSOLE_BAD_REQUEST` at the cast boundary, where an untyped caller
 * (e.g. a later slice's JSONL-rebuild path) can still reach `insert` past
 * the type system. Kept as a `CHECK`, not a nullable column with no
 * constraint, so the database itself is the backstop if both of those ever
 * fail to run — not because either one is dispensable.
 */
export const CREATE_CONSOLE_HUMAN_ACTIONS_TABLE = `
  CREATE TABLE console_human_actions (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    operator TEXT NOT NULL,
    operator_email_declared INTEGER NOT NULL CHECK (operator_email_declared IN (0, 1)),
    correlation_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'run.launch','run.cancel','session.create','session.step.add',
      'session.decision.answer','session.binding.select',
      'session.close','session.reopen'
    )),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('script','run','session','step','artifact')),
    target_id TEXT NOT NULL,
    script_name TEXT,
    posture TEXT NOT NULL CHECK (posture IN ('auto','confirmed','escalated')),
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','rejected','failed','served')),
    CHECK ((script_name IS NULL) = (target_kind <> 'script'))
  ) STRICT
`;

/** `console_human_actions`' first index: per-correlation lookups (the "show everything tied to this run/session" query). */
export const CREATE_CONSOLE_HUMAN_ACTIONS_CORRELATION_INDEX = `
  CREATE INDEX console_human_actions_correlation_id ON console_human_actions (correlation_id)
`;

/** `console_human_actions`' second index: time-range scans. */
export const CREATE_CONSOLE_HUMAN_ACTIONS_AT_MS_INDEX = `
  CREATE INDEX console_human_actions_at_ms ON console_human_actions (at_ms)
`;

/**
 * `console_human_actions`' third index: composite on `(operator, at_ms)`,
 * not bare `(operator)` — every operator query in the API is "what did this
 * operator do, most recent first", and a bare `(operator)` index would still
 * make SQLite sort the result set after the lookup.
 */
export const CREATE_CONSOLE_HUMAN_ACTIONS_OPERATOR_INDEX = `
  CREATE INDEX console_human_actions_operator ON console_human_actions (operator, at_ms)
`;

/**
 * `console_human_actions` recreated with `'session.decision.raise'` added to
 * the `action` vocabulary — `CONSOLE_MIGRATIONS`' v7 (X7b).
 *
 * A DROP + CREATE rather than an `ALTER`, because SQLite cannot alter a
 * `CHECK` constraint. Everything else about the table — every column, every
 * other `CHECK`, all three indexes — is byte-identical to v6; only the
 * `action` list differs.
 *
 * **Why this is loss-free, not a judgement call.** Two independent reasons,
 * both checkable: no `src/**` symbol inserts into this table as of v7 (the
 * write routes landing alongside this migration write the JSONL stream
 * only), so the table is empty in every deployment that could apply v7; and
 * the documented rebuild path for this index is already a full
 * truncate-and-reinsert from the JSONL trail (`store/audit-repository.ts`'s
 * `deleteAll` + `insertAll`), so even a populated table is reconstructible
 * from the record of truth.
 *
 * **If that stops being true, this migration must change.** Should any
 * intervening slice begin populating `console_human_actions` before a later
 * vocabulary widening ships, the next such migration must become a
 * copy-through: create the new table under a temporary name, copy the rows
 * across with an insert-select, drop the old table, then rename — rather
 * than a bare drop. Do not copy this one's shape
 * without re-checking that precondition.
 */
export const V7_WIDEN_HUMAN_ACTION_KINDS_STATEMENTS: readonly string[] = [
  `DROP TABLE console_human_actions`,
  `
  CREATE TABLE console_human_actions (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    operator TEXT NOT NULL,
    operator_email_declared INTEGER NOT NULL CHECK (operator_email_declared IN (0, 1)),
    correlation_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'run.launch','run.cancel','session.create','session.step.add',
      'session.decision.raise','session.decision.answer',
      'session.binding.select','session.close','session.reopen'
    )),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('script','run','session','step','artifact')),
    target_id TEXT NOT NULL,
    script_name TEXT,
    posture TEXT NOT NULL CHECK (posture IN ('auto','confirmed','escalated')),
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','rejected','failed','served')),
    CHECK ((script_name IS NULL) = (target_kind <> 'script'))
  ) STRICT
`,
  CREATE_CONSOLE_HUMAN_ACTIONS_CORRELATION_INDEX,
  CREATE_CONSOLE_HUMAN_ACTIONS_AT_MS_INDEX,
  CREATE_CONSOLE_HUMAN_ACTIONS_OPERATOR_INDEX,
];

/**
 * `console_human_actions` recreated with the three ADR-0070 `view.*` kinds
 * added — `CONSOLE_MIGRATIONS`' v8 (X7b).
 *
 * All twelve kinds in ONE migration, not one per endpoint. Only
 * `view.run.stream` has a route today (`GET /api/v1/runs/:id/stream`);
 * `view.run.report` and `view.session.artifact` are declared unwired
 * deliberately, so that when those endpoints land they do not each force a
 * THIRD table recreate. A declared-but-unused `CHECK` member costs nothing
 * at runtime; another recreate costs a migration and a review.
 *
 * Still loss-free on the same footing as v7: the write routes shipped in the
 * preceding slice populate the JSONL stream only, never this index.
 *
 * **The precondition this rests on, stated so it is checked and not
 * assumed.** If any slice between v7 and this migration began populating
 * `console_human_actions`, v8 must NOT be applied as written — it drops the
 * table. It would have to become a copy-through instead: create the new
 * table under a temporary name, copy the rows across with an insert-select,
 * drop the old table, then rename. Verify before extending this pattern.
 */
export const V8_ADD_VIEW_ACTION_KINDS_STATEMENTS: readonly string[] = [
  `DROP TABLE console_human_actions`,
  `
  CREATE TABLE console_human_actions (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    operator TEXT NOT NULL,
    operator_email_declared INTEGER NOT NULL CHECK (operator_email_declared IN (0, 1)),
    correlation_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'run.launch','run.cancel','session.create','session.step.add',
      'session.decision.raise','session.decision.answer',
      'session.binding.select','session.close','session.reopen',
      'view.run.report','view.run.stream','view.session.artifact'
    )),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('script','run','session','step','artifact')),
    target_id TEXT NOT NULL,
    script_name TEXT,
    posture TEXT NOT NULL CHECK (posture IN ('auto','confirmed','escalated')),
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','rejected','failed','served')),
    CHECK ((script_name IS NULL) = (target_kind <> 'script'))
  ) STRICT
`,
  CREATE_CONSOLE_HUMAN_ACTIONS_CORRELATION_INDEX,
  CREATE_CONSOLE_HUMAN_ACTIONS_AT_MS_INDEX,
  CREATE_CONSOLE_HUMAN_ACTIONS_OPERATOR_INDEX,
];
