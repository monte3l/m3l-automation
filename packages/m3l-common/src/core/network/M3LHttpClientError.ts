/**
 * `core/network/M3LHttpClientError` — typed error thrown by
 * {@link M3LHttpClient} for every request failure (non-2xx status, network
 * failure, timeout, or manual abort).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Discriminates why a request ultimately failed. Carried on the typed
 * {@link M3LHttpClientError.reason} field.
 */
export type M3LHttpFailureReason = "status" | "network" | "timeout" | "abort";

/**
 * Constructor options for {@link M3LHttpClientError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_HTTP_REQUEST"` and is set automatically — callers must not supply it.
 * `reason` is required and `status` is only meaningful for the `"status"`
 * reason.
 */
interface M3LHttpClientErrorOptions {
  /** Discriminates the specific failure mode this error represents. */
  readonly reason: M3LHttpFailureReason;
  /** The response status code, present only when `reason` is `"status"`. */
  readonly status?: number;
  /**
   * Structured detail identifying the failed request, e.g. `url`. Does not
   * carry `reason`/`status` — those are typed own fields on the error.
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
 * branch on the typed `reason` field for the specific failure mode.
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
 *     // error.reason is "status" | "network" | "timeout" | "abort"
 *     // error.status is only set when error.reason === "status"
 *   }
 *   throw error;
 * }
 * ```
 */
export class M3LHttpClientError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_HTTP_REQUEST"`. */
  override readonly code: "ERR_HTTP_REQUEST";
  /** Discriminates why the request failed. Always present. */
  readonly reason: M3LHttpFailureReason;
  /** The response status code. Only present when `reason` is `"status"`. */
  readonly status?: number;

  /**
   * Creates a new `M3LHttpClientError`.
   *
   * @param message - Human-readable description of the request failure.
   * @param options - Options bag; `reason` is required, `status` applies only
   *   to the `"status"` reason, `context` carries the failed request's URL,
   *   and `cause` carries an underlying error if applicable. The error code
   *   is always `"ERR_HTTP_REQUEST"` — it cannot be overridden.
   */
  constructor(message: string, options: M3LHttpClientErrorOptions) {
    super(message, {
      code: "ERR_HTTP_REQUEST",
      ...(options.context !== undefined && { context: options.context }),
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_HTTP_REQUEST";
    this.reason = options.reason;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
