/**
 * Typed error hierarchy for `@m3l-automation/m3l-common`.
 *
 * All library errors extend `M3LError` so callers can `catch (e)` and narrow
 * by `instanceof M3LError`, then further by `e.code` or a subclass check.
 * This keeps the error surface structured and avoids throwing bare strings.
 *
 * @packageDocumentation
 */

/**
 * Constructor options for {@link M3LError}.
 *
 * `code` is required; `context` and `cause` are optional enrichment fields.
 *
 * @example
 * ```ts
 * const opts: M3LErrorOptions = {
 *   code: "ERR_NOT_FOUND",
 *   context: { id: "user-42" },
 *   cause: new Error("db miss"),
 * };
 * ```
 */
export interface M3LErrorOptions {
  /** Machine-readable error code, e.g. `"ERR_NOT_FOUND"`. */
  readonly code: string;
  /**
   * Arbitrary key-value pairs for structured diagnostics.
   * Defaults to `{}` when omitted.
   */
  readonly context?: Record<string, unknown>;
  /**
   * The underlying cause of this error.
   * Typed `unknown` because any thrown value may be caught.
   */
  readonly cause?: unknown;
}

/**
 * Base error class for the `@m3l-automation/m3l-common` library.
 *
 * Extends the built-in `Error` with a mandatory machine-readable `code`,
 * an optional structured `context` bag, and proper cause-chaining via
 * `options.cause`. Subclasses automatically pick up their class name as
 * `error.name` through `new.target.name`.
 *
 * @example
 * ```ts
 * class NotFoundError extends M3LError {}
 *
 * throw new NotFoundError("user not found", {
 *   code: "ERR_NOT_FOUND",
 *   context: { userId: "u-42" },
 *   cause: dbError,
 * });
 * ```
 */
export class M3LError extends Error {
  /** Machine-readable error code for programmatic handling. */
  readonly code: string;

  /** Structured diagnostic context attached to this error. */
  readonly context: Record<string, unknown>;

  /**
   * The underlying cause; typed `unknown` because any thrown value can be
   * caught and wrapped.
   */
  override readonly cause: unknown;

  /**
   * Creates a new `M3LError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Required options bag carrying `code`, optional `context`,
   *   and optional `cause`.
   */
  constructor(message: string, options: M3LErrorOptions) {
    super(message);

    this.name = new.target.name;
    this.code = options.code;
    this.context = options.context ?? {};
    this.cause = options.cause;

    // Capture a clean stack trace, excluding the constructor frame.
    // Guard for environments (e.g. some test runners) that lack this V8 API.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Serialises the error to a plain record suitable for structured logging or
   * debugging. The result is JSON-serialisable only when `context` and `cause`
   * are themselves serialisable — circular references or non-serialisable
   * values in either field will cause `JSON.stringify` to throw, just as they
   * would on any plain object. Redacting or normalising the `cause` for
   * guaranteed serialisability is the responsibility of the logging layer,
   * not this method.
   *
   * @returns A plain record with `name`, `message`, `code`, `context`,
   *   `cause`, and `stack` — verbatim from the instance fields.
   */
  toJSON(): {
    name: string;
    message: string;
    code: string;
    context: Record<string, unknown>;
    cause: unknown;
    stack: string | undefined;
  } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      cause: this.cause,
      stack: this.stack,
    };
  }
}
