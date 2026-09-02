/**
 * `store/telemetry-repository` — `createConsoleTelemetryRepository`, the
 * {@link M3LConsoleTelemetryRepository} built over `console_telemetry_rollup`
 * (`store/migrations/registry.ts`'s v9, X8 telemetry store foundation,
 * slice 1).
 *
 * `console_telemetry_rollup` is a rollup-bucket table: one row per
 * (granularity × bucket × metric × dimensions), upserted per measurement.
 * ADR-0070 scopes the feature to "SQLite-grade aggregation, not an APM
 * platform" so bounded growth is the schema, not a later bolt-on.
 *
 * Exactly `store/audit-repository.ts`'s shape: a repository is a plain
 * FUNCTION over the injected {@link M3LStoreQueryExecutor} port, never a
 * class holding a `DatabaseSync`.
 *
 * **`src/store/**` sits in the `store` eslint zone, asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs`** — so this file
 * cannot import from `src/audit/` or other zones.
 *
 * **`recordAll` opens no transaction of its own.** A failure partway through
 * a batch leaves the already-upserted rows persisted. The caller supplies a
 * transaction executor when it wants atomicity.
 *
 * **Counter metrics (`sse.stream`, `policy.decision`):** `sum_value`,
 * `min_value`, `max_value` bind as `NULL`; the `DO UPDATE` set only bumps
 * `sample_count` — a second statement that avoids the
 * `sum_value = sum_value + NULL` → `NULL` trap.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
  M3LTelemetryMetric,
  M3LTelemetryPruneRequest,
  M3LTelemetryQuery,
} from "./telemetry-repository-types.js";
import type {
  M3LStoreOutputValue,
  M3LStoreQueryExecutor,
  M3LStoreRow,
} from "./types.js";

export type {
  M3LConsoleTelemetryRepository,
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
  M3LTelemetryMetric,
  M3LTelemetryPruneRequest,
  M3LTelemetryQuery,
} from "./telemetry-repository-types.js";

// ---------------------------------------------------------------------------
// Module-level SQL consts
// ---------------------------------------------------------------------------

/** Upsert for a measure-bearing metric (`http.request`, `run.finished`, `store.health`). */
const SQL_UPSERT_WITH_VALUE = `
INSERT INTO console_telemetry_rollup (
  granularity, bucket_start_ms, metric,
  route, script, operation, outcome, posture,
  sample_count, sum_value, min_value, max_value
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
ON CONFLICT (
  granularity, bucket_start_ms, metric,
  route, script, operation, outcome, posture
) DO UPDATE SET
  sample_count = sample_count + 1,
  sum_value = sum_value + excluded.sum_value,
  min_value = MIN(min_value, excluded.min_value),
  max_value = MAX(max_value, excluded.max_value)
`;

/** Upsert for a pure counter metric (`sse.stream`, `policy.decision`). Measures stay NULL. */
const SQL_UPSERT_COUNTER = `
INSERT INTO console_telemetry_rollup (
  granularity, bucket_start_ms, metric,
  route, script, operation, outcome, posture,
  sample_count, sum_value, min_value, max_value
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL)
ON CONFLICT (
  granularity, bucket_start_ms, metric,
  route, script, operation, outcome, posture
) DO UPDATE SET
  sample_count = sample_count + 1
`;

/** Delete rows by granularity with bucket_start_ms strictly less than a bound. */
const SQL_PRUNE = `DELETE FROM console_telemetry_rollup WHERE granularity = ? AND bucket_start_ms < ?`;

/**
 * Base SELECT for `list()`: granularity filter. Optional metric/fromMs/toMs
 * clauses are appended by {@link buildTelemetryListFilter}, then the ORDER BY
 * and LIMIT are appended by the `list` implementation.
 *
 * `ORDER BY bucket_start_ms DESC` — most-recent-first, matching the audit
 * repository's convention: with a `limit`, a monitoring page wants the latest
 * N buckets, not the oldest N. The trailing dimension columns form a total
 * tiebreak within one bucket — the full PK is (granularity, bucket_start_ms,
 * metric, route, script, operation, outcome, posture), so no two rows in the
 * same granularity tier share those columns, making the result fully
 * deterministic.
 */
