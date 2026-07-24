/**
 * `aws/ecs/error` — typed error for ECS operation failures (as distinct from
 * client construction/teardown failures, which are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LECSOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LECSOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly widened
   * to include `undefined` (rather than only being optional) so callers that
   * carry a `unknown | undefined`-typed cause can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LECSOperations} when an ECS service or cluster
 * control-plane operation fails: the underlying SDK `.send()` rejects. This
 * module has no pre-flight validation guards (see
 * `docs/reference/aws/ecs.md`) — every failure mode is a rejected `.send()`
 * call.
 *
 * @example
 * ```ts
 * import { M3LECSOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await ecsOperations.describeService("my-cluster", "my-service");
 * } catch (error) {
 *   if (error instanceof M3LECSOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LECSOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ECS_OPERATION"`. */
  override readonly code = "ERR_ECS_OPERATION" as const;

  /**
   * Creates a new `M3LECSOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always `"ERR_ECS_OPERATION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LECSOperationErrorOptions) {
    super(message, {
      code: "ERR_ECS_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
