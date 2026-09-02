/**
 * Tests for `CONSOLE_MIGRATIONS`' v9 migration — `console_telemetry_rollup`
 * (X8 slice 1 telemetry store) — `src/store/migrations/registry.ts`.
 *
 * A separate file from `tests/store-migrations-audit.test.ts` on purpose:
 * that file is 13,757 B and the full CHECK-constraint matrix for
 * `console_telemetry_rollup` (19 illegal shapes) would push it over the
 * 60,000 B `check:file-budget` test ceiling. This file exercises the ACTUAL
 * `CONSOLE_MIGRATIONS` registry (never a stand-in fixture), mirroring the
 * "real registry" structure of the sibling file for v6: the thing under test
 * is v9's own `CHECK` constraints, which only exist on the real
 * `console_telemetry_rollup` table.
 *
 * `applyMigrations`' generic behavior (rollback on failure, BUSY
 * classification, malformed-registry rejection, re-open no-op, and drift
 * detection mechanics) is already fully exercised against synthetic
 * registries in `tests/store-migrations.test.ts`; this file does not repeat
 * that generic proof. It proves only that v9, once appended to the real
 * registry, participates correctly in that already-proven machinery: it
 * applies, the table exists, it has NO secondary index (finding 4 from the
 * ADR probe — a secondary index made the whole-window aggregate 2× slower),
 * its own CHECK constraints hold for 8 legal shapes and reject 19 illegal
 * shapes, a no-op re-apply still works, and a tampered v9 history row is
 * still caught as drift.
 *
 * **Why `WITHOUT ROWID` + `NOT NULL` on every dimension.** The contract
 * measured that nullable dimensions with a `UNIQUE INDEX` fail silently:
 * `NULL != NULL`, so three identical upserts produce three rows with
 * `count: 1` instead of one row with `count: 3`. The `''` sentinel (empty
 * string for "not applicable to this metric") is what makes the rollup
 * semantics correct. Every test below exercises the real database directly
 * via raw SQL (never through a repository), so the CHECK constraints
 * themselves — not any validation layer above them — are what is under test.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import { applyMigrations } from "../src/store/migrations/runner.js";

// ---------------------------------------------------------------------------
// Helpers — mirrors store-migrations-audit.test.ts's own helpers
// ---------------------------------------------------------------------------

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

/** `true` when any index whose name starts with `prefix` exists in `database`. */
function indexWithPrefixExists(
  database: DatabaseSync,
  prefix: string,
): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ?",
    )
    .get(`${prefix}%`);
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
 * One `console_telemetry_rollup` row, in the column order of the INSERT
 * statement used throughout this file. `sample_count` is fixed at 1;
 * `sum_value`/`min_value`/`max_value` can be `null` for counter metrics.
 */
interface TelemetryRowFixture {
  readonly granularity: string;
  readonly bucket_start_ms: number | null;
  readonly metric: string;
  readonly route: string | null;
  readonly script: string | null;
  readonly operation: string | null;
  readonly outcome: string | null;
  readonly posture: string | null;
  readonly sample_count: number;
  readonly sum_value: number | null;
  readonly min_value: number | null;
  readonly max_value: number | null;
}

