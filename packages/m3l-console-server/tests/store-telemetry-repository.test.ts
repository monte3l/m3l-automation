/**
 * Tests for `src/store/telemetry-repository.ts` — `M3LConsoleTelemetryRepository`
 * (X8 slice 1 telemetry store foundation).
 *
 * `console_telemetry_rollup` (`store/migrations/registry.ts`'s v9) is a
 * rollup-bucket table: one row per (granularity × bucket × metric ×
 * dimensions), upserted per measurement. ADR-0070 scopes the whole feature
 * to "SQLite-grade aggregation, not an APM platform" (bounded growth is the
 * schema rather than a later bolt-on).
 *
 * Mirrors `tests/store-audit-repository.test.ts`'s own idiom: a repository
 * is a plain FUNCTION over the injected `M3LStoreQueryExecutor` port, never
 * a class holding a `DatabaseSync`. Every test here builds its own executor
 * directly over a real `:memory:` `node:sqlite` database and applies
 * `CONSOLE_MIGRATIONS`' own DDL `statements` directly (never
 * `store/store.ts`/`store/executor.ts`), so this file's `perFile` v8
 * coverage stays bound to `store/telemetry-repository.ts`,
 * `store/migrations/registry.ts`, and `store/types.ts`/
 * `errors/console-error.ts` for types.
 *
 * **`''` sentinel (empty string for "not applicable"):** every dimension
 * column in `console_telemetry_rollup` is `TEXT NOT NULL` because
 * `WITHOUT ROWID` makes every PK column implicitly NOT NULL, and NULL
 * dimensions silently defeat the upsert semantics (`NULL != NULL`, so the ON
 * CONFLICT target never matches). The repository maps its typed inputs to
 * `''` and surfaces `''` back to callers unchanged — the round-trip
 * sentinel tests below lock this behavior so a future "helpful" `undefined`
 * translation doesn't corrupt rollup counts.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import {
  createConsoleTelemetryRepository,
  telemetryBucketStartMs,
} from "../src/store/telemetry-repository.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
  M3LTelemetryMetric,
  M3LTelemetryPruneRequest,
  M3LTelemetryQuery,
} from "../src/store/telemetry-repository.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
} from "../src/store/types.js";

// ---------------------------------------------------------------------------
// Raw executor + migrated-database fixtures — mirrors
// tests/store-audit-repository.test.ts's own helpers, duplicated locally so
// this file's coverage stays bound to its own slice.
// ---------------------------------------------------------------------------

interface RawStatementPort {
  all(...parameters: readonly unknown[]): Record<string, unknown>[];
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  run(...parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

function prepareRaw(database: DatabaseSync, sql: string): RawStatementPort {
  return database.prepare(sql);
}

function toStatementArguments(
  parameters: M3LStoreParameters | undefined,
): readonly unknown[] {
  if (parameters === undefined) return [];
  return Array.isArray(parameters) ? parameters : [parameters];
}

/** Builds a real {@link M3LStoreQueryExecutor} directly over a `node:sqlite` `DatabaseSync`. */
function createRawExecutor(database: DatabaseSync): M3LStoreQueryExecutor {
  return {
    all(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): readonly M3LStoreRow[] {
      const statement = prepareRaw(database, sql);
      const rows = statement.all(...toStatementArguments(parameters));
      return rows.map((row) => ({ ...row })) as readonly M3LStoreRow[];
    },
    get(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): M3LStoreRow | undefined {
      const statement = prepareRaw(database, sql);
      const row = statement.get(...toStatementArguments(parameters));
      return row === undefined ? undefined : ({ ...row } as M3LStoreRow);
    },
    run(sql: string, parameters?: M3LStoreParameters) {
      const statement = prepareRaw(database, sql);
      const result = statement.run(...toStatementArguments(parameters));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    script(sql: string): void {
      database.exec(sql);
    },
  };
}

/**
 * Applies every `CONSOLE_MIGRATIONS` DDL statement to a fresh `:memory:`
 * database. Uses the raw DDL statements directly (never `applyMigrations`)
 * so this file's coverage stays bound to `telemetry-repository.ts` and its
 * direct dependencies, not to the migration runner.
 */
function createMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of CONSOLE_MIGRATIONS) {
    for (const statement of migration.statements) {
      database.exec(statement);
    }
  }
  return database;
}

