/**
 * `aws/codepipeline/error` — typed error for CodePipeline operation failures
 * (as distinct from client construction/teardown failures, which are
 * {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LCodePipelineOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LCodePipelineOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection.
   * Explicitly widened to include `undefined` (rather than only being
   * optional) so callers that carry a `unknown | undefined`-typed cause can
   * forward it directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LCodePipelineOperations} when a CodePipeline operation
 * fails: the underlying SDK `.send()` call rejects with anything other than
 * a named data-classified case (`PipelineNotFoundException`/
 * `PipelineExecutionNotFoundException` on the read paths that resolve
 * `undefined`) — see `docs/reference/aws/codepipeline.md`.
 *
 * @example
 * ```ts
 * import { M3LCodePipelineOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await codePipelineOperations.startPipelineExecution(name);
 * } catch (error) {
 *   if (error instanceof M3LCodePipelineOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LCodePipelineOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CODEPIPELINE_OPERATION"`. */
  override readonly code = "ERR_CODEPIPELINE_OPERATION" as const;

  /**
   * Creates a new `M3LCodePipelineOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_CODEPIPELINE_OPERATION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LCodePipelineOperationErrorOptions) {
    super(message, {
      code: "ERR_CODEPIPELINE_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
