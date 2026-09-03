/**
 * Tests for `CONSOLE_MIGRATIONS`' v6 migration — `console_human_actions`
 * (X7 human-action audit index, slice 4b) — `src/store/migrations/registry.ts`.
 *
 * A separate file from `tests/store-migrations.test.ts` on purpose:
 * `tests/store-migrations.test.ts` is 55,827 B against the 60,000 B
 * `check:file-budget` test ceiling, with only 4,173 B of headroom — nowhere
 * near enough for a full CHECK-constraint matrix on a new table. This file
 * exercises the ACTUAL `CONSOLE_MIGRATIONS` registry (never a stand-in
 * fixture), mirroring the "real registry" blocks at the end of the sibling
 * file for v3/v4/v5: the thing under test is v6's own `CHECK` constraints,
 * which only exist on the real `console_human_actions` table.
 *
 * `applyMigrations`' generic behavior (rollback on failure, BUSY
 * classification, malformed-registry rejection, re-open no-op, and drift
 * detection mechanics) is already fully exercised against synthetic
 * registries in `tests/store-migrations.test.ts`; this file does not repeat
 * that generic proof. It proves only that v6, once appended to the real
 * registry, participates correctly in that already-proven machinery: it
 * applies, its indexes exist, its own CHECK constraints hold, a no-op
 * re-apply still works with it present, and a tampered v6 history row is
 * still caught as drift.
 *
 * NOTE (flagged for the hub): once v6 is added, the sibling file's
 * `"has exactly five migrations, versions strictly increasing and gap-free
 * (1, 2, 3, 4, 5)"` assertion in `tests/store-migrations.test.ts` will start
 * failing (six migrations, not five). That one-line update belongs to
 * whoever lands v6 in `registry.ts` — out of scope for this file, which the
 * RED-phase instructions restrict to the two contract-named test files.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import { applyMigrations } from "../src/store/migrations/runner.js";

/** Applies the real `CONSOLE_MIGRATIONS` registry to a fresh `:memory:` database. */
function createRealMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, CONSOLE_MIGRATIONS);
  return database;
}

/** `true` when a table named `tableName` exists in `database`. */
function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

/** `true` when an index named `indexName` exists in `database`. */
function indexExists(database: DatabaseSync, indexName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);
  return row !== undefined;
}

/** Reads `PRAGMA user_version` as a plain number. */
function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : Number.NaN;
}

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * One `console_human_actions` row, in the column order `insertHumanAction`
 * binds positionally. `id` is the `INTEGER PRIMARY KEY` rowid alias and is
 * never bound — SQLite assigns it.
 */
interface HumanActionRowFixture {
  readonly at_ms: number;
  readonly operator: string;
  readonly operator_email_declared: number;
  readonly correlation_id: string;
  readonly action: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly script_name: string | null;
  readonly posture: string;
  readonly outcome: string;
}

/**
 * A fully valid `script`-target row — the positive control for the
 * `(script_name IS NULL) = (target_kind <> 'script')` pairing's "script"
 * arm: a script target REQUIRES `script_name`.
 */
function validScriptTargetRow(id: string): HumanActionRowFixture {
  return {
    at_ms: 1_000,
    operator: "alice",
    operator_email_declared: 1,
    correlation_id: `corr-${id}`,
    action: "run.launch",
    target_kind: "script",
    target_id: "scripts/example",
    script_name: "scripts/example",
    posture: "auto",
    outcome: "allowed",
  };
}

/**
 * A fully valid non-`script`-target row — the positive control for the same
 * pairing's other arm: any non-"script" target FORBIDS `script_name`.
 */
function validRunTargetRow(id: string): HumanActionRowFixture {
  return {
    at_ms: 1_000,
    operator: "alice",
    operator_email_declared: 0,
    correlation_id: `corr-${id}`,
    action: "run.cancel",
    target_kind: "run",
    target_id: `run-${id}`,
    script_name: null,
    posture: "confirmed",
    outcome: "allowed",
  };
}

