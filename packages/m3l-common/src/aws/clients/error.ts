/**
 * `aws/clients/error` — typed error for AWS SDK client construction and
 * credential-resolution failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LAWSClientError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LAWSClientErrorOptions {
  /**
   * The underlying cause: the raw SDK constructor throw or a `fromIni`
   * credential-resolution failure. Explicitly widened to include
   * `undefined` (rather than only being optional) so callers that carry a
   * `unknown | undefined`-typed cause can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link AWSClientProvider} when an AWS SDK v3 client cannot be
 * constructed, or when credential resolution via `fromIni` fails.
 *
 * The originating SDK error is chained via `cause`, so callers can narrow
 * on `code === "ERR_AWS_CLIENT"` and inspect `error.cause` for the root
 * failure. `cause` may carry raw SDK internals; this class does not redact
 * it — as with the rest of the {@link M3LError} hierarchy, redaction before
 * persistence or transmission is delegated to the logging sink via
 * `toJSON`.
 *
 * @example
 * ```ts
 * import { M3LAWSClientError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   // ... construct an AWS SDK client ...
 * } catch (cause) {
 *   throw new M3LAWSClientError("failed to construct S3Client", { cause });
 * }
 * ```
 */
export class M3LAWSClientError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AWS_CLIENT"`. */
  override readonly code = "ERR_AWS_CLIENT" as const;

  /**
   * Creates a new `M3LAWSClientError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK or credential-resolution failure. The error code is always
   *   `"ERR_AWS_CLIENT"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAWSClientErrorOptions) {
    super(message, {
      code: "ERR_AWS_CLIENT",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
