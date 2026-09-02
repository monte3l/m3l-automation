/**
 * `store/telemetry-repository-types` — the public type surface of
 * `store/telemetry-repository.ts`, split into its own file purely because
 * `telemetry-repository.ts` would approach the 25,000-byte per-file budget
 * ceiling (ADR-0072). There is no design rationale beyond that: this is a
 * byte-budget split, not a layering decision — mirrors
 * `store/audit-repository-types.ts`'s own split off
 * `store/audit-repository.ts` — and `telemetry-repository.ts` re-exports
 * every symbol declared here, so no consumer needs to know the split exists.
 *
 * **`src/store/**` sits in the `store` eslint zone, asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs`** — so this file
 * cannot import from `src/audit/` or other zones.
 *
 * @packageDocumentation
 */

/**
 * The three supported rollup granularities for `console_telemetry_rollup`.
 * Maps to the `granularity` column's `CHECK (granularity IN ('minute','hour','day'))`.
 */
export type M3LTelemetryGranularity = "minute" | "hour" | "day";

/**
 * The five supported telemetry metrics for `console_telemetry_rollup`.
 * Maps to the `metric` column's `CHECK` constraint.
 *
 * - `http.request` — inbound HTTP request latency (milliseconds); requires a non-empty `route`.
 * - `run.finished` — script run completion time (milliseconds); requires a non-empty `script`.
 * - `sse.stream` — SSE stream lifecycle events; a pure counter, no measure.
 * - `policy.decision` — policy enforcement decisions; requires a non-empty `posture`, pure counter.
 * - `store.health` — store size snapshots (bytes); no `outcome` (the DDL forbids it).
 */
export type M3LTelemetryMetric =
  | "http.request"
  | "run.finished"
  | "sse.stream"
  | "policy.decision"
  | "store.health";

/**
 * The fields common to every {@link M3LTelemetryMeasurement} variant,
 * regardless of `metric`. Factored out so the discriminated union only spells
 * out the metric-specific fields.
 */
interface M3LTelemetryMeasurementCommon {
  /** Which rollup granularity this measurement belongs to. */
  readonly granularity: M3LTelemetryGranularity;
  /**
   * The UTC-aligned bucket start, in epoch milliseconds. Must be a
   * non-negative safe integer, aligned to the granularity boundary
   * (60,000 / 3,600,000 / 86,400,000 ms). Use {@link telemetryBucketStartMs}
   * to floor an arbitrary timestamp to its bucket.
   */
  readonly bucketStartMs: number;
}

/**
 * The write shape for one telemetry measurement — a discriminated union on
 * `metric`. Each arm carries `?: undefined` for every dimension it must not
 * supply, so an illegal pairing is rejected structurally: under
 * `exactOptionalPropertyTypes`, `readonly route?: undefined` rejects a
 * caller-supplied `route` string whether the value arrives as a fresh literal
 * or through a variable. The database's own `CHECK` constraints enforce the
 * same pairing as a backstop.
 *
 * **Dimension normalization:** required dimensions (`route`, `script`,
 * `outcome`, `posture`) are trimmed of outer whitespace before they become
 * part of the rollup row's primary key, so values that differ only in leading
 * or trailing whitespace merge into the same bucket. Internal whitespace is
 * significant and is preserved.
 *
 * - `"http.request"` — requires `route` (non-empty) and `valueMs`; `outcome` is any non-empty string.
 * - `"run.finished"` — requires `script` (non-empty) and `valueMs`; `operation` is optional; `outcome` is any non-empty string.
 * - `"sse.stream"` — pure counter; no measure. `outcome` is optional.
 * - `"policy.decision"` — pure counter; requires `posture` (non-empty). `outcome` is optional.
 * - `"store.health"` — requires `valueBytes`; carries no `outcome` (the DDL forbids it for this metric).
 *
 * @example
 * ```ts
 * import { createConsoleTelemetryRepository } from "@m3l-automation/m3l-console-server/store/telemetry-repository";
 *
 * const measurement: M3LTelemetryMeasurement = {
 *   metric: "http.request",
 *   granularity: "minute",
 *   bucketStartMs: 60_000,
 *   route: "/api/v1/runs",
 *   outcome: "2xx",
 *   valueMs: 120,
 * };
 * ```
 */
