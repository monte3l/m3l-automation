/**
 * `aws/cloudwatch-alarms` — typed CloudWatch metric-alarms wrapper over the
 * raw `@aws-sdk/client-cloudwatch` `CloudWatchClient`, so callers never
 * import SDK command classes directly. See
 * `docs/reference/aws/cloudwatch-alarms.md`.
 *
 * @packageDocumentation
 */

export { M3LCloudWatchAlarmsOperations } from "./client.js";
export { M3LCloudWatchAlarmsOperationError } from "./error.js";
export type {
  M3LCloudWatchAlarm,
  M3LCloudWatchAlarmState,
  M3LCloudWatchComparisonOperator,
  M3LCloudWatchDescribeAlarmsOptions,
  M3LCloudWatchDescribeAlarmsResult,
  M3LCloudWatchDimension,
  M3LCloudWatchStatistic,
  M3LCloudWatchTreatMissingData,
  M3LPutMetricAlarmInput,
} from "./types.js";
