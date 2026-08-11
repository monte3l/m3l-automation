/**
 * `aws/cloudwatch-metrics/client` — {@link M3LCloudWatchMetricsOperations},
 * a typed wrapper over a raw `CloudWatchClient` so callers never import
 * `@aws-sdk/client-cloudwatch` command classes directly. See
 * `docs/reference/aws/cloudwatch-metrics.md` for the full contract, and
 * ADR-0026 (referenced by `aws/eventbridge`) for why this module is
 * permitted to import `core/polling` (Zone A).
 *
 * @packageDocumentation
 */

import type { CloudWatchClient, Datapoint } from "@aws-sdk/client-cloudwatch";
import {
  GetMetricStatisticsCommand,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

import { M3LCloudWatchMetricsOperationError } from "./error.js";
import type {
  M3LCloudWatchDatapoint,
  M3LGetMetricStatisticsInput,
  M3LGetMetricStatisticsResult,
  M3LPutMetricDataInput,
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/** The CloudWatch API cap on entries per `PutMetricData` call. */
const MAX_METRIC_DATA_ENTRIES = 1000;

/**
 * Translates one SDK `Datapoint` into a plain {@link M3LCloudWatchDatapoint},
 * omitting every field the SDK left `undefined`.
 *
 * @param datapoint - One SDK `Datapoint` from a `GetMetricStatistics` response.
 * @returns The plain, library-owned datapoint shape.
 */
function mapDatapoint(datapoint: Datapoint): M3LCloudWatchDatapoint {
  return {
    ...(datapoint.Timestamp !== undefined && {
      timestamp: datapoint.Timestamp,
    }),
    ...(datapoint.SampleCount !== undefined && {
      sampleCount: datapoint.SampleCount,
    }),
    ...(datapoint.Average !== undefined && { average: datapoint.Average }),
    ...(datapoint.Sum !== undefined && { sum: datapoint.Sum }),
    ...(datapoint.Minimum !== undefined && { minimum: datapoint.Minimum }),
    ...(datapoint.Maximum !== undefined && { maximum: datapoint.Maximum }),
    ...(datapoint.Unit !== undefined && { unit: datapoint.Unit }),
  };
}

/**
 * Typed operations over a raw CloudWatch `CloudWatchClient`: custom metric
 * publishing and statistics retrieval — translating SDK request/response
 * shapes into the plain types in `aws/cloudwatch-metrics/types`. Every
 * method retries throttling/network failures internally via
 * `M3LPollingPolicies.awsThrottling()`.
 *
 * @example
 * ```ts
 * import { M3LCloudWatchMetricsOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const cloudWatchMetricsOperations = new M3LCloudWatchMetricsOperations(script.aws.clients.cloudWatch);
 * await cloudWatchMetricsOperations.putMetricData({
 *   namespace: "custom/app",
 *   metricData: [{ metricName: "RequestCount", value: 1 }],
 * });
 * ```
 */
export class M3LCloudWatchMetricsOperations {
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LCloudWatchMetricsOperations` wrapping the given raw
   * SDK client.
   *
   * @param client - A constructed `CloudWatchClient` (e.g. `script.aws.clients.cloudWatch`).
   */
  constructor(private readonly client: CloudWatchClient) {
    this.#runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
  }

  /**
   * Publishes one or more metric datapoints to CloudWatch. Validates the
   * batch size before any AWS call — `metricData` must contain between 1
   * and 1000 entries, matching the `PutMetricData` API's own limit.
   *
   * @param input - The namespace and metric data to publish; see {@link M3LPutMetricDataInput}.
   * @throws {@link M3LCloudWatchMetricsOperationError} if `metricData` is
   *   empty or exceeds 1000 entries (no `cause`, no AWS call made), or if
   *   the underlying `PutMetricData` call fails.
   */
  async putMetricData(input: M3LPutMetricDataInput): Promise<void> {
    if (
      input.metricData.length === 0 ||
      input.metricData.length > MAX_METRIC_DATA_ENTRIES
    ) {
      throw new M3LCloudWatchMetricsOperationError(
        `putMetricData: metricData must contain between 1 and ${String(MAX_METRIC_DATA_ENTRIES)} entries, got ${String(input.metricData.length)}`,
      );
    }

    try {
      await this.#runner.run(() =>
        this.client.send(
          new PutMetricDataCommand({
            Namespace: input.namespace,
            MetricData: input.metricData.map((datum) => ({
              MetricName: datum.metricName,
              ...(datum.value !== undefined && { Value: datum.value }),
              ...(datum.dimensions !== undefined && {
                Dimensions: datum.dimensions.map((dimension) => ({
                  Name: dimension.name,
                  Value: dimension.value,
                })),
              }),
              ...(datum.timestamp !== undefined && {
                Timestamp: datum.timestamp,
              }),
              ...(datum.unit !== undefined && { Unit: datum.unit }),
              ...(datum.statisticValues !== undefined && {
                StatisticValues: {
                  SampleCount: datum.statisticValues.sampleCount,
                  Sum: datum.statisticValues.sum,
                  Minimum: datum.statisticValues.minimum,
                  Maximum: datum.statisticValues.maximum,
                },
              }),
            })),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LCloudWatchMetricsOperationError(
        `putMetricData: PutMetricData failed for namespace=${input.namespace}`,
        { cause },
      );
    }
  }

  /**
   * Retrieves computed statistics for a metric over a time range.
   *
   * @param input - The query definition; see {@link M3LGetMetricStatisticsInput}.
   * @throws {@link M3LCloudWatchMetricsOperationError} if the underlying `GetMetricStatistics` call fails.
   */
  async getMetricStatistics(
    input: M3LGetMetricStatisticsInput,
  ): Promise<M3LGetMetricStatisticsResult> {
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(
          new GetMetricStatisticsCommand({
            Namespace: input.namespace,
            MetricName: input.metricName,
            StartTime: input.startTime,
            EndTime: input.endTime,
            Period: input.period,
            Statistics: [...input.statistics],
            ...(input.dimensions !== undefined && {
              Dimensions: input.dimensions.map((dimension) => ({
                Name: dimension.name,
                Value: dimension.value,
              })),
            }),
            ...(input.unit !== undefined && { Unit: input.unit }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LCloudWatchMetricsOperationError(
        `getMetricStatistics: GetMetricStatistics failed for metricName=${input.metricName}`,
        { cause },
      );
    }

    return {
      ...(response.Label !== undefined && { label: response.Label }),
      datapoints: (response.Datapoints ?? []).map(mapDatapoint),
    };
  }
}