/** Inserts one `console_human_actions` row, positionally bound in `HumanActionRowFixture`'s declared order. */
function insertHumanAction(
  database: DatabaseSync,
  row: HumanActionRowFixture,
): void {
  database
    .prepare(
      `INSERT INTO console_human_actions (
        at_ms, operator, operator_email_declared, correlation_id, action,
        target_kind, target_id, script_name, posture, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.at_ms,
      row.operator,
      row.operator_email_declared,
      row.correlation_id,
      row.action,
      row.target_kind,
      row.target_id,
      row.script_name,
      row.posture,
      row.outcome,
    );
}

describe("CONSOLE_MIGRATIONS — the real registry (v6: console_human_actions)", () => {
  test("v6 has a stable, non-empty name distinct from every earlier migration's", () => {
    const names = CONSOLE_MIGRATIONS.map((migration) => migration.name);

    expect(new Set(names).size).toBe(names.length);
    const v6 = CONSOLE_MIGRATIONS.find((migration) => migration.version === 6);
    expect(v6).toBeDefined();
    expect(v6?.name.length).toBeGreaterThan(0);
  });

  test("applying every migration reaches user_version 11 and creates console_human_actions with its three indexes", () => {
    const database = createRealMigratedDatabase();

    expect(readUserVersion(database)).toBe(11);
    expect(tableExists(database, "console_human_actions")).toBe(true);
    expect(indexExists(database, "console_human_actions_correlation_id")).toBe(
      true,
    );
    expect(indexExists(database, "console_human_actions_at_ms")).toBe(true);
    expect(indexExists(database, "console_human_actions_operator")).toBe(true);
  });

  test("re-applying the full registry against an already-migrated database is a no-op", () => {
    const database = new DatabaseSync(":memory:");
    const firstApplied = applyMigrations(database, CONSOLE_MIGRATIONS);
    expect(firstApplied).toBe(CONSOLE_MIGRATIONS.length);

    const secondApplied = applyMigrations(database, CONSOLE_MIGRATIONS);

    expect(secondApplied).toBe(0);
    expect(readUserVersion(database)).toBe(11);
    expect(tableExists(database, "console_human_actions")).toBe(true);
  });

  test("a valid script-target row inserts successfully", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertHumanAction(database, validScriptTargetRow("script-ok")),
    ).not.toThrow();
  });

  test("a valid non-script-target row (script_name NULL) inserts successfully", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertHumanAction(database, validRunTargetRow("run-ok")),
    ).not.toThrow();
  });

  // Every case below is a single-field departure from an otherwise fully
  // valid row, chosen so that exactly ONE documented CHECK constraint is
  // violated — never merely a proxy like "the row count did not change",
  // which would also hold if the insert had silently no-op'd instead of
  // throwing. Run through raw SQL against the real table (never through a
  // repository), so it is the DATABASE's own CHECK constraints under test.
  const CHECK_VIOLATIONS: readonly [string, HumanActionRowFixture][] = [
    [
      "an unknown action value",
      { ...validRunTargetRow("v-action"), action: "bogus.action" },
    ],
    [
      "an unknown target_kind value",
      { ...validRunTargetRow("v-target-kind"), target_kind: "bogus-kind" },
    ],
    [
      "an unknown posture value",
      { ...validRunTargetRow("v-posture"), posture: "bogus-posture" },
    ],
    [
      "an unknown outcome value",
      { ...validRunTargetRow("v-outcome"), outcome: "bogus-outcome" },
    ],
    [
      "an operator_email_declared value of 2",
      { ...validRunTargetRow("v-email-declared"), operator_email_declared: 2 },
    ],
    [
      "script_name set on a non-script target",
      {
        ...validRunTargetRow("v-script-name-on-non-script"),
        script_name: "scripts/example",
      },
    ],
    [
      "a NULL script_name on a script target",
      { ...validScriptTargetRow("v-null-script-name"), script_name: null },
    ],
  ];

  test.each(CHECK_VIOLATIONS)("rejects a row with %s", (_label, row) => {
    const database = createRealMigratedDatabase();

    expect(() => insertHumanAction(database, row)).toThrow();
  });

  // T3 — CHECK_VIOLATIONS above proves the DDL REJECTS a bogus value in each
  // of the four vocabulary columns; nothing before this point proves it
  // ACCEPTS every LEGITIMATE member. A typo dropping 'session.reopen' from
  // the DDL's `CHECK (action IN (...))` would pass the entire suite above —
  // CHECK_VIOLATIONS never inserts a real 'session.reopen' row — while
  // breaking every already-stored row of that action the moment a reader
  // tries to project it (`toHumanActionIndexKind` in
  // `store/audit-repository.ts`, F3's own motivating example). Loop each
  // vocabulary and insert one row per member, through raw SQL against the
  // REAL registry (never a stand-in fixture), so a silently narrowed CHECK
  // constraint shows up here first rather than downstream.
  const ACTION_VOCABULARY = [
    "run.launch",
    "run.cancel",
    "session.create",
    "session.step.add",
    // X7b (migration v7): SQLite cannot ALTER a CHECK, so this member cost a
    // full table recreate. Every future kind costs another one.
    "session.decision.raise",
    "session.decision.answer",
    "session.binding.select",
    "session.close",
    "session.reopen",
    // X7b (migration v8): all three view kinds land in ONE recreate, so the
    // report and artifact endpoints do not each force a third one.
    "view.run.report",
    "view.run.stream",
    "view.session.artifact",
  ] as const;

  test.each(ACTION_VOCABULARY)(
    "the action CHECK accepts the vocabulary member %s",
    (action) => {
      const database = createRealMigratedDatabase();

      expect(() =>
        insertHumanAction(database, {
          ...validRunTargetRow(`action-${action}`),
          action,
        }),
      ).not.toThrow();
    },
  );

  const TARGET_KIND_VOCABULARY = [
    "script",
    "run",
    "session",
    "step",
    "artifact",
  ] as const;

  test.each(TARGET_KIND_VOCABULARY)(
    "the target_kind CHECK accepts the vocabulary member %s (with the script_name pairing satisfied)",
    (targetKind) => {
      const database = createRealMigratedDatabase();
      const row =
        targetKind === "script"
          ? validScriptTargetRow(`target-kind-${targetKind}`)
          : {
              ...validRunTargetRow(`target-kind-${targetKind}`),
              target_kind: targetKind,
            };

      expect(() => insertHumanAction(database, row)).not.toThrow();
    },
  );

  const POSTURE_VOCABULARY = ["auto", "confirmed", "escalated"] as const;

  test.each(POSTURE_VOCABULARY)(
    "the posture CHECK accepts the vocabulary member %s",
    (posture) => {
      const database = createRealMigratedDatabase();

      expect(() =>
        insertHumanAction(database, {
          ...validRunTargetRow(`posture-${posture}`),
          posture,
        }),
      ).not.toThrow();
    },
  );

  const OUTCOME_VOCABULARY = [
    "allowed",
    "denied",
    "rejected",
    "failed",
    "served",
  ] as const;

  test.each(OUTCOME_VOCABULARY)(
    "the outcome CHECK accepts the vocabulary member %s",
    (outcome) => {
      const database = createRealMigratedDatabase();

      expect(() =>
        insertHumanAction(database, {
          ...validRunTargetRow(`outcome-${outcome}`),
          outcome,
        }),
      ).not.toThrow();
    },
  );

  test("schema drift — a tampered v6 sql_digest is caught on the next apply", () => {
    const database = createRealMigratedDatabase();

    database.exec(
      "UPDATE console_schema_migrations SET sql_digest = 'tampered-digest' WHERE version = 6",
    );

    const thrown = captureFailure(() =>
      applyMigrations(database, CONSOLE_MIGRATIONS),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
    );
  });
});
