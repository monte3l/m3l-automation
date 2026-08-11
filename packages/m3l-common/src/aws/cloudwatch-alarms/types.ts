/**
 * `aws/cloudwatch-alarms/types` — plain, library-owned types at the
 * CloudWatch alarms-operations boundary. None of these carry an
 * `@aws-sdk/client-cloudwatch` type; every {@link M3LCloudWatchAlarmsOperations}
 * method translates SDK request/response shapes into these before returning.
 * See `docs/reference/aws/cloudwatch-alarms.md` for the full contract.
 *
 * @packageDocumentation
 */

/** A single CloudWatch metric dimension: a name/value pair scoping a metric. */
export interface M3LCloudWatchDimension {
  /** The dimension's name (e.g. `"InstanceId"`). */
  readonly name: string;
  /** The dimension's value (e.g. `"i-0123456789abcdef0"`). */
  readonly value: string;
}

/** The statistic an alarm evaluates over its metric's datapoints. */
export type M3LCloudWatchStatistic =
  "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum";

/** The comparison an alarm applies between its statistic and its threshold. */
export type M3LCloudWatchComparisonOperator =
  | "GreaterThanOrEqualToThreshold"
  | "GreaterThanThreshold"
  | "LessThanThreshold"
  | "LessThanOrEqualToThreshold";

/** How an alarm treats a missing-data evaluation period. */
export type M3LCloudWatchTreatMissingData =
  "breaching" | "notBreaching" | "ignore" | "missing";

/** An alarm's current evaluation state. */
export type M3LCloudWatchAlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA";

/** Input for {@link M3LCloudWatchAlarmsOperations.putMetricAlarm} (creates or updates a metric alarm). */
export interface M3LPutMetricAlarmInput {
  /** The name of the alarm to create or update. */
  readonly alarmName: string;
  /** The name of the metric the alarm evaluates. */
  readonly metricName: string;
  /** The namespace the metric belongs to. */
  readonly namespace: string;
  /** The statistic the alarm evaluates over the metric's datapoints. */
  readonly statistic: M3LCloudWatchStatistic;
  /** The evaluation period, in seconds. */
  readonly period: number;
  /** The number of periods over which data is compared to the threshold. */
  readonly evaluationPeriods: number;
  /** The value the alarm's statistic is compared against. */
  readonly threshold: number;
  /** The comparison applied between the statistic and the threshold. */
  readonly comparisonOperator: M3LCloudWatchComparisonOperator;
  /** The dimensions scoping the metric, when the metric is dimensioned. */
  readonly dimensions?: readonly M3LCloudWatchDimension[];
  /** A description of the alarm. */
  readonly alarmDescription?: string;
  /** Whether actions are executed when the alarm transitions state. */
  readonly actionsEnabled?: boolean;
  /** Actions (e.g. SNS topic ARNs) executed when the alarm enters the `ALARM` state. */
  readonly alarmActions?: readonly string[];
  /** Actions executed when the alarm enters the `OK` state. */
  readonly okActions?: readonly string[];
  /** Actions executed when the alarm enters the `INSUFFICIENT_DATA` state. */
  readonly insufficientDataActions?: readonly string[];
  /** The number of datapoints, within `evaluationPeriods`, that must breach to trigger the alarm. */
  readonly datapointsToAlarm?: number;
  /** How the alarm treats a missing-data evaluation period. */
  readonly treatMissingData?: M3LCloudWatchTreatMissingData;
}

/**
 * A metric alarm as returned by {@link M3LCloudWatchAlarmsOperations.describeAlarms}.
 * `alarmName`/`alarmArn` default to `""` if the SDK response omits them (a
 * real CloudWatch response always populates both).
 */
export interface M3LCloudWatchAlarm {
  /** The alarm's name. */
  readonly alarmName: string;
  /** The alarm's Amazon Resource Name (ARN). */
  readonly alarmArn: string;
  /** The alarm's current evaluation state. */
  readonly stateValue: M3LCloudWatchAlarmState;
  /** A description of the alarm. */
  readonly alarmDescription?: string;
  /** Human-readable detail explaining the current state. */
  readonly stateReason?: string;
  /** The name of the metric the alarm evaluates. */
  readonly metricName?: string;
  /** The namespace the metric belongs to. */
  readonly namespace?: string;
  /** The statistic the alarm evaluates over the metric's datapoints. */
  readonly statistic?: M3LCloudWatchStatistic;
  /** The dimensions scoping the metric, when the metric is dimensioned. */
  readonly dimensions?: readonly M3LCloudWatchDimension[];
  /** The evaluation period, in seconds. */
  readonly period?: number;
  /** The number of periods over which data is compared to the threshold. */
  readonly evaluationPeriods?: number;
  /** The value the alarm's statistic is compared against. */
  readonly threshold?: number;
  /** The comparison applied between the statistic and the threshold. */
  readonly comparisonOperator?: M3LCloudWatchComparisonOperator;
}

/** Options for {@link M3LCloudWatchAlarmsOperations.describeAlarms}. */
export interface M3LCloudWatchDescribeAlarmsOptions {
  /** Restricts the results to alarms with these exact names. */
  readonly alarmNames?: readonly string[];
  /** Restricts the results to alarms whose name starts with this prefix. */
  readonly alarmNamePrefix?: string;
  /** Restricts the results to alarms currently in this state. */
  readonly stateValue?: M3LCloudWatchAlarmState;
  /** Pagination token from a previous call's {@link M3LCloudWatchDescribeAlarmsResult.nextToken}. */
  readonly nextToken?: string;
  /** Maximum number of alarms to return in this call. */
  readonly maxRecords?: number;
}

/**
 * The result of one {@link M3LCloudWatchAlarmsOperations.describeAlarms} call
 * — a single page. `describeAlarms` issues one `DescribeAlarms` request;
 * draining every page (looping on `nextToken`) is a caller decision.
 */
export interface M3LCloudWatchDescribeAlarmsResult {
  /** The alarms on this page. */
  readonly alarms: readonly M3LCloudWatchAlarm[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}