const SQL_LIST_BASE = `SELECT * FROM console_telemetry_rollup WHERE granularity = ?`;
const SQL_LIST_ORDER = ` ORDER BY bucket_start_ms DESC, metric, route, script, operation, outcome, posture`;

/** Count all rows. */
const SQL_COUNT = `SELECT COUNT(*) AS count FROM console_telemetry_rollup`;

// ---------------------------------------------------------------------------
// Column narrowing helpers
// ---------------------------------------------------------------------------

/** Raw column value including the TS-only `undefined` from `noUncheckedIndexedAccess`. */
type TelemetryColumnValue = M3LStoreOutputValue | undefined;

/** Throws when a `NOT NULL` column reads back as SQL `NULL` or TS `undefined`. */
function requireColumn(
  value: TelemetryColumnValue,
): string | number | bigint | Uint8Array {
  if (value === null || value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "console_telemetry_rollup row is missing a value for a NOT NULL column",
    );
  }
  return value;
}

/** Narrows to a required number, tolerating a `bigint` read. */
function toRequiredNumber(value: TelemetryColumnValue): number {
  return Number(requireColumn(value));
}

/** Narrows to a required string. */
function toRequiredString(value: TelemetryColumnValue): string {
  return String(requireColumn(value));
}

/** Narrows to an optional number: SQL `NULL` → `undefined`. */
function toOptionalNumber(value: TelemetryColumnValue): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

/** The closed {@link M3LTelemetryMetric} vocabulary as a key table for `Object.hasOwn`. */
const TELEMETRY_METRICS: Readonly<Record<M3LTelemetryMetric, true>> = {
  "http.request": true,
  "run.finished": true,
  "sse.stream": true,
  "policy.decision": true,
  "store.health": true,
};

/** The closed {@link M3LTelemetryGranularity} vocabulary as a key table. */
const TELEMETRY_GRANULARITIES: Readonly<Record<M3LTelemetryGranularity, true>> =
  {
    minute: true,
    hour: true,
    day: true,
  };

/** Narrows a raw `metric` column to {@link M3LTelemetryMetric}, throwing a typed error on unrecognized values. */
function toTelemetryMetric(value: TelemetryColumnValue): M3LTelemetryMetric {
  const raw = toRequiredString(value);
  if (Object.hasOwn(TELEMETRY_METRICS, raw)) {
    return raw as M3LTelemetryMetric;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_telemetry_rollup row has an unrecognized metric value",
  );
}

/** Narrows a raw `granularity` column to {@link M3LTelemetryGranularity}. */
function toTelemetryGranularity(
  value: TelemetryColumnValue,
): M3LTelemetryGranularity {
  const raw = toRequiredString(value);
  if (Object.hasOwn(TELEMETRY_GRANULARITIES, raw)) {
    return raw as M3LTelemetryGranularity;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_telemetry_rollup row has an unrecognized granularity value",
  );
}

/** Projects one raw `console_telemetry_rollup` row into a {@link M3LTelemetryBucket}. */
function toTelemetryBucket(row: M3LStoreRow): M3LTelemetryBucket {
  return {
    granularity: toTelemetryGranularity(row["granularity"]),
    bucketStartMs: toRequiredNumber(row["bucket_start_ms"]),
    metric: toTelemetryMetric(row["metric"]),
    route: toRequiredString(row["route"]),
    script: toRequiredString(row["script"]),
    operation: toRequiredString(row["operation"]),
    outcome: toRequiredString(row["outcome"]),
    posture: toRequiredString(row["posture"]),
    sampleCount: toRequiredNumber(row["sample_count"]),
    sumValue: toOptionalNumber(row["sum_value"]),
    minValue: toOptionalNumber(row["min_value"]),
    maxValue: toOptionalNumber(row["max_value"]),
  };
}

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `bucketStartMs` is a non-negative
 * safe integer. A `STRICT INTEGER` column rejects floats at the SQLite level
 * with a store-level error — the wrong classification for a caller fault, so
 * this is checked before binding.
 */
