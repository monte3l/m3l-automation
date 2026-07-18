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
/**
 * The exhaustive set of built-in machine-readable error codes the library
 * itself emits: one literal per `M3LError` subclass's pinned `code`, plus the
 * utility codes attached by the `errors` helpers (`wrapError`'s default
 * `"WRAPPED_ERROR"`, `unwrap`'s `"RESULT_UNWRAP_ON_ERR"`, and
 * `fromPromise`'s `"PROMISE_REJECTED"`).
 *
 * This `as const` tuple is the runtime source of truth {@link M3LErrorCode}
 * derives from — sorted alphabetically so a source-scan completeness test in
 * `tests/errors.test.ts` can diff it against every literal `code` actually
 * used under `src/**\/*.ts` and fail loudly on drift in either direction (a
 * missing code, or a stale one no longer emitted).
 *
 * @remarks
 * Update this tuple whenever a new built-in `M3LError` subclass (or utility
 * code) is added or removed — both the drift/completeness guard test (named
 * "every exported M3LError subclass's code is a member of M3LErrorCode") and
 * the source-scan completeness test in `tests/errors.test.ts` fail at
 * typecheck/test time if this list falls out of sync with the source.
 *
 * @example
 * ```ts
 * import { M3L_ERROR_CODES } from "@m3l-automation/m3l-common/core";
 *
 * function isKnownCode(code: string): boolean {
 *   return (M3L_ERROR_CODES as readonly string[]).includes(code);
 * }
 * ```
 */
export const M3L_ERROR_CODES = [
  "ERR_ANALYSIS_INVALID_RULE",
  "ERR_ATHENA_QUERY_FAILED",
  "ERR_ATHENA_START_QUERY",
  "ERR_AWS_CLIENT",
  "ERR_AWS_CREDENTIALS",
  "ERR_AWS_INVALID_PROFILE",
  "ERR_AWS_INVALID_REGION",
  "ERR_AWS_PROVISIONING",
  "ERR_BINARY_FILE_EXPORT",
  "ERR_CONFIG_COERCION",
  "ERR_CONFIG_MISSING",
  "ERR_CONFIG_PARSE",
  "ERR_CONFIG_UNSAFE_KEY",
  "ERR_CONFIG_VALIDATION",
  "ERR_CSV_EXPORT",
  "ERR_DYNAMODB_OPERATION",
  "ERR_ENVIRONMENT_DETECTION",
  "ERR_EVENTBRIDGE_OPERATION",
  "ERR_FILE_COPY",
  "ERR_FILE_EXPORT",
  "ERR_FILE_LIST_EXPORT",
  "ERR_FTS_CORRUPT_METADATA",
  "ERR_FTS_INVALID_DOCUMENT",
  "ERR_FTS_INVALID_IDENTIFIER",
  "ERR_FTS_INVALID_LIMIT",
  "ERR_FTS_INVALID_MODE",
  "ERR_FTS_INVALID_TOKENIZER",
  "ERR_FTS_UNKNOWN_FILTER_COLUMN",
  "ERR_HTML_LIST_EXPORT",
  "ERR_HTTP_REQUEST",
  "ERR_IMPORT_PARSE",
  "ERR_IMPORT_SOURCE",
  "ERR_IMPORT_VALIDATION",
  "ERR_INVALID_ARGUMENT",
  "ERR_JSON_DETECT_DEPTH",
  "ERR_JSON_DETECT_READ",
  "ERR_JSON_FILE_EXPORT",
  "ERR_JSON_INVALID_CONFIDENCE",
  "ERR_JSON_LIST_EXPORT",
  "ERR_LOGS_INSIGHTS_QUERY_FAILED",
  "ERR_LOGS_INSIGHTS_START_QUERY",
  "ERR_LOG_TABLE_ALIGN",
  "ERR_LOG_TABLE_BORDER",
  "ERR_PATH_RESOLUTION",
  "ERR_POLLING_INVALID_OPTION",
  "ERR_POLL_EXHAUSTED",
  "ERR_POLL_FAILURE",
  "ERR_PRESET_CYCLE",
  "ERR_PRESET_LOAD",
  "ERR_PRESET_TOO_DEEP",
  "ERR_PRESET_UNKNOWN_KEYS",
  "ERR_PROMPT_VALIDATION",
  "ERR_S3_OPERATION",
  "ERR_SIGNING_FAILURE",
  "ERR_SQS_OPERATION",
  "ERR_TEXT_EXTRACTION",
  "ERR_TEXT_EXTRACTION_MISSING_DEP",
  "ERR_TEXT_EXTRACTION_UNSUPPORTED",
  "M3L_MESSAGING_NO_READER",
  "M3L_MESSAGING_NO_TARGET",
  "PROMISE_REJECTED",
  "RESULT_UNWRAP_ON_ERR",
  "WRAPPED_ERROR",
] as const;

/**
 * The union of every built-in machine-readable error code the library itself
 * emits, derived from {@link M3L_ERROR_CODES}.
 *
 * `M3LError.code` itself stays typed `string` — a caller constructing a bare
 * `M3LError` (or a custom subclass) may supply any code they choose, and the
 * base class must not reject that. `M3LErrorCode` is additive vocabulary for
 * consumers who want to narrow on the codes this library actually produces,
 * with autocomplete and typo-protection at the call site.
 *
 * @remarks
 * This type derives from {@link M3L_ERROR_CODES}; update that tuple, not this
 * type alias, when a code is added or removed.
 *
 * @example
 * ```ts
 * import type { M3LErrorCode } from "@m3l-automation/m3l-common/core";
 *
 * function isRetryable(code: M3LErrorCode): boolean {
 *   return code === "ERR_POLL_EXHAUSTED" || code === "ERR_HTTP_REQUEST";
 * }
 * ```
 */
export type M3LErrorCode = (typeof M3L_ERROR_CODES)[number];

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
