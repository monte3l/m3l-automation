/**
 * Tests for aws/cloudwatch-metrics submodule.
 *
 * Contract source: docs/reference/aws/cloudwatch-metrics.md.
 *
 * Exports under test (from `../src/aws/cloudwatch-metrics/index.js`,
 * following the package's `../src/aws/index.js` barrel):
 *   M3LCloudWatchMetricsOperations, M3LCloudWatchMetricsOperationError, and
 *   the M3LCloudWatch* plain types.
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

  class PutMetricDataCommand {
    constructor(readonly input: unknown) {}
  }
  class GetMetricStatisticsCommand {
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
    PutMetricDataCommand,
    GetMetricStatisticsCommand,
  };
});

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: h.CloudWatchClient,
  PutMetricDataCommand: h.PutMetricDataCommand,
  GetMetricStatisticsCommand: h.GetMetricStatisticsCommand,
}));

import type {
  M3LCloudWatchMetricDatum,
  M3LGetMetricStatisticsInput,
  M3LGetMetricStatisticsResult,
  M3LPutMetricDataInput,
} from "../src/aws/cloudwatch-metrics/index.js";
import {
  M3LCloudWatchMetricsOperationError,
  M3LCloudWatchMetricsOperations,
} from "../src/aws/cloudwatch-metrics/index.js";

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

/** Builds an array of `count` minimal, distinct `M3LCloudWatchMetricDatum` entries. */
function buildMetricData(count: number): M3LCloudWatchMetricDatum[] {
  return Array.from({ length: count }, (_unused, index) => ({
    metricName: `metric-${String(index)}`,
    value: index,
  }));
}

