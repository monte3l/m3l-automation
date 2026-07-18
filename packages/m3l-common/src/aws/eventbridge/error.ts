/**
 * `aws/eventbridge/error` — typed error for EventBridge operation failures
 * (as distinct from client construction/teardown failures, which are
 * {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LEventBridgeOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LEventBridgeOperationErrorOptions {
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
 * Thrown by {@link M3LEventBridgeOperations} when an EventBridge operation
 * fails: a rule/target request rejects after retries, or a pre-flight guard
 * (batch size, duplicate target ids) fails before any AWS call.
 *
 * Per-entry failures inside a successful `putTargets`/`removeTargets`
 * response are **not** thrown — they are returned via
 * {@link M3LEventBridgePutTargetsResult.failed} /
 * {@link M3LEventBridgeRemoveTargetsResult.failed}. This error is only for
 * request-level failure.
 *
 * @example
 * ```ts
 * import { M3LEventBridgeOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await eventBridgeOperations.deleteRule("my-rule");
 * } catch (error) {
 *   if (error instanceof M3LEventBridgeOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LEventBridgeOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_EVENTBRIDGE_OPERATION"`. */
  override readonly code = "ERR_EVENTBRIDGE_OPERATION" as const;

  /**
   * Creates a new `M3LEventBridgeOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection or pre-flight validation detail. The error code is
   *   always `"ERR_EVENTBRIDGE_OPERATION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LEventBridgeOperationErrorOptions) {
    super(message, {
      code: "ERR_EVENTBRIDGE_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
