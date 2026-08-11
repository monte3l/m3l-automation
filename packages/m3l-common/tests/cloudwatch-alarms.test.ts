/**
 * Tests for aws/cloudwatch-alarms submodule.
 *
 * Contract source: docs/reference/aws/cloudwatch-alarms.md.
 *
 * Exports under test (from `../src/aws/cloudwatch-alarms/index.js`, following
 * the package's `../src/aws/index.js` barrel):
 *   M3LCloudWatchAlarmsOperations, M3LCloudWatchAlarmsOperationError, and the
 *   M3LCloudWatch* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-cloudwatch` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/eventbridge.test.ts`), with a `.send()` spy dispatching by command
 * class. Every command class is a plain recorder (`constructor(input)`), so a
 * test asserting on the command shape reads `h.send.mock.calls[0][0].input`.
 *
 * Retry coverage: kept deliberately minimal per this repo's convention (see
 * `tests/eventbridge.test.ts`'s header) — core/polling owns retry mechanics.
 * Every failure-path test below uses a non-retriable error name
 * (`AccessDenied`) so `send` is called exactly once.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class PutMetricAlarmCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeAlarmsCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteAlarmsCommand {
    constructor(readonly input: unknown) {}
  }
  class CloudWatchClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    CloudWatchClient,
    PutMetricAlarmCommand,
    DescribeAlarmsCommand,
    DeleteAlarmsCommand,
  };
});

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: h.CloudWatchClient,
  PutMetricAlarmCommand: h.PutMetricAlarmCommand,
  DescribeAlarmsCommand: h.DescribeAlarmsCommand,
  DeleteAlarmsCommand: h.DeleteAlarmsCommand,
}));

import type {
  M3LCloudWatchAlarm,
  M3LCloudWatchDescribeAlarmsResult,
  M3LPutMetricAlarmInput,
} from "../src/aws/cloudwatch-alarms/index.js";
import {
  M3LCloudWatchAlarmsOperationError,
  M3LCloudWatchAlarmsOperations,
} from "../src/aws/cloudwatch-alarms/index.js";

import type { CloudWatchClient } from "@aws-sdk/client-cloudwatch";

/** Casts the hoisted fake `CloudWatchClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): CloudWatchClient {
  return new h.CloudWatchClient() as unknown as CloudWatchClient;
}

/** Reads the `input` bag from the Nth recorded `send()` call (0-indexed). */
function commandInput(callIndex = 0): Record<string, unknown> {
  const [command] = h.send.mock.calls[callIndex] as [
    { input: Record<string, unknown> },
  ];
  return command.input;
}

/** A non-retriable, fatal SDK-style error — keeps failure-path tests to exactly one `send()` call. */
function fatalError(message = "denied"): Error {
  return Object.assign(new Error(message), { name: "AccessDenied" });
}

const FULL_PUT_METRIC_ALARM_INPUT: M3LPutMetricAlarmInput = {
  alarmName: "high-cpu",
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  statistic: "Average",
  period: 300,
  evaluationPeriods: 3,
  threshold: 80,
  comparisonOperator: "GreaterThanThreshold",
  dimensions: [{ name: "InstanceId", value: "i-0123456789abcdef0" }],
  alarmDescription: "CPU too high",
  actionsEnabled: true,
  alarmActions: ["arn:aws:sns:eu-south-1:123456789012:topic"],
  okActions: ["arn:aws:sns:eu-south-1:123456789012:ok-topic"],
  insufficientDataActions: [
    "arn:aws:sns:eu-south-1:123456789012:insufficient-topic",
  ],
  datapointsToAlarm: 2,
  treatMissingData: "notBreaching",
};

describe("M3LCloudWatchAlarmsOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  // ===========================================================================
  // putMetricAlarm()
  // ===========================================================================
  describe("putMetricAlarm()", () => {
    test("resolves to undefined on a successful PutMetricAlarm call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      await expect(
        operations.putMetricAlarm(FULL_PUT_METRIC_ALARM_INPUT),
      ).resolves.toBeUndefined();
    });

    test("maps every field 1:1 onto the PutMetricAlarmCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.putMetricAlarm(FULL_PUT_METRIC_ALARM_INPUT);

      expect(commandInput()).toEqual({
        AlarmName: "high-cpu",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Statistic: "Average",
        Period: 300,
        EvaluationPeriods: 3,
        Threshold: 80,
        ComparisonOperator: "GreaterThanThreshold",
        Dimensions: [{ Name: "InstanceId", Value: "i-0123456789abcdef0" }],
        AlarmDescription: "CPU too high",
        ActionsEnabled: true,
        AlarmActions: ["arn:aws:sns:eu-south-1:123456789012:topic"],
        OKActions: ["arn:aws:sns:eu-south-1:123456789012:ok-topic"],
        InsufficientDataActions: [
          "arn:aws:sns:eu-south-1:123456789012:insufficient-topic",
        ],
        DatapointsToAlarm: 2,
        TreatMissingData: "notBreaching",
      });
    });

    test("maps okActions onto the AWS OKActions field", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.putMetricAlarm({
        alarmName: "high-cpu",
        metricName: "CPUUtilization",
        namespace: "AWS/EC2",
        statistic: "Average",
        period: 300,
        evaluationPeriods: 3,
        threshold: 80,
        comparisonOperator: "GreaterThanThreshold",
        okActions: ["arn:aws:sns:eu-south-1:123456789012:ok-topic"],
      });

      expect(commandInput()).toMatchObject({
        OKActions: ["arn:aws:sns:eu-south-1:123456789012:ok-topic"],
      });
    });

    test("sends only the required fields when every optional field is omitted", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.putMetricAlarm({
        alarmName: "high-cpu",
        metricName: "CPUUtilization",
        namespace: "AWS/EC2",
        statistic: "Average",
        period: 300,
        evaluationPeriods: 3,
        threshold: 80,
        comparisonOperator: "GreaterThanThreshold",
      });

      expect(commandInput()).toEqual({
        AlarmName: "high-cpu",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Statistic: "Average",
        Period: 300,
        EvaluationPeriods: 3,
        Threshold: 80,
        ComparisonOperator: "GreaterThanThreshold",
      });
    });

    test("rejects M3LCloudWatchAlarmsOperationError with cause chained on a PutMetricAlarm failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putMetricAlarm(FULL_PUT_METRIC_ALARM_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchAlarmsOperationError);
      expect((thrown as M3LCloudWatchAlarmsOperationError).cause).toBe(
        sdkError,
      );
      expect((thrown as M3LCloudWatchAlarmsOperationError).code).toBe(
        "ERR_CLOUDWATCH_ALARMS_OPERATION",
      );
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // describeAlarms()
  // ===========================================================================
  describe("describeAlarms()", () => {
    test("resolves with plain M3LCloudWatchAlarm[] on a successful DescribeAlarms call", async () => {
      h.send.mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: "high-cpu",
            AlarmArn:
              "arn:aws:cloudwatch:eu-south-1:123456789012:alarm:high-cpu",
            StateValue: "OK",
            MetricName: "CPUUtilization",
            Namespace: "AWS/EC2",
            Statistic: "Average",
            Period: 300,
            EvaluationPeriods: 3,
            Threshold: 80,
            ComparisonOperator: "GreaterThanThreshold",
            Dimensions: [{ Name: "InstanceId", Value: "i-0123456789abcdef0" }],
          },
        ],
      });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      const result = await operations.describeAlarms();

      expect(result.alarms).toEqual([
        {
          alarmName: "high-cpu",
          alarmArn: "arn:aws:cloudwatch:eu-south-1:123456789012:alarm:high-cpu",
          stateValue: "OK",
          metricName: "CPUUtilization",
          namespace: "AWS/EC2",
          statistic: "Average",
          period: 300,
          evaluationPeriods: 3,
          threshold: 80,
          comparisonOperator: "GreaterThanThreshold",
          dimensions: [{ name: "InstanceId", value: "i-0123456789abcdef0" }],
        },
      ]);
    });

    // -------------------------------------------------------------------
    // Regression: describeAlarms()'s AlarmTypes: ["MetricAlarm"] filter does
    // NOT exclude anomaly-detection alarms — AWS still returns those as
    // MetricAlarms (distinguished only by a ThresholdMetricId field), so
    // ComparisonOperator can legitimately carry one of the 3 anomaly-detection
    // operators the library's 4-member M3LCloudWatchComparisonOperator union
    // deliberately excludes. An unchecked `as` cast at client.ts would pass
    // that out-of-union string straight through instead of omitting it.
    // -------------------------------------------------------------------
    test("omits comparisonOperator when the SDK response carries an anomaly-detection operator outside the documented static-threshold union", async () => {
      h.send.mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: "anomaly-alarm",
            AlarmArn:
              "arn:aws:cloudwatch:eu-south-1:123456789012:alarm:anomaly-alarm",
            StateValue: "OK",
            MetricName: "CPUUtilization",
            Namespace: "AWS/EC2",
            // Anomaly-detection operator — not one of the 4 static-threshold
            // literals M3LCloudWatchComparisonOperator covers.
            ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
            ThresholdMetricId: "ad1",
          },
        ],
      });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      const result = await operations.describeAlarms();

      expect(result.alarms[0]).not.toHaveProperty("comparisonOperator");
      expect(result.alarms[0]?.comparisonOperator).toBeUndefined();
    });

    test("keeps comparisonOperator populated for a real static-threshold operator (contrast case)", async () => {
      h.send.mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: "static-threshold-alarm",
            AlarmArn:
              "arn:aws:cloudwatch:eu-south-1:123456789012:alarm:static-threshold-alarm",
            StateValue: "ALARM",
            MetricName: "CPUUtilization",
            Namespace: "AWS/EC2",
            ComparisonOperator: "GreaterThanThreshold",
          },
        ],
      });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      const result = await operations.describeAlarms();

      expect(result.alarms[0]?.comparisonOperator).toBe("GreaterThanThreshold");
    });

    test("resolves alarms: [] when the response omits MetricAlarms entirely", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      await expect(operations.describeAlarms()).resolves.toEqual({
        alarms: [],
      });
    });

    test("fixes AlarmTypes to ['MetricAlarm'] internally regardless of caller input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.describeAlarms();

      expect(commandInput()).toMatchObject({ AlarmTypes: ["MetricAlarm"] });
    });

    test("passes nextToken through as NextToken when supplied", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.describeAlarms({ nextToken: "page-1" });

      expect(commandInput()).toMatchObject({ NextToken: "page-1" });
    });

    test("maps alarmNames/alarmNamePrefix/stateValue/maxRecords onto the command input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.describeAlarms({
        alarmNames: ["high-cpu"],
        alarmNamePrefix: "high-",
        stateValue: "ALARM",
        maxRecords: 50,
      });

      expect(commandInput()).toMatchObject({
        AlarmNames: ["high-cpu"],
        AlarmNamePrefix: "high-",
        StateValue: "ALARM",
        MaxRecords: 50,
      });
    });

    test("returns nextToken read back from the response's NextToken", async () => {
      h.send.mockResolvedValueOnce({ MetricAlarms: [], NextToken: "page-2" });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      const result = await operations.describeAlarms();

      expect(result.nextToken).toBe("page-2");
    });

    test("omits nextToken from the result when the response returns none", async () => {
      h.send.mockResolvedValueOnce({ MetricAlarms: [] });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      const result = await operations.describeAlarms();

      expect(result).not.toHaveProperty("nextToken");
    });

    test("does not drain pagination automatically — resolves after exactly one send() even when NextToken is present", async () => {
      h.send.mockResolvedValueOnce({ MetricAlarms: [], NextToken: "page-2" });

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.describeAlarms();

      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("rejects M3LCloudWatchAlarmsOperationError with cause chained on a DescribeAlarms failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeAlarms();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchAlarmsOperationError);
      expect((thrown as M3LCloudWatchAlarmsOperationError).cause).toBe(
        sdkError,
      );
    });
  });

  // ===========================================================================
  // deleteAlarms()
  // ===========================================================================
  describe("deleteAlarms()", () => {
    test("resolves to undefined on a successful DeleteAlarms call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      await expect(
        operations.deleteAlarms(["high-cpu", "low-disk"]),
      ).resolves.toBeUndefined();
    });

    test("sends AlarmNames on the DeleteAlarmsCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());
      await operations.deleteAlarms(["high-cpu", "low-disk"]);

      expect(commandInput()).toEqual({
        AlarmNames: ["high-cpu", "low-disk"],
      });
    });

    test("rejects M3LCloudWatchAlarmsOperationError with cause chained on a DeleteAlarms failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.deleteAlarms(["high-cpu"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchAlarmsOperationError);
      expect((thrown as M3LCloudWatchAlarmsOperationError).cause).toBe(
        sdkError,
      );
    });
  });

  // ===========================================================================
  // Cross-cutting retry behavior — deliberately minimal (core/polling owns
  // retry mechanics); one success-after-retry case and one exhausted-retries
  // case is enough per this repo's convention (see the file header comment).
  // ===========================================================================
  describe("retry behavior (awsThrottling policy)", () => {
    test("describeAlarms() retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ MetricAlarms: [] });

        const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

        let result:
          Awaited<ReturnType<typeof operations.describeAlarms>> | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.describeAlarms();
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result).toEqual({ alarms: [] });
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("putMetricAlarm() exhausts retries and rejects M3LCloudWatchAlarmsOperationError with cause=throttle error after 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LCloudWatchAlarmsOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.putMetricAlarm(FULL_PUT_METRIC_ALARM_INPUT);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LCloudWatchAlarmsOperationError);
        expect((thrown as M3LCloudWatchAlarmsOperationError).cause).toBe(
          throttleError,
        );
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // Type-level contracts
  // ===========================================================================
  describe("type-level contracts", () => {
    test("M3LPutMetricAlarmInput has the documented required/optional shape", () => {
      expectTypeOf<M3LPutMetricAlarmInput>()
        .toHaveProperty("alarmName")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LPutMetricAlarmInput>()
        .toHaveProperty("comparisonOperator")
        .toEqualTypeOf<
          | "GreaterThanOrEqualToThreshold"
          | "GreaterThanThreshold"
          | "LessThanThreshold"
          | "LessThanOrEqualToThreshold"
        >();
      expectTypeOf<M3LPutMetricAlarmInput>()
        .toHaveProperty("dimensions")
        .toEqualTypeOf<
          | readonly { readonly name: string; readonly value: string }[]
          | undefined
        >();
    });

    test("M3LCloudWatchAlarm's non-name/arn fields are all optional", () => {
      expectTypeOf<M3LCloudWatchAlarm>()
        .toHaveProperty("alarmName")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LCloudWatchAlarm>()
        .toHaveProperty("alarmArn")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LCloudWatchAlarm>()
        .toHaveProperty("stateValue")
        .toEqualTypeOf<"OK" | "ALARM" | "INSUFFICIENT_DATA">();
      expectTypeOf<M3LCloudWatchAlarm>()
        .toHaveProperty("metricName")
        .toEqualTypeOf<string | undefined>();
    });

    test("M3LCloudWatchDescribeAlarmsResult holds readonly alarms and an optional nextToken", () => {
      expectTypeOf<M3LCloudWatchDescribeAlarmsResult>()
        .toHaveProperty("alarms")
        .toEqualTypeOf<readonly M3LCloudWatchAlarm[]>();
      expectTypeOf<M3LCloudWatchDescribeAlarmsResult>()
        .toHaveProperty("nextToken")
        .toEqualTypeOf<string | undefined>();
    });
  });
});