function requireValidBucketStartMs(bucketStartMs: number): number {
  if (!Number.isSafeInteger(bucketStartMs) || bucketStartMs < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "bucketStartMs must be a non-negative safe integer",
    );
  }
  return bucketStartMs;
}

/** The millisecond width of each granularity bucket. */
const GRANULARITY_MS: Readonly<Record<M3LTelemetryGranularity, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `bucketStartMs` is aligned to
 * the given granularity. The alignment `CHECK` in the DDL would surface the
 * violation as a store error — the wrong classification.
 */
function requireAligned(
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): void {
  const width = GRANULARITY_MS[granularity];
  if (bucketStartMs % width !== 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `bucketStartMs ${bucketStartMs.toString()} is not aligned to ${granularity} granularity (${width.toString()} ms)`,
    );
  }
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a non-negative safe
 * integer — used for `valueMs` and `valueBytes`.
 */
function requireValidMeasure(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a non-empty,
 * non-whitespace-only string — used for required dimensions.
 */
function requireNonEmptyDimension(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must not be empty or whitespace-only`,
    );
  }
  return value;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `limit` is a non-negative integer.
 * SQLite treats a negative `LIMIT` as unbounded, so an unvalidated value
 * would silently contradict this query's "no unbounded default" guarantee.
 */
function requireValidLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "list query limit must be a non-negative integer",
    );
  }
  return limit;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a safe integer — for `fromMs`/`toMs`. */
function requireValidRangeBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be a safe integer`,
    );
  }
  return value;
}

/** Validates every constrained field of `query`. */
function requireValidQuery(query: M3LTelemetryQuery): M3LTelemetryQuery {
  requireValidLimit(query.limit);
  if (query.fromMs !== undefined)
    requireValidRangeBound(query.fromMs, "fromMs");
  if (query.toMs !== undefined) requireValidRangeBound(query.toMs, "toMs");
  if (
    query.fromMs !== undefined &&
    query.toMs !== undefined &&
    query.fromMs > query.toMs
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "fromMs must not be greater than toMs",
    );
  }
  return query;
}

// ---------------------------------------------------------------------------
// Operation wrapper
// ---------------------------------------------------------------------------

/**
 * Runs `operation`, classifying any thrown value into a
 * {@link M3LConsoleError}. An already-typed `M3LConsoleError` is re-thrown
 * unchanged rather than double-wrapped.
 */
function runTelemetryOperation<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(classifyStoreFailure(cause), "query", message, cause);
  }
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

/** Validates the common fields of any measurement variant. */
function requireValidMeasurementBase(measurement: M3LTelemetryMeasurement): {
  bucketStartMs: number;
} {
  const bucketStartMs = requireValidBucketStartMs(measurement.bucketStartMs);
  requireAligned(bucketStartMs, measurement.granularity);
  return { bucketStartMs };
}

/** Upserts a measure-bearing measurement. */
function upsertWithValue(
  executor: M3LStoreQueryExecutor,
  measurement: M3LTelemetryMeasurement,
  route: string,
  script: string,
  operation: string,
  outcome: string,
  posture: string,
  value: number,
): void {
  const { bucketStartMs } = requireValidMeasurementBase(measurement);
  executor.run(SQL_UPSERT_WITH_VALUE, [
    measurement.granularity,
    bucketStartMs,
    measurement.metric,
    route,
    script,
    operation,
    outcome,
    posture,
    value,
    value,
    value,
  ]);
}

