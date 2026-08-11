/**
 * `aws/cloudwatch-metrics/error` — typed error for CloudWatch metrics
 * operation failures (as distinct from client construction/teardown
 * failures, which are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LCloudWatchMetricsOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LCloudWatchMetricsOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection, or `undefined`
   * for a pre-flight validation failure detected before any AWS call was
   * made. Explicitly widened to include `undefined` (rather than only being
   * optional) so callers that carry a `unknown | undefined`-typed cause can
   * forward it directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LCloudWatchMetricsOperations} when a CloudWatch metrics
 * operation fails: a `PutMetricData`/`GetMetricStatistics` request rejects
 * after retries, or a pre-flight guard (`metricData` batch size) fails
 * before any AWS call.
 *
 * @example
 * ```ts
 * import { M3LCloudWatchMetricsOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await cloudWatchMetricsOperations.putMetricData({
 *     namespace: "custom/app",
 *     metricData: [],
 *   });
 * } catch (error) {
 *   if (error instanceof M3LCloudWatchMetricsOperationError) {
 *     // error.cause carries the underlying SDK rejection, when present
 *   }
 * }
 * ```
 */
export class M3LCloudWatchMetricsOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CLOUDWATCH_METRICS_OPERATION"`. */
  override readonly code = "ERR_CLOUDWATCH_METRICS_OPERATION" as const;

  /**
   * Creates a new `M3LCloudWatchMetricsOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_CLOUDWATCH_METRICS_OPERATION"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LCloudWatchMetricsOperationErrorOptions,
  ) {
    super(message, {
      code: "ERR_CLOUDWATCH_METRICS_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