/** Inserts one `console_telemetry_rollup` row via raw SQL. */
function insertTelemetryRow(
  database: DatabaseSync,
  row: TelemetryRowFixture,
): void {
  database
    .prepare(
      `INSERT INTO console_telemetry_rollup (
        granularity, bucket_start_ms, metric,
        route, script, operation, outcome, posture,
        sample_count, sum_value, min_value, max_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.granularity,
      row.bucket_start_ms,
      row.metric,
      row.route,
      row.script,
      row.operation,
      row.outcome,
      row.posture,
      row.sample_count,
      row.sum_value,
      row.min_value,
      row.max_value,
    );
}

// ---------------------------------------------------------------------------
// Legal baseline fixtures — one per metric, used as positive controls and as
// the spread basis for the illegal-shape tests (one change per test).
// ---------------------------------------------------------------------------

/**
 * A fully valid `http.request` row at minute granularity.
 * Positive control for: non-empty route, non-empty outcome, measures present,
 * aligned minute bucket.
 */
function validHttpRequestRow(
  overrides: Partial<TelemetryRowFixture> = {},
): TelemetryRowFixture {
  return {
    granularity: "minute",
    bucket_start_ms: 60_000,
    metric: "http.request",
    route: "/api/v1/test",
    script: "",
    operation: "",
    outcome: "2xx",
    posture: "",
    sample_count: 1,
    sum_value: 150,
    min_value: 50,
    max_value: 150,
    ...overrides,
  };
}

/**
 * A fully valid `run.finished` row at minute granularity, with an operation.
 * Positive control for: non-empty script, non-empty operation, measures present.
 */
function validRunFinishedRow(
  overrides: Partial<TelemetryRowFixture> = {},
): TelemetryRowFixture {
  return {
    granularity: "minute",
    bucket_start_ms: 60_000,
    metric: "run.finished",
    route: "",
    script: "scripts/example",
    operation: "export",
    outcome: "succeeded",
    posture: "",
    sample_count: 1,
    sum_value: 200,
    min_value: 100,
    max_value: 200,
    ...overrides,
  };
}

/**
 * A fully valid `sse.stream` row at minute granularity — a counter metric
 * whose measures are always NULL.
 */
function validSseStreamRow(
  overrides: Partial<TelemetryRowFixture> = {},
): TelemetryRowFixture {
  return {
    granularity: "minute",
    bucket_start_ms: 60_000,
    metric: "sse.stream",
    route: "",
    script: "",
    operation: "",
    outcome: "stopped",
    posture: "",
    sample_count: 1,
    sum_value: null,
    min_value: null,
    max_value: null,
    ...overrides,
  };
}

/**
 * A fully valid `policy.decision` row at minute granularity — a counter metric
 * whose measures are always NULL.
 */
function validPolicyDecisionRow(
  overrides: Partial<TelemetryRowFixture> = {},
): TelemetryRowFixture {
  return {
    granularity: "minute",
    bucket_start_ms: 60_000,
    metric: "policy.decision",
    route: "",
    script: "",
    operation: "",
    outcome: "allowed",
    posture: "auto",
    sample_count: 1,
    sum_value: null,
    min_value: null,
    max_value: null,
    ...overrides,
  };
}

/**
 * A fully valid `store.health` row at minute granularity — measures in bytes;
 * outcome must be `''` (the DDL forbids it for this metric).
 */
function validStoreHealthRow(
  overrides: Partial<TelemetryRowFixture> = {},
): TelemetryRowFixture {
  return {
    granularity: "minute",
    bucket_start_ms: 60_000,
    metric: "store.health",
    route: "",
    script: "",
    operation: "",
    outcome: "",
    posture: "",
    sample_count: 1,
    sum_value: 1_024,
    min_value: 512,
    max_value: 1_024,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migration state tests
// ---------------------------------------------------------------------------

describe("CONSOLE_MIGRATIONS — the real registry (v9: console_telemetry_rollup)", () => {
  test("v9 has a stable, non-empty name distinct from every earlier migration's", () => {
    const names = CONSOLE_MIGRATIONS.map((migration) => migration.name);

    expect(new Set(names).size).toBe(names.length);
    const v9 = CONSOLE_MIGRATIONS.find((migration) => migration.version === 9);
    expect(v9).toBeDefined();
    expect(v9?.name.length).toBeGreaterThan(0);
  });

  test("applying every migration reaches user_version 9 and creates console_telemetry_rollup", () => {
    const database = createRealMigratedDatabase();

    expect(readUserVersion(database)).toBe(9);
    expect(tableExists(database, "console_telemetry_rollup")).toBe(true);
  });

  test("console_telemetry_rollup has NO secondary index — a secondary index was measured 2× slower (contract finding 4)", () => {
    // Finding 4 from the hub-probed contract: a (metric, granularity,
    // bucket_start_ms) index made whole-window aggregates 149ms vs 72ms
    // over 432,000 rows after ANALYZE. The PK *is* the index on a WITHOUT
    // ROWID table. This test is the permanent record of that decision:
    // a "helpful" optimizer adding an index here will fail this test and
    // have to explain why the 2× penalty is now acceptable.
    const database = createRealMigratedDatabase();

    expect(indexWithPrefixExists(database, "console_telemetry_rollup")).toBe(
      false,
    );
  });

  test("re-applying the full registry against an already-migrated database is a no-op", () => {
    const database = new DatabaseSync(":memory:");
    const firstApplied = applyMigrations(database, CONSOLE_MIGRATIONS);
    expect(firstApplied).toBe(CONSOLE_MIGRATIONS.length);

    const secondApplied = applyMigrations(database, CONSOLE_MIGRATIONS);

    expect(secondApplied).toBe(0);
    expect(readUserVersion(database)).toBe(9);
    expect(tableExists(database, "console_telemetry_rollup")).toBe(true);
  });

  test("schema drift — a tampered v9 sql_digest is caught on the next apply", () => {
    // VERIFY THIS GUARD BITES: the tampered row is the v9-specific entry;
    // if the guard silently passes, the test reports a wrong result. The
    // pattern mirrors store-migrations-audit.test.ts:364-379.
    const database = createRealMigratedDatabase();

    database.exec(
      "UPDATE console_schema_migrations SET sql_digest = 'tampered-digest' WHERE version = 9",
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

// ---------------------------------------------------------------------------
// 8 legal shapes — one per metric variant, proving the CHECK constraints
// accept every documented shape
// ---------------------------------------------------------------------------

describe("CONSOLE_MIGRATIONS v9 — legal shapes accepted by the real database", () => {
  // T3 pattern from store-migrations-audit.test.ts: a CHECK-violations suite
  // that never inserts a valid member of each vocabulary proves nothing about
  // the ACCEPTANCE side. Each legal shape below inserts through raw SQL into
  // the real table (never a stand-in fixture), so a silently narrowed CHECK
  // shows up here first.

  test("http.request at minute granularity — non-empty route, measures present", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validHttpRequestRow()),
    ).not.toThrow();
  });

  test("http.request at hour granularity — aligned to 3,600,000 ms", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(
        database,
        validHttpRequestRow({
          granularity: "hour",
          bucket_start_ms: 3_600_000,
        }),
      ),
    ).not.toThrow();
  });

  test("http.request at day granularity — aligned to 86,400,000 ms", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(
        database,
        validHttpRequestRow({
          granularity: "day",
          bucket_start_ms: 86_400_000,
        }),
      ),
    ).not.toThrow();
  });

  test("run.finished with a non-empty operation — operation allowed when metric is 'run.finished'", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validRunFinishedRow()),
    ).not.toThrow();
  });

  test("run.finished with an empty operation — operation is optional for 'run.finished'", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validRunFinishedRow({ operation: "" })),
    ).not.toThrow();
  });

  test("sse.stream — counter metric, NULL measures, non-empty outcome is permitted", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validSseStreamRow()),
    ).not.toThrow();
  });

  test("policy.decision — counter metric, NULL measures, non-empty posture required", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validPolicyDecisionRow()),
    ).not.toThrow();
  });

  test("store.health — measures present in bytes, outcome must be ''", () => {
    const database = createRealMigratedDatabase();

    expect(() =>
      insertTelemetryRow(database, validStoreHealthRow()),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 19 illegal shapes — every CHECK constraint has at least one violation.
// Each row is a single-field departure from an otherwise valid baseline, so
// exactly ONE documented CHECK constraint is violated — never a proxy count.
// ---------------------------------------------------------------------------

describe("CONSOLE_MIGRATIONS v9 — 19 illegal shapes rejected by the real database", () => {
  // Every test here confirms the DATABASE itself rejects the row by matching
  // a distinctive fragment of the SQLite error message against the specific
  // CHECK constraint intended to fire. This is deliberately stricter than
  // `store-migrations-audit.test.ts`, which uses bare `.toThrow()` — that
  // table has far fewer overlapping constraints and the weaker form was
  // adequate there. `console_telemetry_rollup` has 11 CHECKs, several of
  // which can reject the same row; a bare `.toThrow()` would pass if the
  // wrong constraint fired while the intended one was missing entirely.
  // The fragments below were probed against a real node:sqlite `:memory:`
  // database on this host and match the verbatim SQLite error text.

  const ILLEGAL_SHAPES: readonly [string, () => TelemetryRowFixture, RegExp][] =
    [
      // --- Alignment CHECKs ---
      [
        "unaligned minute bucket (30,000 ms mod 60,000 ≠ 0)",
        () =>
          validHttpRequestRow({
            granularity: "minute",
            bucket_start_ms: 30_000,
          }),
        /bucket_start_ms %/,
      ],
      [
        "unaligned hour bucket (1,800,000 ms mod 3,600,000 ≠ 0)",
        () =>
          validHttpRequestRow({
            granularity: "hour",
            bucket_start_ms: 1_800_000,
          }),
        /bucket_start_ms %/,
      ],

      // --- Vocabulary CHECKs ---
      [
        "unknown granularity 'second'",
        () => validHttpRequestRow({ granularity: "second" }),
        /granularity IN/,
      ],
      [
        "unknown metric 'cpu.usage'",
        () =>
          validSseStreamRow({
            metric: "cpu.usage",
            route: "",
            posture: "",
          }),
        /metric IN/,
      ],

      // --- route CHECK: (route <> '') = (metric = 'http.request') ---
      [
        "empty route on 'http.request' — route must be non-empty for http.request",
        () => validHttpRequestRow({ route: "" }),
        /\(route <> ''\) = \(metric = 'http\.request'\)/,
      ],
      [
        "non-empty route on 'sse.stream' — route must be '' for non-http.request metrics",
        () => validSseStreamRow({ route: "/api/v1/events" }),
        /\(route <> ''\) = \(metric = 'http\.request'\)/,
      ],

      // --- script CHECK: (script <> '') = (metric = 'run.finished') ---
      [
        "non-empty script on 'http.request' — script must be '' for non-run.finished metrics",
        () => validHttpRequestRow({ script: "scripts/example" }),
        /\(script <> ''\) = \(metric = 'run\.finished'\)/,
      ],

      // --- operation CHECK: operation = '' OR metric = 'run.finished' ---
      [
        "non-empty operation on 'sse.stream' — operation only permitted for run.finished",
        () => validSseStreamRow({ operation: "export" }),
        /operation = '' OR metric = 'run\.finished'/,
      ],

      // --- posture CHECK: (posture <> '') = (metric = 'policy.decision') ---
      [
        "non-empty posture on 'sse.stream' — posture only for policy.decision",
        () => validSseStreamRow({ posture: "auto" }),
        /\(posture <> ''\) = \(metric = 'policy\.decision'\)/,
      ],

      // --- outcome CHECK: outcome = '' OR metric <> 'store.health' ---
      [
        "non-empty outcome on 'store.health' — outcome must be '' for store.health",
        () => validStoreHealthRow({ outcome: "healthy" }),
        /outcome = '' OR metric <> 'store\.health'/,
      ],

      // --- sample_count CHECK ---
      [
        "sample_count = 0 — violates sample_count > 0",
        () => validHttpRequestRow({ sample_count: 0 }),
        /sample_count > 0/,
      ],

      // --- bucket_start_ms CHECK: bucket_start_ms >= 0 ---
      [
        "negative bucket_start_ms — violates bucket_start_ms >= 0",
        () => validHttpRequestRow({ bucket_start_ms: -1 }),
        /bucket_start_ms >= 0/,
      ],

      // --- sum/min/max all-or-nothing CHECKs ---
      [
        "sum_value set but min_value NULL — violates (sum_value IS NULL) = (min_value IS NULL)",
        () =>
          validHttpRequestRow({
            sum_value: 100,
            min_value: null,
            max_value: null,
          }),
        /\(sum_value IS NULL\) = \(min_value IS NULL\)/,
      ],

      // --- ordering CHECK: min_value >= 0 AND min_value <= max_value AND max_value <= sum_value ---
      // All three cases below fire the same compound CHECK expression; the regex
      // matches a fragment that distinguishes this constraint from the null-pairing
      // CHECKs above. The three inputs exercise different clauses of that compound:
      // min > max violates `min_value <= max_value`, max > sum violates
      // `max_value <= sum_value`, negative min violates `min_value >= 0`.
      [
        "min_value > max_value — violates the compound ordering CHECK",
        () =>
          validHttpRequestRow({
            sum_value: 200,
            min_value: 150,
            max_value: 100,
          }),
        /min_value <= max_value/,
      ],
      [
        "max_value > sum_value — violates the compound ordering CHECK",
        () =>
          validHttpRequestRow({
            sum_value: 100,
            min_value: 50,
            max_value: 200,
          }),
        /max_value <= sum_value/,
      ],
      [
        "negative min_value — violates the compound ordering CHECK",
        () =>
          validHttpRequestRow({
            sum_value: 10,
            min_value: -1,
            max_value: 5,
          }),
        /min_value >= 0/,
      ],

      // --- mandatory measures for 'http.request' and 'run.finished' ---
      [
        "NULL measures on 'http.request' — violates metric NOT IN (...) OR sum_value IS NOT NULL",
        () =>
          validHttpRequestRow({
            sum_value: null,
            min_value: null,
            max_value: null,
          }),
        /sum_value IS NOT NULL/,
      ],
      [
        "NULL measures on 'run.finished' — violates metric NOT IN (...) OR sum_value IS NOT NULL",
        () =>
          validRunFinishedRow({
            sum_value: null,
            min_value: null,
            max_value: null,
          }),
        /sum_value IS NOT NULL/,
      ],

      // --- NULL dimension — WITHOUT ROWID + NOT NULL on every dimension ---
      // All PK columns are implicitly NOT NULL on a WITHOUT ROWID table; every
      // dimension is also declared NOT NULL explicitly in a STRICT table.
      [
        "NULL route — dimension columns are NOT NULL (WITHOUT ROWID + STRICT)",
        () => validHttpRequestRow({ route: null }),
        /NOT NULL constraint failed/,
      ],
    ];

  test.each(ILLEGAL_SHAPES)(
    "rejects: %s",
    (_label, makeRow, constraintPattern) => {
      const database = createRealMigratedDatabase();

      expect(() => insertTelemetryRow(database, makeRow())).toThrow(
        constraintPattern,
      );
    },
  );
});