/** Upserts a pure counter measurement. */
function upsertCounter(
  executor: M3LStoreQueryExecutor,
  measurement: M3LTelemetryMeasurement,
  route: string,
  script: string,
  operation: string,
  outcome: string,
  posture: string,
): void {
  const { bucketStartMs } = requireValidMeasurementBase(measurement);
  executor.run(SQL_UPSERT_COUNTER, [
    measurement.granularity,
    bucketStartMs,
    measurement.metric,
    route,
    script,
    operation,
    outcome,
    posture,
  ]);
}

/** Records one `http.request` measurement. */
function recordHttpRequest(
  executor: M3LStoreQueryExecutor,
  measurement: Extract<M3LTelemetryMeasurement, { metric: "http.request" }>,
): void {
  const route = requireNonEmptyDimension(measurement.route, "route");
  const value = requireValidMeasure(measurement.valueMs, "valueMs");
  upsertWithValue(
    executor,
    measurement,
    route,
    "",
    "",
    measurement.outcome,
    "",
    value,
  );
}

/** Records one `run.finished` measurement. */
function recordRunFinished(
  executor: M3LStoreQueryExecutor,
  measurement: Extract<M3LTelemetryMeasurement, { metric: "run.finished" }>,
): void {
  const script = requireNonEmptyDimension(measurement.script, "script");
  const value = requireValidMeasure(measurement.valueMs, "valueMs");
  upsertWithValue(
    executor,
    measurement,
    "",
    script,
    measurement.operation ?? "",
    measurement.outcome,
    "",
    value,
  );
}

/** Records one `policy.decision` measurement. */
function recordPolicyDecision(
  executor: M3LStoreQueryExecutor,
  measurement: Extract<M3LTelemetryMeasurement, { metric: "policy.decision" }>,
): void {
  const posture = requireNonEmptyDimension(measurement.posture, "posture");
  upsertCounter(
    executor,
    measurement,
    "",
    "",
    "",
    measurement.outcome ?? "",
    posture,
  );
}