function createRepository(
  database: DatabaseSync,
): M3LConsoleTelemetryRepository {
  return createConsoleTelemetryRepository(createRawExecutor(database));
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

/** Reads the raw `console_telemetry_rollup` row for a given (granularity, bucket_start_ms, metric). */
function readRawBucketRow(
  database: DatabaseSync,
  granularity: string,
  bucketStartMs: number,
  metric: string,
): Record<string, unknown> | undefined {
  const row = prepareRaw(
    database,
    `SELECT * FROM console_telemetry_rollup
     WHERE granularity = ? AND bucket_start_ms = ? AND metric = ?
     LIMIT 1`,
  ).get(granularity, bucketStartMs, metric);
  return row === undefined ? undefined : { ...row };
}

// ---------------------------------------------------------------------------
// Fixture builders — one per metric arm of M3LTelemetryMeasurement
// ---------------------------------------------------------------------------

/** A fully valid `http.request` measurement at minute granularity. */
function httpRequestMeasurement(
  overrides: Partial<
    Omit<Extract<M3LTelemetryMeasurement, { metric: "http.request" }>, "metric">
  > = {},
): M3LTelemetryMeasurement {
  return {
    metric: "http.request",
    granularity: "minute",
    bucketStartMs: 60_000,
    route: "/api/v1/test",
    outcome: "2xx",
    valueMs: 150,
    ...overrides,
  };
}

/** A fully valid `run.finished` measurement at minute granularity. */
function runFinishedMeasurement(
  overrides: Partial<
    Omit<Extract<M3LTelemetryMeasurement, { metric: "run.finished" }>, "metric">
  > = {},
): M3LTelemetryMeasurement {
  return {
    metric: "run.finished",
    granularity: "minute",
    bucketStartMs: 60_000,
    script: "scripts/example",
    operation: "export",
    outcome: "succeeded",
    valueMs: 200,
    ...overrides,
  };
}

/** A fully valid `sse.stream` measurement — counter, no measure. */
function sseStreamMeasurement(): M3LTelemetryMeasurement {
  return {
    metric: "sse.stream",
    granularity: "minute",
    bucketStartMs: 60_000,
    outcome: "stopped",
  };
}

/** A fully valid `policy.decision` measurement — counter, posture required, no measure. */
function policyDecisionMeasurement(): M3LTelemetryMeasurement {
  return {
    metric: "policy.decision",
    granularity: "minute",
    bucketStartMs: 60_000,
    posture: "auto",
    outcome: "allowed",
  };
}

/** A fully valid `store.health` measurement — measures in bytes, no outcome. */
function storeHealthMeasurement(): M3LTelemetryMeasurement {
  return {
    metric: "store.health",
    granularity: "minute",
    bucketStartMs: 60_000,
    valueBytes: 1_024,
  };
}

// ---------------------------------------------------------------------------
// Type-level contract: M3LTelemetryMeasurement is a discriminated union
// whose variants reject foreign dimensions at compile time.
// ---------------------------------------------------------------------------

describe("M3LTelemetryMeasurement — type-level contract (discriminated union)", () => {
  test("expectTypeOf: each variant rejects a foreign dimension at the type level", () => {
    // 'sse.stream' has no 'route' (that's 'http.request' only)
    type SseStream = Extract<M3LTelemetryMeasurement, { metric: "sse.stream" }>;
    expectTypeOf<SseStream>().not.toExtend<{ route: string }>();

    // 'http.request' carries 'route'
    type HttpRequest = Extract<
      M3LTelemetryMeasurement,
      { metric: "http.request" }
    >;
    expectTypeOf<HttpRequest>().toExtend<{ route: string }>();

    // 'store.health' carries 'valueBytes', not 'valueMs'
    type StoreHealth = Extract<
      M3LTelemetryMeasurement,
      { metric: "store.health" }
    >;
    expectTypeOf<StoreHealth>().toExtend<{ valueBytes: number }>();
    expectTypeOf<StoreHealth>().not.toExtend<{ valueMs: number }>();

    // 'policy.decision' carries 'posture', not 'route'
    type PolicyDecision = Extract<
      M3LTelemetryMeasurement,
      { metric: "policy.decision" }
    >;
    expectTypeOf<PolicyDecision>().toExtend<{ posture: string }>();
    expectTypeOf<PolicyDecision>().not.toExtend<{ route: string }>();

    // 'run.finished' carries 'script' and 'valueMs', not 'route'
    type RunFinished = Extract<
      M3LTelemetryMeasurement,
      { metric: "run.finished" }
    >;
    expectTypeOf<RunFinished>().toExtend<{ script: string }>();
    expectTypeOf<RunFinished>().toExtend<{ valueMs: number }>();
    expectTypeOf<RunFinished>().not.toExtend<{ route: string }>();
  });

  test("expectTypeOf: M3LTelemetryGranularity covers exactly 'minute'|'hour'|'day'", () => {
    expectTypeOf<M3LTelemetryGranularity>().toEqualTypeOf<
      "minute" | "hour" | "day"
    >();
  });

  test("expectTypeOf: M3LTelemetryMetric covers exactly the five documented metrics", () => {
    expectTypeOf<M3LTelemetryMetric>().toEqualTypeOf<
      | "http.request"
      | "run.finished"
      | "sse.stream"
      | "policy.decision"
      | "store.health"
    >();
  });

  test("expectTypeOf: M3LTelemetryBucket surfaces '' sentinel as string (not undefined)", () => {
    // The contract mandates an exact round-trip: '' is never translated to
    // undefined on the read path. Asserting string (not string | undefined)
    // locks this.
    expectTypeOf<M3LTelemetryBucket>().toExtend<{
      route: string;
      script: string;
      operation: string;
      outcome: string;
      posture: string;
    }>();
  });

  test("expectTypeOf: M3LConsoleTelemetryRepository port shape", () => {
    expectTypeOf<M3LConsoleTelemetryRepository>().toExtend<{
      record: (measurement: M3LTelemetryMeasurement) => void;
      recordAll: (measurements: readonly M3LTelemetryMeasurement[]) => number;
      list: (query: M3LTelemetryQuery) => readonly M3LTelemetryBucket[];
      count: () => number;
      prune: (request: M3LTelemetryPruneRequest) => number;
    }>();
  });
});

// ---------------------------------------------------------------------------
// telemetryBucketStartMs — pure helper
// ---------------------------------------------------------------------------

describe("telemetryBucketStartMs — floors atMs to the UTC-aligned bucket boundary", () => {
  test.each<[string, number, M3LTelemetryGranularity, number]>([
    [
      "minute: 75,000 ms → 60,000 ms (1-minute boundary)",
      75_000,
      "minute",
      60_000,
    ],
    ["minute: already aligned 60,000 ms → 60,000 ms", 60_000, "minute", 60_000],
    [
      "hour: 3,601,000 ms → 3,600,000 ms (1-hour boundary)",
      3_601_000,
      "hour",
      3_600_000,
    ],
    [
      "hour: already aligned 3,600,000 ms → 3,600,000 ms",
      3_600_000,
      "hour",
      3_600_000,
    ],
    [
      "day: 86,400,001 ms → 86,400,000 ms (UTC midnight boundary)",
      86_400_001,
      "day",
      86_400_000,
    ],
    [
      "day: already aligned 86,400,000 ms → 86,400,000 ms",
      86_400_000,
      "day",
      86_400_000,
    ],
    ["minute: 0 ms → 0 ms (epoch boundary)", 0, "minute", 0],
  ])("%s", (_label, atMs, granularity, expected) => {
    expect(telemetryBucketStartMs(atMs, granularity)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// record — upsert merge semantics
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — record() upsert merge", () => {
  test("two records for the same (granularity, bucket, metric, dimensions) merge into one row with sample_count 2", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ valueMs: 100 }));
    repository.record(httpRequestMeasurement({ valueMs: 200 }));

    expect(repository.count()).toBe(1);
    const raw = readRawBucketRow(database, "minute", 60_000, "http.request");
    expect(raw?.["sample_count"]).toBe(2);
  });

  test("sum_value accumulates across merged records", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ valueMs: 100 }));
    repository.record(httpRequestMeasurement({ valueMs: 200 }));

    const raw = readRawBucketRow(database, "minute", 60_000, "http.request");
    expect(raw?.["sum_value"]).toBe(300);
  });

  test("min_value tracks the minimum across merged records", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ valueMs: 300 }));
    repository.record(httpRequestMeasurement({ valueMs: 100 }));
    repository.record(httpRequestMeasurement({ valueMs: 200 }));

    const raw = readRawBucketRow(database, "minute", 60_000, "http.request");
    expect(raw?.["min_value"]).toBe(100);
  });

  test("max_value tracks the maximum across merged records", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ valueMs: 100 }));
    repository.record(httpRequestMeasurement({ valueMs: 500 }));
    repository.record(httpRequestMeasurement({ valueMs: 300 }));

    const raw = readRawBucketRow(database, "minute", 60_000, "http.request");
    expect(raw?.["max_value"]).toBe(500);
  });

  test("records with different dimensions create separate rows, not merged", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ route: "/api/v1/runs" }));
    repository.record(httpRequestMeasurement({ route: "/api/v1/sessions" }));

    expect(repository.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// record — counter metrics keep NULL measures
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — counter metrics keep NULL measures", () => {
  test("sse.stream: three records produce sample_count 3 and NULL sum/min/max", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(sseStreamMeasurement());
    repository.record(sseStreamMeasurement());
    repository.record(sseStreamMeasurement());

    const raw = readRawBucketRow(database, "minute", 60_000, "sse.stream");
    expect(raw?.["sample_count"]).toBe(3);
    // Measures must stay NULL, not become 0 (would defeat the all-or-nothing
    // CHECK that distinguishes "no value" from "value is zero")
    expect(raw?.["sum_value"]).toBeNull();
    expect(raw?.["min_value"]).toBeNull();
    expect(raw?.["max_value"]).toBeNull();
  });

  test("policy.decision: three records produce sample_count 3 and NULL sum/min/max", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(policyDecisionMeasurement());
    repository.record(policyDecisionMeasurement());
    repository.record(policyDecisionMeasurement());

    const raw = readRawBucketRow(database, "minute", 60_000, "policy.decision");
    expect(raw?.["sample_count"]).toBe(3);
    expect(raw?.["sum_value"]).toBeNull();
    expect(raw?.["min_value"]).toBeNull();
    expect(raw?.["max_value"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordAll
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — recordAll()", () => {
  test("recordAll returns the number of measurements processed", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const count = repository.recordAll([
      httpRequestMeasurement({ route: "/api/v1/runs" }),
      httpRequestMeasurement({ route: "/api/v1/sessions" }),
      sseStreamMeasurement(),
    ]);

    expect(count).toBe(3);
    expect(repository.count()).toBe(3);
  });

  test("recordAll([]) returns 0 and inserts no rows", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const count = repository.recordAll([]);

    expect(count).toBe(0);
    expect(repository.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// '' sentinel round-trip
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — '' sentinel round-trip", () => {
  test("list() surfaces '' (empty string) for not-applicable dimensions — never undefined", () => {
    // The '' sentinel is the ENTIRE reason WITHOUT ROWID works: NULL != NULL
    // defeats the upsert merge; '' = '' does not. Translating '' to undefined
    // on the read path would make the read shape lie about what is stored,
    // and a subsequent record() call using the bucket would insert a NEW row
    // instead of merging — a silent double-count.
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement());
    const [bucket] = repository.list({ granularity: "minute", limit: 10 });

    // http.request uses route; these must be ''
    expect(bucket?.script).toBe("");
    expect(bucket?.operation).toBe("");
    expect(bucket?.posture).toBe("");
    // route and outcome are non-empty for this metric
    expect(bucket?.route).toBe("/api/v1/test");
    expect(bucket?.outcome).toBe("2xx");
  });

  test("list() surfaces '' for all not-applicable dimensions on 'store.health' (including outcome)", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(storeHealthMeasurement());
    const [bucket] = repository.list({ granularity: "minute", limit: 10 });

    expect(bucket?.route).toBe("");
    expect(bucket?.script).toBe("");
    expect(bucket?.operation).toBe("");
    expect(bucket?.outcome).toBe("");
    expect(bucket?.posture).toBe("");
  });
});

