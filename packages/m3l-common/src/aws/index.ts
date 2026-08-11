/**
 * AWS namespace — credential management, SDK client provisioning, and typed
 * AWS operation wrappers.
 *
 * Public submodules (documented under `docs/reference/aws/`) are re-exported
 * here as they are implemented, in dependency order: `models`, `credentials`,
 * `clients`, `dynamodb`, `cloudwatch-logs-insights`, `sqs`, `signing`, `s3`,
 * `athena`, `eventbridge`, `lambda`, `ecs`, `cloudformation`, `codepipeline`,
 * `eks`, `cloudwatch-alarms`, `cloudwatch-metrics`.
 *
 * @packageDocumentation
 */

export * from "./models/index.js";
export * from "./credentials/index.js";
export * from "./clients/index.js";
export * from "./dynamodb/index.js";
export * from "./cloudwatch-logs-insights/index.js";
export * from "./sqs/index.js";
export * from "./signing/index.js";
export * from "./s3/index.js";
export * from "./athena/index.js";
export * from "./eventbridge/index.js";
export * from "./lambda/index.js";
export * from "./ecs/index.js";
export * from "./cloudformation/index.js";
export * from "./codepipeline/index.js";
export * from "./eks/index.js";
export {
  M3LCloudWatchAlarmsOperationError,
  M3LCloudWatchAlarmsOperations,
} from "./cloudwatch-alarms/index.js";
export type {
  M3LCloudWatchAlarm,
  M3LCloudWatchAlarmState,
  M3LCloudWatchComparisonOperator,
  M3LCloudWatchDescribeAlarmsOptions,
  M3LCloudWatchDescribeAlarmsResult,
  // `M3LCloudWatchDimension` is intentionally re-exported once, from this
  // module — `cloudwatch-alarms/types.ts` and `cloudwatch-metrics/types.ts`
  // each declare their own structurally-identical copy (per this library's
  // self-contained-submodule convention), which would otherwise collide as
  // an ambiguous barrel export.
  M3LCloudWatchDimension,
  M3LCloudWatchStatistic,
  M3LCloudWatchTreatMissingData,
  M3LPutMetricAlarmInput,
} from "./cloudwatch-alarms/index.js";
export {
  M3LCloudWatchMetricsOperationError,
  M3LCloudWatchMetricsOperations,
} from "./cloudwatch-metrics/index.js";
export type {
  M3LCloudWatchDatapoint,
  M3LCloudWatchMetricDatum,
  M3LCloudWatchMetricStatistic,
  M3LCloudWatchStandardUnit,
  M3LCloudWatchStatisticSet,
  M3LGetMetricStatisticsInput,
  M3LGetMetricStatisticsResult,
  M3LPutMetricDataInput,
} from "./cloudwatch-metrics/index.js";