export type M3LTelemetryMeasurement =
  | (M3LTelemetryMeasurementCommon & {
      readonly metric: "http.request";
      /** The HTTP route — must be non-empty. */
      readonly route: string;
      /** The HTTP outcome string (e.g. `'2xx'`, `'4xx'`, `'5xx'`). Must be non-empty. */
      readonly outcome: string;
      /** Latency in milliseconds. Must be a non-negative safe integer. */
      readonly valueMs: number;
      /** Not applicable to `http.request` — must be omitted or `undefined`. */
      readonly script?: undefined;
      /** Not applicable to `http.request` — must be omitted or `undefined`. */
      readonly operation?: undefined;
      /** Not applicable to `http.request` — must be omitted or `undefined`. */
      readonly posture?: undefined;
      /** Not applicable to `http.request` — must be omitted or `undefined`. */
      readonly valueBytes?: undefined;
    })
  | (M3LTelemetryMeasurementCommon & {
      readonly metric: "run.finished";
      /** The script identifier — must be non-empty. */
      readonly script: string;
      /** The operation name within the script — optional. */
      readonly operation?: string | undefined;
      /** The run outcome string (e.g. `'succeeded'`, `'failed'`). Must be non-empty. */
      readonly outcome: string;
      /** Run duration in milliseconds. Must be a non-negative safe integer. */
      readonly valueMs: number;
      /** Not applicable to `run.finished` — must be omitted or `undefined`. */
      readonly route?: undefined;
      /** Not applicable to `run.finished` — must be omitted or `undefined`. */
      readonly posture?: undefined;
      /** Not applicable to `run.finished` — must be omitted or `undefined`. */
      readonly valueBytes?: undefined;
    })
  | (M3LTelemetryMeasurementCommon & {
      readonly metric: "sse.stream";
      /** The stream outcome — optional. */
      readonly outcome?: string | undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly route?: undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly script?: undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly operation?: undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly posture?: undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly valueMs?: undefined;
      /** Not applicable to `sse.stream` — must be omitted or `undefined`. */
      readonly valueBytes?: undefined;
    })
  | (M3LTelemetryMeasurementCommon & {
      readonly metric: "policy.decision";
      /** The enforcement posture — must be non-empty. */
      readonly posture: string;
      /** The decision outcome — optional. */
      readonly outcome?: string | undefined;
      /** Not applicable to `policy.decision` — must be omitted or `undefined`. */
      readonly route?: undefined;
      /** Not applicable to `policy.decision` — must be omitted or `undefined`. */
      readonly script?: undefined;
      /** Not applicable to `policy.decision` — must be omitted or `undefined`. */
      readonly operation?: undefined;
      /** Not applicable to `policy.decision` — must be omitted or `undefined`. */
      readonly valueMs?: undefined;
      /** Not applicable to `policy.decision` — must be omitted or `undefined`. */
      readonly valueBytes?: undefined;
    })
  | (M3LTelemetryMeasurementCommon & {
      readonly metric: "store.health";
      /** Database size snapshot in bytes. Must be a non-negative safe integer. */
      readonly valueBytes: number;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly route?: undefined;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly script?: undefined;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly operation?: undefined;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly outcome?: undefined;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly posture?: undefined;
      /** Not applicable to `store.health` — must be omitted or `undefined`. */
      readonly valueMs?: undefined;
    });

/**
 * One `console_telemetry_rollup` row, projected into camelCase fields.
 *
 * **`''` sentinel:** every dimension column is `TEXT NOT NULL` with `''`
 * meaning "not applicable to this metric". This type surfaces `''` as-is —
 * never translated to `undefined` — so a round-trip is exact. Translating
 * `''` to `undefined` on the read path would silently corrupt rollup counts
 * (a subsequent `record()` call would insert a NEW row instead of merging).
 *
 * `sumValue` / `minValue` / `maxValue` are `undefined` for pure counter
 * metrics (`sse.stream`, `policy.decision`) and `number` for metrics that
 * carry a measure.
 *
 * @example
 * ```ts
 * function describeMetric(bucket: M3LTelemetryBucket): string {
 *   return `${bucket.metric} @ ${bucket.granularity} [${bucket.sampleCount} samples]`;
 * }
 * ```
 */
export interface M3LTelemetryBucket {
  /** The rollup granularity. */
  readonly granularity: M3LTelemetryGranularity;
  /** The UTC-aligned bucket start, in epoch milliseconds. */
  readonly bucketStartMs: number;
  /** The metric this bucket measures. */
  readonly metric: M3LTelemetryMetric;
  /** The HTTP route (`''` when not applicable). Surfaces the sentinel as-is. */
  readonly route: string;
  /** The script identifier (`''` when not applicable). Surfaces the sentinel as-is. */
  readonly script: string;
  /** The operation name (`''` when not applicable). Surfaces the sentinel as-is. */
  readonly operation: string;
  /** The outcome string (`''` when not applicable). Surfaces the sentinel as-is. */
  readonly outcome: string;
  /** The enforcement posture (`''` when not applicable). Surfaces the sentinel as-is. */
  readonly posture: string;
  /** The number of measurements merged into this bucket. Always ≥ 1. */
  readonly sampleCount: number;
  /** The sum of all merged values, or `undefined` for pure counters. */
  readonly sumValue: number | undefined;
  /** The minimum merged value, or `undefined` for pure counters. */
  readonly minValue: number | undefined;
  /** The maximum merged value, or `undefined` for pure counters. */
  readonly maxValue: number | undefined;
}