// ---------------------------------------------------------------------------
// list — filtering and ordering
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — list() filtering", () => {
  test("metric filter narrows to that metric only", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement());
    repository.record(sseStreamMeasurement());
    repository.record(policyDecisionMeasurement());

    const results = repository.list({
      granularity: "minute",
      metric: "sse.stream",
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.metric).toBe("sse.stream");
  });

  test("fromMs and toMs are both inclusive — a bucket exactly at a bound is included", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ bucketStartMs: 60_000 }));
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 120_000, route: "/api/v1/b" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 180_000, route: "/api/v1/c" }),
    );

    const results = repository.list({
      granularity: "minute",
      fromMs: 60_000,
      toMs: 120_000,
      limit: 10,
    });

    const buckets = results
      .map((r: M3LTelemetryBucket) => r.bucketStartMs)
      .sort((a, b) => a - b);
    expect(buckets).toEqual([60_000, 120_000]);
  });

  test("limit truncates the result set", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ route: "/api/v1/a" }));
    repository.record(httpRequestMeasurement({ route: "/api/v1/b" }));
    repository.record(httpRequestMeasurement({ route: "/api/v1/c" }));

    const results = repository.list({ granularity: "minute", limit: 2 });

    expect(results).toHaveLength(2);
  });

  test("no rows at a different granularity are returned when filtering by 'hour'", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    // Record a minute bucket — the list query asks for hour, so nothing matches
    repository.record(
      httpRequestMeasurement({ granularity: "minute", bucketStartMs: 60_000 }),
    );

    const results = repository.list({ granularity: "hour", limit: 10 });

    expect(results).toHaveLength(0);
  });
});

