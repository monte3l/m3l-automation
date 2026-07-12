/**
 * `aws/sqs/error` — typed error for SQS operation failures (as distinct
 * from client construction/teardown failures, which are
 * {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LSQSOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LSQSOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection, or a pre-flight
   * validation failure detected before any AWS call was made. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LSQSOperations} when an SQS operation fails: a whole
 * batch request rejects after retries, `receive`/`purgeQueue` rejects, or a
 * pre-flight guard (batch size, duplicate ids) fails before any AWS call.
 *
 * Per-entry failures inside a successful batch response are **not** thrown —
 * they are returned via {@link M3LSQSBatchResult.failed}. This error is only
 * for request-level failure.
 *
 * @example
 * ```ts
 * import { M3LSQSOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await sqsOperations.purgeQueue(queueUrl);
 * } catch (error) {
 *   if (error instanceof M3LSQSOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LSQSOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_SQS_OPERATION"`. */
  override readonly code = "ERR_SQS_OPERATION" as const;

  /**
   * Creates a new `M3LSQSOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection or pre-flight validation detail. The error code is
   *   always `"ERR_SQS_OPERATION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LSQSOperationErrorOptions) {
    super(message, {
      code: "ERR_SQS_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
