/**
 * `aws/cloudformation/error` — typed error for CloudFormation operation
 * failures (as distinct from client construction/teardown failures, which
 * are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LCloudFormationOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LCloudFormationOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` or waiter rejection.
   * Explicitly widened to include `undefined` (rather than only being
   * optional) so callers that carry a `unknown | undefined`-typed cause can
   * forward it directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LCloudFormationOperations} when a CloudFormation stack
 * operation fails: the underlying SDK `.send()` call or a
 * `waitUntilStack*Complete` waiter's polling call rejects with anything other
 * than the two named data-classified `ValidationError` cases
 * (`describeStack`'s does-not-exist, `updateStack`'s no-updates) or the two
 * named waiter terminal error names (`TimeoutError`, `AbortError`) — see
 * `docs/reference/aws/cloudformation.md`.
 *
 * @example
 * ```ts
 * import { M3LCloudFormationOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await cloudFormationOperations.createStack(input);
 * } catch (error) {
 *   if (error instanceof M3LCloudFormationOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LCloudFormationOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CLOUDFORMATION_OPERATION"`. */
  override readonly code = "ERR_CLOUDFORMATION_OPERATION" as const;

  /**
   * Creates a new `M3LCloudFormationOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_CLOUDFORMATION_OPERATION"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LCloudFormationOperationErrorOptions,
  ) {
    super(message, {
      code: "ERR_CLOUDFORMATION_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