/**
 * Filters and a limit for {@link M3LConsoleTelemetryRepository.list}.
 * `granularity` and `limit` are required — mirroring `M3LHumanActionIndexQuery`
 * (`audit-repository-types.ts:181-191`). There is no unbounded default.
 *
 * @example
 * ```ts
 * const query: M3LTelemetryQuery = { granularity: "minute", limit: 100 };
 * ```
 */
export interface M3LTelemetryQuery {
  /** Restricts results to this granularity. Required. */
  readonly granularity: M3LTelemetryGranularity;
  /** Restricts results to this metric, when given. */
  readonly metric?: M3LTelemetryMetric | undefined;
  /** Inclusive lower bound on `bucket_start_ms`, when given. Must be a safe integer. */
  readonly fromMs?: number | undefined;
  /** Inclusive upper bound on `bucket_start_ms`, when given. Must be a safe integer, and not less than `fromMs`. */
  readonly toMs?: number | undefined;
  /** The maximum number of rows to return. Must be a non-negative integer. */
  readonly limit: number;
}

/**
 * Parameters for {@link M3LConsoleTelemetryRepository.prune}: deletes all
 * rollup buckets for `granularity` whose `bucket_start_ms` is strictly less
 * than `beforeMs`.
 *
 * @example
 * ```ts
 * const request: M3LTelemetryPruneRequest = {
 *   granularity: "minute",
 *   beforeMs: Date.now() - 24 * 60 * 60 * 1000,
 * };
 * ```
 */
export interface M3LTelemetryPruneRequest {
  /** The granularity tier to prune. */
  readonly granularity: M3LTelemetryGranularity;
  /** Delete all buckets whose `bucket_start_ms` is strictly less than this value. */
  readonly beforeMs: number;
}

/**
 * The console store's telemetry rollup repository: `console_telemetry_rollup`
 * upsert/query/prune (X8 slice 1).
 *
 * @example
 * ```ts
 * function isEmpty(repository: M3LConsoleTelemetryRepository): boolean {
 *   return repository.count() === 0;
 * }
 * ```
 */
export interface M3LConsoleTelemetryRepository {
  /**
   * Upserts one measurement into the rollup table. If a row already exists
   * for the same (granularity, bucket, metric, dimensions), increments
   * `sample_count` and updates `sum_value`, `min_value`, `max_value`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `bucketStartMs` is not a non-negative safe integer, when it is not
   *   aligned to the granularity, when a required dimension is empty or
   *   whitespace-only, or when `valueMs`/`valueBytes` is not a non-negative
   *   safe integer.
   */
  record(measurement: M3LTelemetryMeasurement): void;
  /**
   * Upserts every measurement in `measurements`, in order. Opens no
   * transaction of its own — see `telemetry-repository.ts`'s own
   * `@packageDocumentation` for why.
   *
   * @returns The number of measurements successfully processed.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` on
   *   the first measurement that fails validation; every measurement processed
   *   before it stays persisted. The thrown error's `context.recordedCount`
   *   holds the number of measurements that were successfully upserted before
   *   the failure — use this to diagnose how far the batch got.
   */
  recordAll(measurements: readonly M3LTelemetryMeasurement[]): number;
  /**
   * Lists rollup buckets matching `query`.
   *
   * Results are ordered most-recent-first (`bucket_start_ms` descending) —
   * with a `limit`, a monitoring page wants the latest N buckets, not the
   * oldest N. Ties within the same `bucket_start_ms` are broken by the
   * dimension columns in PK order (`metric`, `route`, `script`, `operation`,
   * `outcome`, `posture`), making the result fully deterministic: no two rows
   * in the same granularity tier share that combination.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `query.limit` is not a non-negative integer, when `query.fromMs`
   *   or `query.toMs` is given and is not a safe integer, or when both are
   *   given with `fromMs` greater than `toMs`.
   */
  list(query: M3LTelemetryQuery): readonly M3LTelemetryBucket[];
  /** Counts every row currently in `console_telemetry_rollup`. */
  count(): number;
  /**
   * Deletes all rollup buckets for `request.granularity` whose
   * `bucket_start_ms` is strictly less than `request.beforeMs`.
   *
   * @returns The number of rows deleted.
   */
  prune(request: M3LTelemetryPruneRequest): number;
}
