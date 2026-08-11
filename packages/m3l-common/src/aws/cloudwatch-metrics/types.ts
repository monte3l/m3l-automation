/**
 * `aws/cloudwatch-metrics/types` — plain, library-owned types at the
 * CloudWatch metrics-operations boundary. None of these carry an
 * `@aws-sdk/client-cloudwatch` type; every {@link M3LCloudWatchMetricsOperations}
 * method translates SDK request/response shapes into these before returning.
 * See `docs/reference/aws/cloudwatch-metrics.md` for the full contract.
 *
 * @packageDocumentation
 */

/**
 * A single CloudWatch metric dimension: a name/value pair scoping a metric.
 *
 * Duplicated locally rather than imported from `aws/cloudwatch-alarms` —
 * every submodule's `types.ts` in this library is self-contained with zero
 * cross-submodule imports.
 */
export interface M3LCloudWatchDimension {
  /** The dimension's name (e.g. `"InstanceId"`). */
  readonly name: string;
  /** The dimension's value (e.g. `"i-0123456789abcdef0"`). */
  readonly value: string;
}

/** A CloudWatch metric's unit of measurement. */
export type M3LCloudWatchStandardUnit =
  | "Seconds"
  | "Microseconds"
  | "Milliseconds"
  | "Bytes"
  | "Kilobytes"
  | "Megabytes"
  | "Gigabytes"
  | "Terabytes"
  | "Bits"
  | "Kilobits"
  | "Megabits"
  | "Gigabits"
  | "Terabits"
  | "Percent"
  | "Count"
  | "Bytes/Second"
  | "Kilobytes/Second"
  | "Megabytes/Second"
  | "Gigabytes/Second"
  | "Terabytes/Second"
  | "Bits/Second"
  | "Kilobits/Second"
  | "Megabits/Second"
  | "Gigabits/Second"
  | "Terabits/Second"
  | "Count/Second"
  | "None";

/** A statistic computable over a metric's datapoints. */
export type M3LCloudWatchMetricStatistic =
  "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum";

/** A pre-aggregated set of statistics for a single metric datum. */
export interface M3LCloudWatchStatisticSet {
  /** The number of samples used for the statistic set. */
  readonly sampleCount: number;
  /** The sum of the values of the samples used for the statistic set. */
  readonly sum: number;
  /** The minimum value of the samples used for the statistic set. */
  readonly minimum: number;
  /** The maximum value of the samples used for the statistic set. */
  readonly maximum: number;
}

/**
 * A single metric datum published via
 * {@link M3LCloudWatchMetricsOperations.putMetricData}. Exactly one of
 * `value`/`statisticValues` is typically supplied (a single sample vs. a
 * pre-aggregated statistic set) — CloudWatch itself, not this type, enforces
 * that constraint.
 */
export interface M3LCloudWatchMetricDatum {
  /** The name of the metric. */
  readonly metricName: string;
  /** The single value for this datum, when not publishing a pre-aggregated statistic set. */
  readonly value?: number;
  /** The dimensions scoping this datum, when the metric is dimensioned. */
  readonly dimensions?: readonly M3LCloudWatchDimension[];
  /** The time the datum was recorded. Defaults to the current time on the CloudWatch side when omitted. */
  readonly timestamp?: Date;
  /** The unit of measurement for this datum. */
  readonly unit?: M3LCloudWatchStandardUnit;
  /** A pre-aggregated statistic set, when not publishing a single `value`. */
  readonly statisticValues?: M3LCloudWatchStatisticSet;
}

/** Input for {@link M3LCloudWatchMetricsOperations.putMetricData}. */
export interface M3LPutMetricDataInput {
  /** The namespace the metric data belongs to. */
  readonly namespace: string;
  /** The metric data to publish. Must contain between 1 and 1000 entries. */
  readonly metricData: readonly M3LCloudWatchMetricDatum[];
}

/** Input for {@link M3LCloudWatchMetricsOperations.getMetricStatistics}. */
export interface M3LGetMetricStatisticsInput {
  /** The namespace the metric belongs to. */
  readonly namespace: string;
  /** The name of the metric to query statistics for. */
  readonly metricName: string;
  /** The start of the time range to query, inclusive. */
  readonly startTime: Date;
  /** The end of the time range to query, exclusive. */
  readonly endTime: Date;
  /** The granularity, in seconds, of the returned datapoints. */
  readonly period: number;
  /** The statistics to compute for each datapoint. */
  readonly statistics: readonly M3LCloudWatchMetricStatistic[];
  /** The dimensions scoping the metric, when the metric is dimensioned. */
  readonly dimensions?: readonly M3LCloudWatchDimension[];
  /** Restricts the returned datapoints to this unit of measurement. */
  readonly unit?: M3LCloudWatchStandardUnit;
}

/** A single computed datapoint returned by {@link M3LCloudWatchMetricsOperations.getMetricStatistics}. */
export interface M3LCloudWatchDatapoint {
  /** The time this datapoint's aggregation window starts. */
  readonly timestamp?: Date;
  /** The number of samples used for this datapoint. */
  readonly sampleCount?: number;
  /** The average of the samples used for this datapoint. */
  readonly average?: number;
  /** The sum of the samples used for this datapoint. */
  readonly sum?: number;
  /** The minimum value of the samples used for this datapoint. */
  readonly minimum?: number;
  /** The maximum value of the samples used for this datapoint. */
  readonly maximum?: number;
  /** The unit of measurement for this datapoint. */
  readonly unit?: M3LCloudWatchStandardUnit;
}

/** The result of {@link M3LCloudWatchMetricsOperations.getMetricStatistics}. */
export interface M3LGetMetricStatisticsResult {
  /** A human-readable label for the queried metric. */
  readonly label?: string;
  /** The computed datapoints, one per period in the queried time range. */
  readonly datapoints: readonly M3LCloudWatchDatapoint[];
}
