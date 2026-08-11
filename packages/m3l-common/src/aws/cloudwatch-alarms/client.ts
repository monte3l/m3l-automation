/**
 * `aws/cloudwatch-alarms/client` — {@link M3LCloudWatchAlarmsOperations}, a
 * typed wrapper over a raw `CloudWatchClient` so callers never import
 * `@aws-sdk/client-cloudwatch` command classes directly. See
 * `docs/reference/aws/cloudwatch-alarms.md` for the full contract, and
 * ADR-0026 (referenced by `aws/eventbridge`) for why this module is
 * permitted to import `core/polling` (Zone A).
 *
 * @packageDocumentation
 */

import type {
  DescribeAlarmsCommandInput,
  MetricAlarm,
  PutMetricAlarmCommandInput,
  CloudWatchClient,
} from "@aws-sdk/client-cloudwatch";
import {
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
} from "@aws-sdk/client-cloudwatch";

import { M3LCloudWatchAlarmsOperationError } from "./error.js";
import type {
  M3LCloudWatchAlarm,
  M3LCloudWatchComparisonOperator,
  M3LCloudWatchDescribeAlarmsOptions,
  M3LCloudWatchDescribeAlarmsResult,
  M3LPutMetricAlarmInput,
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/**
 * Membership map for {@link M3LCloudWatchComparisonOperator}'s 4
 * static-threshold literals, keyed off the union so the compiler rejects a
 * missing or excess key. Backs {@link toComparisonOperator}'s runtime check —
 * the raw SDK `ComparisonOperator` also carries 3 anomaly-detection
 * operators this library's narrowed union deliberately excludes.
 */
const STATIC_THRESHOLD_OPERATORS: Record<
  M3LCloudWatchComparisonOperator,
  true
> = {
  GreaterThanOrEqualToThreshold: true,
  GreaterThanThreshold: true,
  LessThanThreshold: true,
  LessThanOrEqualToThreshold: true,
};

/**
 * Narrows a raw SDK `ComparisonOperator` string to
 * {@link M3LCloudWatchComparisonOperator}, returning `undefined` when the
 * value is one of the SDK's 3 anomaly-detection operators (or any other
 * value outside the 4-member static-threshold union) — `describeAlarms`'s
 * `AlarmTypes: ["MetricAlarm"]` filter does not exclude anomaly-detection
 * alarms, so a real response can carry one of those excluded values.
 *
 * @param raw - The SDK `MetricAlarm.ComparisonOperator` string.
 * @returns The narrowed operator, or `undefined` if `raw` is out of union.
 */
function toComparisonOperator(
  raw: string,
): M3LCloudWatchComparisonOperator | undefined {
  return Object.hasOwn(STATIC_THRESHOLD_OPERATORS, raw)
    ? (raw as M3LCloudWatchComparisonOperator)
    : undefined;
}

/**
 * Translates an SDK `MetricAlarm`'s dimensions, when present.
 *
 * @param dimensions - The alarm's `Dimensions`, or `undefined`.
 * @returns The plain, library-owned dimensions, or `undefined`.
 */
function mapAlarmDimensions(
  dimensions: MetricAlarm["Dimensions"],
): M3LCloudWatchAlarm["dimensions"] {
  return dimensions?.map((dimension) => ({
    name: dimension.Name ?? "",
    value: dimension.Value ?? "",
  }));
}

/**
 * Translates the metric-definition fields shared by an SDK `MetricAlarm`
 * (metric name, namespace, statistic, dimensions, period, evaluation
 * periods, threshold, comparison operator) — split out of {@link mapAlarm}
 * to keep both functions' cyclomatic complexity low.
 *
 * @param alarm - One SDK `MetricAlarm` from a `DescribeAlarms` response.
 * @returns The subset of {@link M3LCloudWatchAlarm}'s metric-definition fields the SDK populated.
 */
function mapAlarmMetricFields(
  alarm: MetricAlarm,
): Partial<
  Pick<
    M3LCloudWatchAlarm,
    | "metricName"
    | "namespace"
    | "statistic"
    | "dimensions"
    | "period"
    | "evaluationPeriods"
    | "threshold"
    | "comparisonOperator"
  >
> {
  const dimensions = mapAlarmDimensions(alarm.Dimensions);
  const comparisonOperator =
    alarm.ComparisonOperator !== undefined
      ? toComparisonOperator(alarm.ComparisonOperator)
      : undefined;
  return {
    ...(alarm.MetricName !== undefined && { metricName: alarm.MetricName }),
    ...(alarm.Namespace !== undefined && { namespace: alarm.Namespace }),
    ...(alarm.Statistic !== undefined && { statistic: alarm.Statistic }),
    ...(dimensions !== undefined && { dimensions }),
    ...(alarm.Period !== undefined && { period: alarm.Period }),
    ...(alarm.EvaluationPeriods !== undefined && {
      evaluationPeriods: alarm.EvaluationPeriods,
    }),
    ...(alarm.Threshold !== undefined && { threshold: alarm.Threshold }),
    ...(comparisonOperator !== undefined && { comparisonOperator }),
  };
}

/**
 * Translates one SDK `MetricAlarm` into a plain {@link M3LCloudWatchAlarm},
 * defaulting missing `AlarmName`/`AlarmArn`/`StateValue` rather than
 * throwing and omitting every other field the SDK left `undefined`.
 *
 * @param alarm - One SDK `MetricAlarm` from a `DescribeAlarms` response.
 * @returns The plain, library-owned alarm shape.
 */
function mapAlarm(alarm: MetricAlarm): M3LCloudWatchAlarm {
  return {
    alarmName: alarm.AlarmName ?? "",
    alarmArn: alarm.AlarmArn ?? "",
    stateValue: alarm.StateValue ?? "INSUFFICIENT_DATA",
    ...(alarm.AlarmDescription !== undefined && {
      alarmDescription: alarm.AlarmDescription,
    }),
    ...(alarm.StateReason !== undefined && {
      stateReason: alarm.StateReason,
    }),
    ...mapAlarmMetricFields(alarm),
  };
}

/**
 * Builds a `PutMetricAlarmCommand`'s input from a plain
 * {@link M3LPutMetricAlarmInput}, mapping every camelCase field onto its
 * AWS PascalCase equivalent — split out of
 * {@link M3LCloudWatchAlarmsOperations.putMetricAlarm} to keep both
 * functions' cyclomatic complexity low.
 *
 * @param input - The alarm definition; see {@link M3LPutMetricAlarmInput}.
 * @returns The SDK `PutMetricAlarmCommand` input shape.
 */
function buildPutMetricAlarmInput(
  input: M3LPutMetricAlarmInput,
): PutMetricAlarmCommandInput {
  return {
    AlarmName: input.alarmName,
    MetricName: input.metricName,
    Namespace: input.namespace,
    Statistic: input.statistic,
    Period: input.period,
    EvaluationPeriods: input.evaluationPeriods,
    Threshold: input.threshold,
    ComparisonOperator: input.comparisonOperator,
    ...(input.dimensions !== undefined && {
      Dimensions: input.dimensions.map((dimension) => ({
        Name: dimension.name,
        Value: dimension.value,
      })),
    }),
    ...(input.alarmDescription !== undefined && {
      AlarmDescription: input.alarmDescription,
    }),
    ...(input.actionsEnabled !== undefined && {
      ActionsEnabled: input.actionsEnabled,
    }),
    ...(input.alarmActions !== undefined && {
      AlarmActions: [...input.alarmActions],
    }),
    ...(input.okActions !== undefined && {
      OKActions: [...input.okActions],
    }),
    ...(input.insufficientDataActions !== undefined && {
      InsufficientDataActions: [...input.insufficientDataActions],
    }),
    ...(input.datapointsToAlarm !== undefined && {
      DatapointsToAlarm: input.datapointsToAlarm,
    }),
    ...(input.treatMissingData !== undefined && {
      TreatMissingData: input.treatMissingData,
    }),
  };
}

/**
 * Builds a `DescribeAlarmsCommand`'s input from
 * {@link M3LCloudWatchDescribeAlarmsOptions}, always fixing `AlarmTypes` to
 * `["MetricAlarm"]` — split out of
 * {@link M3LCloudWatchAlarmsOperations.describeAlarms} to keep both
 * functions' cyclomatic complexity low.
 *
 * @param options - Describe filters/pagination; see {@link M3LCloudWatchDescribeAlarmsOptions}.
 * @returns The SDK `DescribeAlarmsCommand` input shape.
 */
function buildDescribeAlarmsInput(
  options: M3LCloudWatchDescribeAlarmsOptions | undefined,
): DescribeAlarmsCommandInput {
  const { alarmNames, alarmNamePrefix, stateValue, nextToken, maxRecords } =
    options ?? {};
  return {
    AlarmTypes: ["MetricAlarm"],
    ...(alarmNames !== undefined && { AlarmNames: [...alarmNames] }),
    ...(alarmNamePrefix !== undefined && { AlarmNamePrefix: alarmNamePrefix }),
    ...(stateValue !== undefined && { StateValue: stateValue }),
    ...(nextToken !== undefined && { NextToken: nextToken }),
    ...(maxRecords !== undefined && { MaxRecords: maxRecords }),
  };
}

/**
 * Typed operations over a raw CloudWatch `CloudWatchClient`: metric alarm
 * create/update, describe, and delete — translating SDK request/response
 * shapes into the plain types in `aws/cloudwatch-alarms/types`. Every
 * method retries throttling/network failures internally via
 * `M3LPollingPolicies.awsThrottling()`.
 *
 * @example
 * ```ts
 * import { M3LCloudWatchAlarmsOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const cloudWatchAlarmsOperations = new M3LCloudWatchAlarmsOperations(script.aws.clients.cloudWatch);
 * const { alarms } = await cloudWatchAlarmsOperations.describeAlarms({ alarmNamePrefix: "nightly-" });
 * ```
 */
export class M3LCloudWatchAlarmsOperations {
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LCloudWatchAlarmsOperations` wrapping the given raw
   * SDK client.
   *
   * @param client - A constructed `CloudWatchClient` (e.g. `script.aws.clients.cloudWatch`).
   */
  constructor(private readonly client: CloudWatchClient) {
    this.#runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
  }

  /**
   * Creates a new metric alarm or updates an existing one with the same
   * name.
   *
   * @param input - The alarm definition; see {@link M3LPutMetricAlarmInput}.
   * @throws {@link M3LCloudWatchAlarmsOperationError} if the underlying `PutMetricAlarm` call fails.
   */
  async putMetricAlarm(input: M3LPutMetricAlarmInput): Promise<void> {
    try {
      const commandInput = buildPutMetricAlarmInput(input);
      await this.#runner.run(() =>
        this.client.send(new PutMetricAlarmCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LCloudWatchAlarmsOperationError(
        `putMetricAlarm: PutMetricAlarm failed for alarmName=${input.alarmName}`,
        { cause },
      );
    }
  }

  /**
   * Describes metric alarms, optionally filtered by name/prefix/state.
   * Issues a single `DescribeAlarms` request — draining every page (looping
   * on `nextToken`) is a caller decision, mirroring
   * `M3LEventBridgeOperations.listRules`'s one-shot-call convention. Always
   * fixes `AlarmTypes` to `["MetricAlarm"]`, so composite alarms are never
   * returned.
   *
   * @param options - Describe filters/pagination; see {@link M3LCloudWatchDescribeAlarmsOptions}.
   * @throws {@link M3LCloudWatchAlarmsOperationError} if the underlying `DescribeAlarms` call fails.
   */
  async describeAlarms(
    options?: M3LCloudWatchDescribeAlarmsOptions,
  ): Promise<M3LCloudWatchDescribeAlarmsResult> {
    const commandInput = buildDescribeAlarmsInput(options);
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new DescribeAlarmsCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LCloudWatchAlarmsOperationError(
        "describeAlarms: DescribeAlarms failed",
        { cause },
      );
    }

    return {
      alarms: (response.MetricAlarms ?? []).map(mapAlarm),
      ...(response.NextToken !== undefined && {
        nextToken: response.NextToken,
      }),
    };
  }

  /**
   * Deletes one or more alarms.
   *
   * @param alarmNames - The names of the alarms to delete.
   * @throws {@link M3LCloudWatchAlarmsOperationError} if the underlying `DeleteAlarms` call fails.
   */
  async deleteAlarms(alarmNames: readonly string[]): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.client.send(
          new DeleteAlarmsCommand({ AlarmNames: [...alarmNames] }),
        ),
      );
    } catch (cause) {
      throw new M3LCloudWatchAlarmsOperationError(
        "deleteAlarms: DeleteAlarms failed",
        { cause },
      );
    }
  }
}
