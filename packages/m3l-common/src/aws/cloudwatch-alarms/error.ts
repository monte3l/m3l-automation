/**
 * `aws/cloudwatch-alarms/error` — typed error for CloudWatch alarms
 * operation failures (as distinct from client construction/teardown
 * failures, which are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LCloudWatchAlarmsOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LCloudWatchAlarmsOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LCloudWatchAlarmsOperations} when a CloudWatch alarms
 * operation fails: a `PutMetricAlarm`/`DescribeAlarms`/`DeleteAlarms`
 * request rejects after retries.
 *
 * @example
 * ```ts
 * import { M3LCloudWatchAlarmsOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await cloudWatchAlarmsOperations.deleteAlarms(["high-cpu"]);
 * } catch (error) {
 *   if (error instanceof M3LCloudWatchAlarmsOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LCloudWatchAlarmsOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CLOUDWATCH_ALARMS_OPERATION"`. */
  override readonly code = "ERR_CLOUDWATCH_ALARMS_OPERATION" as const;

  /**
   * Creates a new `M3LCloudWatchAlarmsOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_CLOUDWATCH_ALARMS_OPERATION"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LCloudWatchAlarmsOperationErrorOptions,
  ) {
    super(message, {
      code: "ERR_CLOUDWATCH_ALARMS_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
