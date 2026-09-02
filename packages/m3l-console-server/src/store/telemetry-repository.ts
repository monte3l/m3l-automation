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
  M3LTelemetryPruneRequest,
  M3LTelemetryQuery,
} from "./telemetry-repository-types.js";
import {
  GRANULARITY_MS,
  requireNonEmptyDimension,
  requireValidGranularity,
  requireValidMeasure,
  requireValidMeasurementBase,
  requireValidQuery,
  requireValidRangeBound,
  toRequiredNumber,
  toTelemetryBucket,
} from "./telemetry-validation.js";
import type { M3LStoreQueryExecutor } from "./types.js";

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
  const outcome = requireNonEmptyDimension(measurement.outcome, "outcome");
  const value = requireValidMeasure(measurement.valueMs, "valueMs");
  upsertWithValue(executor, measurement, route, "", "", outcome, "", value);
}

/** Records one `run.finished` measurement. */
function recordRunFinished(
  executor: M3LStoreQueryExecutor,
  measurement: Extract<M3LTelemetryMeasurement, { metric: "run.finished" }>,
): void {
  const script = requireNonEmptyDimension(measurement.script, "script");
  const outcome = requireNonEmptyDimension(measurement.outcome, "outcome");
  const value = requireValidMeasure(measurement.valueMs, "valueMs");
  upsertWithValue(
    executor,
    measurement,
    "",
    script,
    measurement.operation ?? "",
    outcome,
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
// recordAll helpers
// ---------------------------------------------------------------------------

/**
 * Re-throws a mid-`recordAll` failure with how many measurements were
 * successfully recorded before it attached to `context` — `recordAll` opens
 * no transaction of its own (see this module's own `@packageDocumentation`),
 * so a failure partway through leaves the already-upserted rows persisted, and
 * without this a caller debugging that gets only "it failed" with no way to
 * learn how far the batch got. Preserves an already-typed `M3LConsoleError`'s
 * own `code`/`message`/`cause` (e.g. a guard's `ERR_CONSOLE_BAD_REQUEST`)
 * rather than reclassifying it; anything else is classified first via
 * {@link classifyStoreFailure}/{@link storeError}.
 */
function attachRecordedCount(cause: unknown, recordedCount: number): never {
  const classified =
    cause instanceof M3LConsoleError
      ? cause
      : storeError(
          classifyStoreFailure(cause),
          "query",
          "console telemetry repository recordAll failed",
          cause,
        );
  throw new M3LConsoleError(classified.code, classified.message, {
    cause: classified.cause,
    context: { ...classified.context, recordedCount },
  });
}

/** Upserts every measurement in `measurements`, in order; see this module's `@packageDocumentation` for why no transaction is opened here. */
function recordAllMeasurements(
  executor: M3LStoreQueryExecutor,
  measurements: readonly M3LTelemetryMeasurement[],
): number {
  let recordedCount = 0;
  for (const measurement of measurements) {
    try {
      recordMeasurement(executor, measurement);
    } catch (cause) {
      attachRecordedCount(cause, recordedCount);
    }
    recordedCount += 1;
  }
  return recordedCount;
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
  requireValidGranularity(granularity);
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
      return runTelemetryOperation(
        () => recordAllMeasurements(executor, measurements),
        "console telemetry repository recordAll failed",
      );
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
        requireValidGranularity(request.granularity);
        requireValidRangeBound(request.beforeMs, "beforeMs");
        const result = executor.run(SQL_PRUNE, [
          request.granularity,
          request.beforeMs,
        ]);
        return result.changes;
      }, "console telemetry repository prune failed");
    },
  };
}
