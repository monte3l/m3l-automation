/**
 * `store/telemetry-validation` — vocabulary tables, row-narrowing helpers,
 * and validation guards for `console_telemetry_rollup`. Split from
 * `store/telemetry-repository.ts` purely for the ADR-0072 25,000-byte
 * per-file ceiling — same rationale as `store/audit-repository-types.ts`
 * beside `store/audit-repository.ts`, whose header states the byte-budget
 * reason in its own TSDoc.
 *
 * **These guards are the cast-boundary defence.** The telemetry recorder in a
 * later slice reaches the repository through a type cast, and "the type
 * prevents it" is not sufficient — see `store/audit-repository.ts`'s own
 * `@packageDocumentation` for the governing principle. Do NOT fold this back
 * into `telemetry-repository.ts`: slices 2-5 each add new metric classes to
 * these same guards, and the file will fill again quickly.
 *
 * **`src/store/**` sits in the `store` eslint zone, asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs`** — so this file
 * cannot import from `src/audit/` or other zones.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import type {
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMeasurement,
  M3LTelemetryMetric,
  M3LTelemetryQuery,
} from "./telemetry-repository-types.js";
import type { M3LStoreOutputValue, M3LStoreRow } from "./types.js";

// ---------------------------------------------------------------------------
// Column narrowing helpers
// ---------------------------------------------------------------------------

/** Raw column value including the TS-only `undefined` from `noUncheckedIndexedAccess`. */
export type TelemetryColumnValue = M3LStoreOutputValue | undefined;

/** Throws when a `NOT NULL` column reads back as SQL `NULL` or TS `undefined`. */
export function requireColumn(
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
export function toRequiredNumber(value: TelemetryColumnValue): number {
  return Number(requireColumn(value));
}

/** Narrows to a required string. */
export function toRequiredString(value: TelemetryColumnValue): string {
  return String(requireColumn(value));
}

/** Narrows to an optional number: SQL `NULL` → `undefined`. */
export function toOptionalNumber(
  value: TelemetryColumnValue,
): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

// ---------------------------------------------------------------------------
// Vocabulary tables
// ---------------------------------------------------------------------------

/** The closed {@link M3LTelemetryMetric} vocabulary as a key table for `Object.hasOwn`. */
export const TELEMETRY_METRICS: Readonly<Record<M3LTelemetryMetric, true>> = {
  "http.request": true,
  "run.finished": true,
  "sse.stream": true,
  "policy.decision": true,
  "store.health": true,
};

/** The closed {@link M3LTelemetryGranularity} vocabulary as a key table. */
export const TELEMETRY_GRANULARITIES: Readonly<
  Record<M3LTelemetryGranularity, true>
> = {
  minute: true,
  hour: true,
  day: true,
};

/** The millisecond width of each granularity bucket. */
export const GRANULARITY_MS: Readonly<Record<M3LTelemetryGranularity, number>> =
  {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
  };

// ---------------------------------------------------------------------------
// Row-narrowing projectors
// ---------------------------------------------------------------------------

/** Narrows a raw `metric` column to {@link M3LTelemetryMetric}, throwing a typed error on unrecognized values. */
export function toTelemetryMetric(
  value: TelemetryColumnValue,
): M3LTelemetryMetric {
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
export function toTelemetryGranularity(
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
export function toTelemetryBucket(row: M3LStoreRow): M3LTelemetryBucket {
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
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `granularity` is a member of the
 * closed {@link M3LTelemetryGranularity} vocabulary. Guards every code path
 * that reaches `GRANULARITY_MS[granularity]`: without this check a
 * cast-bypassed caller can make `width` be `undefined`, turning
 * `bucketStartMs % undefined` into `NaN` and `width.toString()` into a raw
 * `TypeError` that `runTelemetryOperation` would misclassify as a store
 * failure rather than a bad request.
 */
export function requireValidGranularity(
  granularity: M3LTelemetryGranularity,
): M3LTelemetryGranularity {
  if (!Object.hasOwn(TELEMETRY_GRANULARITIES, granularity)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `granularity must be one of: ${Object.keys(TELEMETRY_GRANULARITIES).join(", ")}`,
    );
  }
  return granularity;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `metric` is a member of the closed
 * {@link M3LTelemetryMetric} vocabulary. A typo'd metric in a query would
 * otherwise yield `WHERE metric = 'garbage'` → `[]`, a silent wrong-shaped
 * empty result instead of a typed bad-request error.
 */
export function requireValidMetric(
  metric: M3LTelemetryMetric,
): M3LTelemetryMetric {
  if (!Object.hasOwn(TELEMETRY_METRICS, metric)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `metric must be one of: ${Object.keys(TELEMETRY_METRICS).join(", ")}`,
    );
  }
  return metric;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `bucketStartMs` is a non-negative
 * safe integer. A `STRICT INTEGER` column rejects floats at the SQLite level
 * with a store-level error — the wrong classification for a caller fault, so
 * this is checked before binding.
 */
export function requireValidBucketStartMs(bucketStartMs: number): number {
  if (!Number.isSafeInteger(bucketStartMs) || bucketStartMs < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "bucketStartMs must be a non-negative safe integer",
    );
  }
  return bucketStartMs;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `bucketStartMs` is aligned to
 * the given granularity. The alignment `CHECK` in the DDL would surface the
 * violation as a store error — the wrong classification.
 */
export function requireAligned(
  bucketStartMs: number,
  granularity: M3LTelemetryGranularity,
): void {
  requireValidGranularity(granularity);
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
export function requireValidMeasure(value: number, label: string): number {
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
export function requireNonEmptyDimension(value: string, label: string): string {
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
export function requireValidLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "list query limit must be a non-negative integer",
    );
  }
  return limit;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a safe integer — for `fromMs`/`toMs`. */
export function requireValidRangeBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be a safe integer`,
    );
  }
  return value;
}

/** Validates every constrained field of `query`. */
export function requireValidQuery(query: M3LTelemetryQuery): M3LTelemetryQuery {
  requireValidGranularity(query.granularity);
  if (query.metric !== undefined) requireValidMetric(query.metric);
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

/** Validates the common fields of any measurement variant. */
export function requireValidMeasurementBase(
  measurement: M3LTelemetryMeasurement,
): { bucketStartMs: number } {
  const bucketStartMs = requireValidBucketStartMs(measurement.bucketStartMs);
  requireAligned(bucketStartMs, measurement.granularity);
  return { bucketStartMs };
}