describe("createConsoleTelemetryRepository — list() ordering", () => {
  // These tests would all have failed against an implementation missing `ORDER BY`
  // entirely, which is the defect the ordering column is designed to prevent.
  // Never sort the returned array before asserting — that would defeat the proof.

  test("results are ordered by bucketStartMs DESC — most recent bucket first regardless of insertion order", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    // Insert out of chronological order to prove ORDER BY, not insertion order
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 120_000, route: "/api/v1/b" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 60_000, route: "/api/v1/a" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 180_000, route: "/api/v1/c" }),
    );

    const results = repository.list({ granularity: "minute", limit: 10 });

    expect(results.map((r) => r.bucketStartMs)).toEqual([
      180_000, 120_000, 60_000,
    ]);
  });

  test("limit keeps the most-recent N buckets — a missing ORDER BY would make the kept set arbitrary", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(
      httpRequestMeasurement({ bucketStartMs: 60_000, route: "/api/v1/a" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 120_000, route: "/api/v1/b" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 180_000, route: "/api/v1/c" }),
    );

    const results = repository.list({ granularity: "minute", limit: 2 });

    // Without ORDER BY, SQLite returns an unspecified 2 rows. With it, we get
    // the two newest: 180,000 then 120,000.
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.bucketStartMs)).toEqual([180_000, 120_000]);
  });

  test("within-bucket tiebreak on dimension columns is stable across repeated calls", () => {
    // Two rows share bucket_start_ms and metric; they differ only in 'route'.
    // The ORDER BY tiebreak (metric, route, …) must produce a repeatable order
    // so a caller can page reliably. Assert the same order on two list() calls.
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(
      httpRequestMeasurement({ bucketStartMs: 60_000, route: "/api/v1/z" }),
    );
    repository.record(
      httpRequestMeasurement({ bucketStartMs: 60_000, route: "/api/v1/a" }),
    );

    const first = repository.list({ granularity: "minute", limit: 10 });
    const second = repository.list({ granularity: "minute", limit: 10 });

    // The order is whatever the ORDER BY produces; both calls must agree exactly.
    expect(first.map((r) => r.route)).toEqual(second.map((r) => r.route));
    // And the two routes must appear in the correct lexicographic-ascending order
    // per the documented ORDER BY (route ASC as part of the dimension tiebreak).
    expect(first.map((r) => r.route)).toEqual(["/api/v1/a", "/api/v1/z"]);
  });
});

