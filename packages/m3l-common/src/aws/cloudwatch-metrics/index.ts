/**
 * `aws/cloudwatch-metrics` — typed CloudWatch custom-metrics wrapper over
 * the raw `@aws-sdk/client-cloudwatch` `CloudWatchClient`, so callers never
 * import SDK command classes directly. See
 * `docs/reference/aws/cloudwatch-metrics.md`.
 *
 * @packageDocumentation
 */

export { M3LCloudWatchMetricsOperations } from "./client.js";
export { M3LCloudWatchMetricsOperationError } from "./error.js";
export type {
  M3LCloudWatchDatapoint,
  M3LCloudWatchDimension,
  M3LCloudWatchMetricDatum,
  M3LCloudWatchMetricStatistic,
  M3LCloudWatchStandardUnit,
  M3LCloudWatchStatisticSet,
  M3LGetMetricStatisticsInput,
  M3LGetMetricStatisticsResult,
  M3LPutMetricDataInput,
} from "./types.js";
