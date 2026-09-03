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
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `atMs` is a finite, non-negative
 * number no greater than `Number.MAX_SAFE_INTEGER`. Fractional values are
 * accepted — only the resulting *bucket* must be an integer, not the input
 * timestamp.
 *
 * **Why this guard exists:** `Math.floor(NaN / 60_000) * 60_000` returns
 * `NaN`, and a negative `atMs` yields a pre-epoch bucket. Without this guard,
 * both conditions surfaced downstream as an error naming `bucketStartMs` —
 * a parameter the caller never passed, making the root cause invisible.
 *
 * **Why `Number.MAX_SAFE_INTEGER` is the upper bound:** `telemetryBucketStartMs`
 * floors `atMs` down to a multiple of the granularity width. Flooring is
 * monotone-decreasing, so a valid `atMs ≤ MAX_SAFE_INTEGER` can never produce
 * a bucket outside the safe-integer range. No separate output check is needed.
 */
export function requireValidAtMs(atMs: number): number {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > Number.MAX_SAFE_INTEGER) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "atMs must be a finite, non-negative number no greater than Number.MAX_SAFE_INTEGER",
    );
  }
  return atMs;
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
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is non-empty after
 * trimming, then returns the **trimmed** value — used for required dimensions.
 *
 * **Why trim on return:** the untrimmed form allowed `" /api/v1/runs"` and
 * `"/api/v1/runs"` to both pass the guard and land as two distinct primary-key
 * rows in `console_telemetry_rollup`, silently splitting one rollup bucket in
 * two. Returning `value.trim()` collapses those duplicates at the write
 * boundary before any SQL statement sees them.
 *
 * **Decided boundary:** only outer (leading/trailing) whitespace is stripped.
 * Internal whitespace is significant and is preserved — `"/api/v1/ runs"` is
 * a distinct route from `"/api/v1/runs"` and must remain so. A test pins this
 * invariant to prevent accidental tightening.
 */
export function requireNonEmptyDimension(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must not be empty or whitespace-only`,
    );
  }
  return trimmed;
}

/**
 * Normalizes an optional rollup dimension — **normalize, never throw**.
 *
 * - `undefined` → `""` (the DDL's "not applicable" sentinel; the column is
 *   `NOT NULL`, so `undefined` must become a concrete empty string).
 * - Otherwise `value.trim()`, so `""` → `""` and `"   "` → `""`.
 * - Internal whitespace is preserved — only outer (leading/trailing) whitespace
 *   is stripped, identical to {@link requireNonEmptyDimension}'s trimming rule.
 *
 * **Why this is a separate helper from `requireNonEmptyDimension`:** on the
 * optional arms (`operation`, `outcome` for `sse.stream` / `policy.decision`)
 * both `undefined` and `""` are legal and both mean "not applicable", so
 * rejecting an empty value here would make an explicit `""` throw while an
 * omitted field succeeds — an incoherent surface for the same resulting row.
 *
 * **Why it must trim at all:** `operation` and `outcome` are PRIMARY KEY
 * members of `console_telemetry_rollup`. Without trimming, `"export"` and
 * `" export "` land as two distinct PK rows, silently splitting one rollup
 * bucket in two with no error — the same invariant that motivated trimming for
 * required dimensions.
 *
 * @example
 * ```ts
 * import { normalizeOptionalDimension } from "@m3l-automation/m3l-console-server/store/telemetry-validation";
 *
 * normalizeOptionalDimension(undefined);    // ""
 * normalizeOptionalDimension("");           // ""
 * normalizeOptionalDimension("  export "); // "export"
 * normalizeOptionalDimension("a  b");      // "a  b"  — internal space preserved
 * ```
 */
export function normalizeOptionalDimension(value: string | undefined): string {
  return value === undefined ? "" : value.trim();
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