describe("createConsoleTelemetryRepository — list() field projection", () => {
  test("a returned bucket carries all documented fields with correct types", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ valueMs: 150 }));
    const [bucket] = repository.list({ granularity: "minute", limit: 10 });

    expect(bucket).toMatchObject({
      granularity: "minute",
      bucketStartMs: 60_000,
      metric: "http.request",
      route: "/api/v1/test",
      script: "",
      operation: "",
      outcome: "2xx",
      posture: "",
      sampleCount: 1,
      sumValue: 150,
      minValue: 150,
      maxValue: 150,
    });
  });

  test("a counter metric bucket has sumValue/minValue/maxValue as undefined", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(sseStreamMeasurement());
    const [bucket] = repository.list({ granularity: "minute", limit: 10 });

    expect(bucket?.sumValue).toBeUndefined();
    expect(bucket?.minValue).toBeUndefined();
    expect(bucket?.maxValue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — count()", () => {
  test("count() returns 0 when the table is empty", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.count()).toBe(0);
  });

  test("count() reflects the current number of distinct rollup rows", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ route: "/api/v1/a" }));
    repository.record(httpRequestMeasurement({ route: "/api/v1/b" }));
    repository.record(sseStreamMeasurement());
    // Merge — same dimensions, does NOT increase count
    repository.record(
      httpRequestMeasurement({ route: "/api/v1/a", valueMs: 999 }),
    );

    expect(repository.count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — prune()", () => {
  test("prune() returns the number of rows deleted", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(
      httpRequestMeasurement({ granularity: "minute", bucketStartMs: 60_000 }),
    );
    repository.record(
      httpRequestMeasurement({
        granularity: "minute",
        bucketStartMs: 120_000,
        route: "/api/v1/b",
      }),
    );
    repository.record(
      httpRequestMeasurement({
        granularity: "minute",
        bucketStartMs: 180_000,
        route: "/api/v1/c",
      }),
    );

    const deleted = repository.prune({
      granularity: "minute",
      beforeMs: 180_000,
    });

    expect(deleted).toBe(2);
  });

  test("prune() only removes rows of the matching granularity", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(
      httpRequestMeasurement({ granularity: "minute", bucketStartMs: 60_000 }),
    );
    repository.record(
      httpRequestMeasurement({ granularity: "hour", bucketStartMs: 3_600_000 }),
    );

    const deleted = repository.prune({
      granularity: "minute",
      beforeMs: 120_000,
    });

    expect(deleted).toBe(1);
    expect(repository.count()).toBe(1);
    const remaining = repository.list({ granularity: "hour", limit: 10 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.granularity).toBe("hour");
  });

  test("prune() with beforeMs before all rows deletes zero rows", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.record(httpRequestMeasurement({ bucketStartMs: 60_000 }));

    const deleted = repository.prune({ granularity: "minute", beforeMs: 0 });

    expect(deleted).toBe(0);
    expect(repository.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// record — validation guards (ERR_CONSOLE_BAD_REQUEST)
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — record() validation guards", () => {
  const invalidBucketStartMsValues: readonly [string, number][] = [
    ["a negative bucketStartMs", -1],
    ["a non-integer bucketStartMs", 1.5],
    ["NaN bucketStartMs", Number.NaN],
    ["Infinity bucketStartMs", Number.POSITIVE_INFINITY],
    ["an unsafe-integer bucketStartMs", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidBucketStartMsValues)(
    "rejects %s with ERR_CONSOLE_BAD_REQUEST",
    (_label, bucketStartMs) => {
      const database = createMigratedDatabase();
      const repository = createRepository(database);

      const thrown = captureFailure(() =>
        repository.record(
          httpRequestMeasurement({
            bucketStartMs,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(repository.count()).toBe(0);
    },
  );

  test("rejects a bucketStartMs not aligned to its granularity with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    // 61,000 ms is not a minute boundary (61_000 % 60_000 ≠ 0)
    const thrown = captureFailure(() =>
      repository.record(
        httpRequestMeasurement({
          granularity: "minute",
          bucketStartMs: 61_000,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.count()).toBe(0);
  });

  const invalidValueMsValues: readonly [string, number][] = [
    ["a negative valueMs", -1],
    ["a non-integer valueMs", 1.5],
    ["NaN valueMs", Number.NaN],
    ["Infinity valueMs", Number.POSITIVE_INFINITY],
    ["an unsafe-integer valueMs", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidValueMsValues)(
    "rejects a http.request measurement with %s with ERR_CONSOLE_BAD_REQUEST",
    (_label, valueMs) => {
      const database = createMigratedDatabase();
      const repository = createRepository(database);

      const thrown = captureFailure(() =>
        repository.record(httpRequestMeasurement({ valueMs })),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(repository.count()).toBe(0);
    },
  );

  test("rejects an empty-string route on 'http.request' with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      // F-pattern: typed union cannot represent empty route, simulate via cast
      repository.record({
        ...httpRequestMeasurement(),
        route: "",
      } as unknown as M3LTelemetryMeasurement),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.count()).toBe(0);
  });

  test("rejects a whitespace-only route on 'http.request' with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.record({
        ...httpRequestMeasurement(),
        route: "   ",
      } as unknown as M3LTelemetryMeasurement),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.count()).toBe(0);
  });

  test("rejects an empty-string script on 'run.finished' with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.record({
        ...runFinishedMeasurement(),
        script: "",
      } as unknown as M3LTelemetryMeasurement),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.count()).toBe(0);
  });

  test("rejects an empty-string posture on 'policy.decision' with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.record({
        ...policyDecisionMeasurement(),
        posture: "",
      } as unknown as M3LTelemetryMeasurement),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(repository.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// list — validation guards (ERR_CONSOLE_BAD_REQUEST)
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — list() query validation", () => {
  test("rejects a negative limit with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ granularity: "minute", limit: -1 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-integer limit with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ granularity: "minute", limit: 1.5 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-safe-integer fromMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({
        granularity: "minute",
        fromMs: Number.POSITIVE_INFINITY,
        limit: 10,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-safe-integer toMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ granularity: "minute", toMs: 1.5, limit: 10 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects fromMs > toMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({
        granularity: "minute",
        fromMs: 120_000,
        toMs: 60_000,
        limit: 10,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// failure classification — a generic executor failure is wrapped
// ---------------------------------------------------------------------------

describe("createConsoleTelemetryRepository — failure classification", () => {
  /**
   * A minimal stub {@link M3LStoreQueryExecutor} for probing failure paths
   * that a real `:memory:` database cannot easily produce. Any method not
   * overridden throws, so an unexpected call surfaces loudly rather than
   * silently returning a wrong default.
   */
  function createStubExecutor(
    overrides: Partial<M3LStoreQueryExecutor>,
  ): M3LStoreQueryExecutor {
    const unimplemented = (method: string) => (): never => {
      throw new Error(`stub executor: ${method} not implemented in this test`);
    };
    return {
      all: overrides.all ?? unimplemented("all"),
      get: overrides.get ?? unimplemented("get"),
      run: overrides.run ?? unimplemented("run"),
      script: overrides.script ?? unimplemented("script"),
    };
  }

  test("a generic executor failure from run() is wrapped as ERR_CONSOLE_STORE_QUERY_FAILED with the original error chained as cause", () => {
    const originalError = new Error("simulated executor failure");
    const executor = createStubExecutor({
      run: () => {
        throw originalError;
      },
    });
    const repository = createConsoleTelemetryRepository(executor);

    const thrown = captureFailure(() =>
      repository.record(httpRequestMeasurement()),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(originalError);
  });

  test("an M3LConsoleError thrown by the executor is re-thrown unchanged, not double-wrapped", () => {
    const originalError = new M3LConsoleError(
      "ERR_CONSOLE_STORE_BUSY",
      "simulated busy failure",
    );
    const executor = createStubExecutor({
      run: () => {
        throw originalError;
      },
    });
    const repository = createConsoleTelemetryRepository(executor);

    const thrown = captureFailure(() =>
      repository.record(httpRequestMeasurement()),
    );

    expect(thrown).toBe(originalError);
  });
});