describe("M3LCloudWatchMetricsOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  // ===========================================================================
  // putMetricData()
  // ===========================================================================
  describe("putMetricData()", () => {
    test("resolves to undefined on a successful PutMetricData call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());

      await expect(
        operations.putMetricData({
          namespace: "custom/app",
          metricData: buildMetricData(1),
        }),
      ).resolves.toBeUndefined();
    });

    test("maps namespace and every metric datum field onto the PutMetricDataCommand input", async () => {
      h.send.mockResolvedValueOnce({});
      const timestamp = new Date("2026-08-01T00:00:00.000Z");

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      await operations.putMetricData({
        namespace: "custom/app",
        metricData: [
          {
            metricName: "RequestCount",
            value: 42,
            dimensions: [{ name: "Service", value: "api" }],
            timestamp,
            unit: "Count",
          },
          {
            metricName: "Latency",
            statisticValues: {
              sampleCount: 10,
              sum: 500,
              minimum: 10,
              maximum: 100,
            },
          },
        ],
      });

      expect(commandInput()).toEqual({
        Namespace: "custom/app",
        MetricData: [
          {
            MetricName: "RequestCount",
            Value: 42,
            Dimensions: [{ Name: "Service", Value: "api" }],
            Timestamp: timestamp,
            Unit: "Count",
          },
          {
            MetricName: "Latency",
            StatisticValues: {
              SampleCount: 10,
              Sum: 500,
              Minimum: 10,
              Maximum: 100,
            },
          },
        ],
      });
    });

    test("throws M3LCloudWatchMetricsOperationError with no cause, before any AWS call, when metricData is empty", async () => {
      const operations = new M3LCloudWatchMetricsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putMetricData({
          namespace: "custom/app",
          metricData: [],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchMetricsOperationError);
      expect(
        (thrown as M3LCloudWatchMetricsOperationError).cause,
      ).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    });

    test("throws M3LCloudWatchMetricsOperationError with no cause, before any AWS call, when metricData exceeds 1000 entries", async () => {
      const operations = new M3LCloudWatchMetricsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putMetricData({
          namespace: "custom/app",
          metricData: buildMetricData(1001),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchMetricsOperationError);
      expect(
        (thrown as M3LCloudWatchMetricsOperationError).cause,
      ).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    });

    test("does NOT reject exactly 1000 entries as malformed — calls send", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      await operations.putMetricData({
        namespace: "custom/app",
        metricData: buildMetricData(1000),
      });

      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("rejects M3LCloudWatchMetricsOperationError with cause chained on a PutMetricData SDK failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putMetricData({
          namespace: "custom/app",
          metricData: buildMetricData(1),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchMetricsOperationError);
      expect((thrown as M3LCloudWatchMetricsOperationError).cause).toBe(
        sdkError,
      );
      expect((thrown as M3LCloudWatchMetricsOperationError).code).toBe(
        "ERR_CLOUDWATCH_METRICS_OPERATION",
      );
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // getMetricStatistics()
  // ===========================================================================
  describe("getMetricStatistics()", () => {
    const baseInput: M3LGetMetricStatisticsInput = {
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      startTime: new Date("2026-08-01T00:00:00.000Z"),
      endTime: new Date("2026-08-01T01:00:00.000Z"),
      period: 300,
      statistics: ["Average", "Maximum"],
    };

    test("resolves with mapped label and datapoints on a successful GetMetricStatistics call", async () => {
      const timestamp = new Date("2026-08-01T00:05:00.000Z");
      h.send.mockResolvedValueOnce({
        Label: "CPUUtilization",
        Datapoints: [
          {
            Timestamp: timestamp,
            SampleCount: 5,
            Average: 42.5,
            Sum: 212.5,
            Minimum: 10,
            Maximum: 90,
            Unit: "Percent",
          },
        ],
      });

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      const result = await operations.getMetricStatistics(baseInput);

      expect(result).toEqual({
        label: "CPUUtilization",
        datapoints: [
          {
            timestamp,
            sampleCount: 5,
            average: 42.5,
            sum: 212.5,
            minimum: 10,
            maximum: 90,
            unit: "Percent",
          },
        ],
      });
    });

    test("resolves datapoints: [] and omits label when the response omits both", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      const result = await operations.getMetricStatistics(baseInput);

      expect(result).toEqual({ datapoints: [] });
      expect(result).not.toHaveProperty("label");
    });

    test("maps namespace/metricName/startTime/endTime/period/statistics/dimensions/unit onto the command input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      await operations.getMetricStatistics({
        ...baseInput,
        dimensions: [{ name: "InstanceId", value: "i-0123456789abcdef0" }],
        unit: "Percent",
      });

      expect(commandInput()).toEqual({
        Namespace: "AWS/EC2",
        MetricName: "CPUUtilization",
        StartTime: baseInput.startTime,
        EndTime: baseInput.endTime,
        Period: 300,
        Statistics: ["Average", "Maximum"],
        Dimensions: [{ Name: "InstanceId", Value: "i-0123456789abcdef0" }],
        Unit: "Percent",
      });
    });

    test("omits Dimensions/Unit from the command input when not supplied", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());
      await operations.getMetricStatistics(baseInput);

      expect(commandInput()).not.toHaveProperty("Dimensions");
      expect(commandInput()).not.toHaveProperty("Unit");
    });

    test("rejects M3LCloudWatchMetricsOperationError with cause chained on a GetMetricStatistics failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LCloudWatchMetricsOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getMetricStatistics(baseInput);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudWatchMetricsOperationError);
      expect((thrown as M3LCloudWatchMetricsOperationError).cause).toBe(
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
    test("getMetricStatistics() retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ Datapoints: [] });

        const operations = new M3LCloudWatchMetricsOperations(fakeClient());

        let result:
          | Awaited<ReturnType<typeof operations.getMetricStatistics>>
          | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.getMetricStatistics({
              namespace: "AWS/EC2",
              metricName: "CPUUtilization",
              startTime: new Date("2026-08-01T00:00:00.000Z"),
              endTime: new Date("2026-08-01T01:00:00.000Z"),
              period: 300,
              statistics: ["Average"],
            });
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result).toEqual({ datapoints: [] });
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("putMetricData() exhausts retries and rejects M3LCloudWatchMetricsOperationError with cause=throttle error after 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LCloudWatchMetricsOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.putMetricData({
              namespace: "custom/app",
              metricData: buildMetricData(1),
            });
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LCloudWatchMetricsOperationError);
        expect((thrown as M3LCloudWatchMetricsOperationError).cause).toBe(
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
    test("M3LPutMetricDataInput has the documented namespace/metricData shape", () => {
      expectTypeOf<M3LPutMetricDataInput>()
        .toHaveProperty("namespace")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LPutMetricDataInput>()
        .toHaveProperty("metricData")
        .toEqualTypeOf<readonly M3LCloudWatchMetricDatum[]>();
    });

    test("M3LCloudWatchMetricDatum's value and statisticValues are mutually optional alternatives", () => {
      expectTypeOf<M3LCloudWatchMetricDatum>()
        .toHaveProperty("value")
        .toEqualTypeOf<number | undefined>();
      expectTypeOf<M3LCloudWatchMetricDatum>()
        .toHaveProperty("statisticValues")
        .toEqualTypeOf<
          | {
              readonly sampleCount: number;
              readonly sum: number;
              readonly minimum: number;
              readonly maximum: number;
            }
          | undefined
        >();
    });

    test("M3LGetMetricStatisticsResult holds an optional label and readonly datapoints", () => {
      expectTypeOf<M3LGetMetricStatisticsResult>()
        .toHaveProperty("label")
        .toEqualTypeOf<string | undefined>();
      expectTypeOf<M3LGetMetricStatisticsResult>()
        .toHaveProperty("datapoints")
        .toMatchTypeOf<readonly unknown[]>();
    });
  });
});
