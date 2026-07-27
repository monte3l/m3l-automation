/**
 * `aws/eks/error` — typed error for EKS operation failures (as distinct from
 * client construction/teardown failures, which are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LEKSOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LEKSOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly widened
   * to include `undefined` (rather than only being optional) so callers that
   * carry a `unknown | undefined`-typed cause can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LEKSOperations} when an EKS cluster or nodegroup
 * control-plane operation fails: the underlying SDK `.send()` rejects. This
 * module has no pre-flight validation guards beyond enum-member checks on
 * write-path fields (see `docs/reference/aws/eks.md`).
 *
 * @example
 * ```ts
 * import { M3LEKSOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await eksOperations.describeCluster("my-cluster");
 * } catch (error) {
 *   if (error instanceof M3LEKSOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LEKSOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_EKS_OPERATION"`. */
  override readonly code = "ERR_EKS_OPERATION" as const;

  /**
   * Creates a new `M3LEKSOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always `"ERR_EKS_OPERATION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LEKSOperationErrorOptions) {
    super(message, {
      code: "ERR_EKS_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
