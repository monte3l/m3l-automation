/**
 * `aws/s3/error` — typed error for S3 object-operation failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LS3OperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LS3OperationErrorOptions {
  /**
   * The underlying cause: the raw AWS SDK command rejection. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
  /** Structured diagnostics — e.g. the bucket and key attempted. */
  readonly context?: Record<string, unknown>;
}

/**
 * Thrown by every `aws/s3` operation (`listObjects`, `headObject`,
 * `getObject`, `putObject`, `copyObject`, `deleteObject`, `deleteObjects`)
 * when the underlying AWS SDK command rejects.
 *
 * The originating SDK error is chained via `cause`, so callers can narrow on
 * `code === "ERR_S3_OPERATION"` and inspect `error.cause` for the root
 * failure — the same pattern as {@link M3LDynamoDBOperationError} and
 * {@link M3LSQSOperationError}.
 *
 * @example
 * ```ts
 * import { M3LS3OperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   // ... send an S3 command ...
 * } catch (cause) {
 *   throw new M3LS3OperationError("getObject failed", {
 *     cause,
 *     context: { bucket: "reports", key: "2026/07/summary.json" },
 *   });
 * }
 * ```
 */
export class M3LS3OperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_S3_OPERATION"`. */
  override readonly code = "ERR_S3_OPERATION" as const;

  /**
   * Creates a new `M3LS3OperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always `"ERR_S3_OPERATION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LS3OperationErrorOptions) {
    super(message, {
      code: "ERR_S3_OPERATION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