/** Routes a measurement to the correct upsert statement based on `metric`. */
function recordMeasurement(
  executor: M3LStoreQueryExecutor,
  measurement: M3LTelemetryMeasurement,
): void {
  switch (measurement.metric) {
    case "http.request":
      recordHttpRequest(executor, measurement);
      return;
    case "run.finished":
      recordRunFinished(executor, measurement);
      return;
    case "store.health": {
      const value = requireValidMeasure(measurement.valueBytes, "valueBytes");
      upsertWithValue(executor, measurement, "", "", "", "", "", value);
      return;
    }
    case "sse.stream":
      upsertCounter(
        executor,
        measurement,
        "",
        "",
        "",
        measurement.outcome ?? "",
        "",
      );
      return;
    case "policy.decision":
      recordPolicyDecision(executor, measurement);
      return;
    default: {
      const _exhaustive: never = measurement;
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        `unhandled metric: ${String((_exhaustive as { metric: unknown }).metric)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// List helper — parameterized filter builder
// ---------------------------------------------------------------------------

/** Builds the optional WHERE fragment and parameters for `list`'s filters (beyond `granularity = ?`). */
function buildTelemetryListFilter(query: M3LTelemetryQuery): {
  readonly clause: string;
  readonly parameters: readonly (string | number)[];
} {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (query.metric !== undefined) {
    clauses.push("metric = ?");
    parameters.push(query.metric);
  }
  if (query.fromMs !== undefined) {
    clauses.push("bucket_start_ms >= ?");
    parameters.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    clauses.push("bucket_start_ms <= ?");
    parameters.push(query.toMs);
  }
  const clause = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  return { clause, parameters };
}

// ---------------------------------------------------------------------------
// Pure helper — exported
// ---------------------------------------------------------------------------

/**
 * Floors `atMs` to the UTC-aligned bucket boundary for `granularity`.
 *
 * Bucket widths: `'minute'` → 60,000 ms, `'hour'` → 3,600,000 ms,
 * `'day'` → 86,400,000 ms. The day boundary aligns to UTC midnight because
 * 86,400,000 divides the Unix epoch (1970-01-01 00:00:00 UTC) exactly.
 *
 * Use this before calling {@link createConsoleTelemetryRepository}'s `record`
 * method whenever you have an arbitrary timestamp — the `bucket_start_ms`
 * alignment `CHECK` in `console_telemetry_rollup` rejects misaligned values
 * and `record` would throw `ERR_CONSOLE_BAD_REQUEST`.
 *
 * @param atMs - An epoch-millisecond timestamp.
 * @param granularity - The target granularity.
 * @returns The UTC-aligned bucket start, in epoch milliseconds.
 *
 * @example
 * ```ts
 * import { telemetryBucketStartMs } from "@m3l-automation/m3l-console-server/store/telemetry-repository";
 *
 * // 75,000 ms is 1:15 into epoch; the minute bucket starts at 60,000 ms.
 * telemetryBucketStartMs(75_000, "minute"); // → 60_000
 * ```
 */
export function telemetryBucketStartMs(
  atMs: number,
  granularity: M3LTelemetryGranularity,
): number {
  const width = GRANULARITY_MS[granularity];
  return Math.floor(atMs / width) * width;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a {@link M3LConsoleTelemetryRepository} over `executor`.
 *
 * @param executor - The {@link M3LStoreQueryExecutor} port this repository
 * reads and writes through — the top-level store's own executor, or a
 * transaction's, closed over rather than held as a class field.
 * @returns The {@link M3LConsoleTelemetryRepository}.
 *
 * @example
 * ```ts
 * import { createConsoleTelemetryRepository } from "@m3l-automation/m3l-console-server/store/telemetry-repository";
 * import { telemetryBucketStartMs } from "@m3l-automation/m3l-console-server/store/telemetry-repository";
 *
 * const repository = createConsoleTelemetryRepository(executor);
 * const bucket = telemetryBucketStartMs(Date.now(), "minute");
 * repository.record({
 *   metric: "http.request",
 *   granularity: "minute",
 *   bucketStartMs: bucket,
 *   route: "/api/v1/runs",
 *   outcome: "2xx",
 *   valueMs: 42,
 * });
 * ```
 */
export function createConsoleTelemetryRepository(
  executor: M3LStoreQueryExecutor,
): M3LConsoleTelemetryRepository {
  return {
    record(measurement: M3LTelemetryMeasurement): void {
      runTelemetryOperation(
        () => recordMeasurement(executor, measurement),
        "console telemetry repository record failed",
      );
    },
    recordAll(measurements: readonly M3LTelemetryMeasurement[]): number {
      return runTelemetryOperation(() => {
        let count = 0;
        for (const measurement of measurements) {
          recordMeasurement(executor, measurement);
          count += 1;
        }
        return count;
      }, "console telemetry repository recordAll failed");
    },
    list(query: M3LTelemetryQuery): readonly M3LTelemetryBucket[] {
      return runTelemetryOperation(() => {
        const validated = requireValidQuery(query);
        const { clause, parameters } = buildTelemetryListFilter(validated);
        const sql = `${SQL_LIST_BASE}${clause}${SQL_LIST_ORDER} LIMIT ?`;
        const rows = executor.all(sql, [
          validated.granularity,
          ...parameters,
          validated.limit,
        ]);
        return rows.map((row) => toTelemetryBucket(row));
      }, "console telemetry repository list failed");
    },
    count(): number {
      return runTelemetryOperation(() => {
        const row = executor.get(SQL_COUNT);
        return row === undefined ? 0 : toRequiredNumber(row["count"]);
      }, "console telemetry repository count failed");
    },
    prune(request: M3LTelemetryPruneRequest): number {
      return runTelemetryOperation(() => {
        const result = executor.run(SQL_PRUNE, [
          request.granularity,
          request.beforeMs,
        ]);
        return result.changes;
      }, "console telemetry repository prune failed");
    },
  };
}
