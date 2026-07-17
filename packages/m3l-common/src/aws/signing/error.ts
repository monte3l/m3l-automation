/**
 * `aws/signing/error` — typed error for SigV4 request-signing failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LSigningError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LSigningErrorOptions {
  /**
   * The underlying cause: a malformed-URL parse failure, or the raw SigV4
   * `sign()` rejection (most commonly a credential-resolution failure).
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LRequestSigner.signedHeaders} when signing fails: the
 * request URL is malformed, or the underlying SigV4 signing rejects — most
 * commonly a credential-resolution failure surfaced when the lazily-resolved
 * credential provider is first invoked.
 *
 * @example
 * ```ts
 * import { M3LSigningError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await signer.signedHeaders(request);
 * } catch (error) {
 *   if (error instanceof M3LSigningError) {
 *     // error.cause carries the underlying parse/signing failure
 *   }
 * }
 * ```
 */
export class M3LSigningError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_SIGNING_FAILURE"`. */
  override readonly code = "ERR_SIGNING_FAILURE" as const;

  /**
   * Creates a new `M3LSigningError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   parse or signing failure. The error code is always
   *   `"ERR_SIGNING_FAILURE"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LSigningErrorOptions) {
    super(message, {
      code: "ERR_SIGNING_FAILURE",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
