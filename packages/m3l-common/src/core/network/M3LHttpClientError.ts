/**
 * `core/network/M3LHttpClientError` — typed error thrown by
 * {@link M3LHttpClient} for every request failure (non-2xx status, network
 * failure, timeout, or manual abort).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LHttpClientError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_HTTP_REQUEST"` and is set automatically — callers must not supply it.
 */
interface M3LHttpClientErrorOptions {
  /**
   * Structured detail identifying the failed request, e.g. `url`, `status`,
   * and a `reason` discriminator (one of `"status"`, `"network"`,
   * `"timeout"`, or `"abort"`).
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LHttpClient} whenever a request does not complete
 * successfully: a non-2xx response, an underlying network failure, a
 * per-request timeout, or a manual `abort()`.
 *
 * Callers that need to distinguish an HTTP client failure from other
 * {@link M3LError} subclasses should catch this type specifically, then
 * branch on `context.reason` for the specific failure mode.
 *
 * @example
 * ```ts
 * import { M3LHttpClient, M3LHttpClientError } from "@m3l-automation/m3l-common/core";
 *
 * const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
 *
 * try {
 *   await client.get("/users/42");
 * } catch (error) {
 *   if (error instanceof M3LHttpClientError) {
 *     // error.context.reason is "status" | "network" | "timeout" | "abort"
 *   }
 *   throw error;
 * }
 * ```
 */
export class M3LHttpClientError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_HTTP_REQUEST"`. */
  override readonly code: "ERR_HTTP_REQUEST";

  /**
   * Creates a new `M3LHttpClientError`.
   *
   * @param message - Human-readable description of the request failure.
   * @param options - Optional options bag; `context` carries the failed
   *   request's URL, status (if any), and failure `reason`, and `cause`
   *   carries an underlying error if applicable. The error code is always
   *   `"ERR_HTTP_REQUEST"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LHttpClientErrorOptions) {
    super(message, {
      code: "ERR_HTTP_REQUEST",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_HTTP_REQUEST";
  }
}
