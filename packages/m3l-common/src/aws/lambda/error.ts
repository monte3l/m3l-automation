/**
 * `aws/lambda/error` — typed error for Lambda operation failures (as distinct
 * from client construction/teardown failures, which are
 * {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LLambdaOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LLambdaOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly widened
   * to include `undefined` (rather than only being optional) so callers that
   * carry a `unknown | undefined`-typed cause can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LLambdaOperations} when a Lambda control-plane or
 * invoke operation fails: the underlying SDK `.send()` rejects. This module
 * has no pre-flight validation guards (see `docs/reference/aws/lambda.md`) —
 * every failure mode is a rejected `.send()` call.
 *
 * @example
 * ```ts
 * import { M3LLambdaOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await lambdaOperations.getFunction("my-function");
 * } catch (error) {
 *   if (error instanceof M3LLambdaOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LLambdaOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_LAMBDA_OPERATION"`. */
  override readonly code = "ERR_LAMBDA_OPERATION" as const;

  /**
   * Creates a new `M3LLambdaOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always `"ERR_LAMBDA_OPERATION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LLambdaOperationErrorOptions) {
    super(message, {
      code: "ERR_LAMBDA_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
