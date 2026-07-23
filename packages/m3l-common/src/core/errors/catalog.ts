/**
 * `core/errors/catalog` — the fault-origin classification for every built-in
 * {@link M3LErrorCode}.
 *
 * ADR-0035 phase 1 introduces this catalog; phase 2 built on top of it by
 * adding `origin`/`retryable` fields directly to `M3LError`, defaulted from
 * this catalog's classification for the instance's `code` (see
 * `docs/reference/core/errors.md`'s "Fault origin" section).
 * {@link M3LErrorOrigin} is defined here, not in `M3LError.ts`, precisely so
 * `M3LError.ts` can import it without this module depending on that one.
 *
 * @packageDocumentation
 */

import type { M3LErrorCode } from "./M3LError.js";

/**
 * Who must act to fix a failure classified under this origin.
 *
 * - `"caller"` — the script/config author (bad config, invalid argument, API
 *   misuse). Re-running without a fix cannot succeed.
 * - `"external"` — an external system (AWS, HTTP, remote job state,
 *   unreadable input data).
 * - `"library"` — an internal invariant violation — a bug in
 *   `@m3l-automation/m3l-common` itself. No built-in code is classified this
 *   way today; it is reserved for internal invariant violations, which have
 *   no stable dedicated codes by definition.
 *
 * @example
 * ```ts
 * import type { M3LErrorOrigin } from "@m3l-automation/m3l-common/core";
 *
 * function describe(origin: M3LErrorOrigin): string {
 *   return origin === "caller" ? "fix your config" : "retry or escalate";
 * }
 * ```
 */
export type M3LErrorOrigin = "caller" | "library" | "external";

/**
 * Whether re-running the failed operation without changes can plausibly
 * succeed.
 *
 * `"situational"` means it depends on the terminal status or context carried
 * by the specific instance (e.g. an Athena query that reached a `FAILED`
 * status is not retryable, but one that failed on a transient status-poll
 * error is).
 *
 * @remarks
 * `"situational"` is a **truthy** string — `if (retryable)` treats it the
 * same as `true`, which is almost never the intended check. Callers MUST
 * test `retryable === true` for "definitely safe to retry without further
 * inspection"; anything else (including `"situational"`) means "inspect the
 * instance before deciding." `ERR_ATHENA_QUERY_FAILED` is the concrete
 * example: an instance whose query reached a terminal `FAILED` status is
 * **not** retryable even though its catalog entry is `"situational"` — only
 * inspecting the instance (not the catalog classification alone) can tell
 * you that.
 *
 * @example
 * ```ts
 * import type { M3LErrorRetryable } from "@m3l-automation/m3l-common/core";
 *
 * function isDefinitelyRetryable(value: M3LErrorRetryable): boolean {
 *   return value === true;
 * }
 * ```
 */
export type M3LErrorRetryable = boolean | "situational";

/**
 * The fault-origin classification attached to a built-in error code.
 *
 * @example
 * ```ts
 * import type { M3LErrorClassification } from "@m3l-automation/m3l-common/core";
 *
 * const classification: M3LErrorClassification = {
 *   origin: "caller",
 *   retryable: false,
 * };
 * ```
 */
export interface M3LErrorClassification {
  /** Who must act to fix the failure. */
  readonly origin: M3LErrorOrigin;
  /** Whether re-running without changes can plausibly succeed. */
  readonly retryable: M3LErrorRetryable;
}

/**
 * The fault-origin classification for every built-in {@link M3LErrorCode}.
 *
 * This is deliberately annotated with an explicit `Readonly<Record<...>>`
 * type rather than `as const`: a code added to `M3L_ERROR_CODES` without a
 * corresponding row here fails to satisfy `Record<M3LErrorCode, ...>` and is
 * a **compile** error, not a silent runtime gap.
 *
 * Transcribed from the authoritative table in `docs/reference/core/errors.md`
 * (ADR-0035 phase 1). No built-in code is classified `"library"` — the
 * built-in surface is strictly caller/external.
 *
 * @example
 * ```ts
 * import { M3L_ERROR_CATALOG } from "@m3l-automation/m3l-common/core";
 *
 * const classification = M3L_ERROR_CATALOG.ERR_CONFIG_MISSING;
 * console.log(classification.origin); // "caller"
 * ```
 */
export const M3L_ERROR_CATALOG: Readonly<
  Record<M3LErrorCode, M3LErrorClassification>
> = {
  ERR_ANALYSIS_INVALID_RULE: { origin: "caller", retryable: false },
  ERR_ATHENA_QUERY_FAILED: { origin: "external", retryable: "situational" },
  ERR_ATHENA_START_QUERY: { origin: "external", retryable: true },
  ERR_AWS_CLIENT: { origin: "external", retryable: true },
  ERR_AWS_CREDENTIALS: { origin: "external", retryable: false },
  ERR_AWS_INVALID_PROFILE: { origin: "caller", retryable: false },
  ERR_AWS_INVALID_REGION: { origin: "caller", retryable: false },
  ERR_AWS_PROVISIONING: { origin: "external", retryable: false },
  ERR_BINARY_FILE_EXPORT: { origin: "external", retryable: false },
  ERR_CONFIG_COERCION: { origin: "caller", retryable: false },
  ERR_CONFIG_MISSING: { origin: "caller", retryable: false },
  ERR_CONFIG_PARSE: { origin: "caller", retryable: false },
  ERR_CONFIG_UNSAFE_KEY: { origin: "external", retryable: false },
  ERR_CONFIG_VALIDATION: { origin: "caller", retryable: false },
  ERR_CSV_EXPORT: { origin: "external", retryable: false },
  ERR_DYNAMODB_OPERATION: { origin: "external", retryable: true },
  ERR_ENVIRONMENT_DETECTION: { origin: "external", retryable: false },
  ERR_EVENTBRIDGE_OPERATION: { origin: "external", retryable: true },
  ERR_FILE_COPY: { origin: "external", retryable: false },
  ERR_FILE_EXPORT: { origin: "external", retryable: false },
  ERR_FILE_LIST_EXPORT: { origin: "external", retryable: false },
  ERR_FTS_CORRUPT_METADATA: { origin: "external", retryable: false },
  ERR_FTS_INVALID_DOCUMENT: { origin: "caller", retryable: false },
  ERR_FTS_INVALID_IDENTIFIER: { origin: "caller", retryable: false },
  ERR_FTS_INVALID_LIMIT: { origin: "caller", retryable: false },
  ERR_FTS_INVALID_MODE: { origin: "caller", retryable: false },
  ERR_FTS_INVALID_TOKENIZER: { origin: "caller", retryable: false },
  ERR_FTS_UNKNOWN_FILTER_COLUMN: { origin: "caller", retryable: false },
  ERR_HTML_LIST_EXPORT: { origin: "external", retryable: false },
  ERR_HTTP_REQUEST: { origin: "external", retryable: true },
  ERR_IMPORT_PARSE: { origin: "external", retryable: false },
  ERR_IMPORT_SOURCE: { origin: "external", retryable: false },
  ERR_IMPORT_VALIDATION: { origin: "external", retryable: false },
  ERR_INVALID_ARGUMENT: { origin: "caller", retryable: false },
  ERR_JSON_DETECT_DEPTH: { origin: "external", retryable: false },
  ERR_JSON_DETECT_READ: { origin: "external", retryable: false },
  ERR_JSON_FILE_EXPORT: { origin: "external", retryable: false },
  ERR_JSON_INVALID_CONFIDENCE: { origin: "external", retryable: false },
  ERR_JSON_LIST_EXPORT: { origin: "external", retryable: false },
  ERR_LAMBDA_OPERATION: { origin: "external", retryable: true },
  ERR_LOGS_INSIGHTS_QUERY_FAILED: {
    origin: "external",
    retryable: "situational",
  },
  ERR_LOGS_INSIGHTS_START_QUERY: { origin: "external", retryable: true },
  ERR_LOG_TABLE_ALIGN: { origin: "caller", retryable: false },
  ERR_LOG_TABLE_BORDER: { origin: "caller", retryable: false },
  ERR_PATH_RESOLUTION: { origin: "external", retryable: false },
  ERR_POLLING_INVALID_OPTION: { origin: "caller", retryable: false },
  ERR_POLL_EXHAUSTED: { origin: "external", retryable: true },
  ERR_POLL_FAILURE: { origin: "external", retryable: false },
  ERR_PRESET_CYCLE: { origin: "caller", retryable: false },
  ERR_PRESET_LOAD: { origin: "caller", retryable: false },
  ERR_PRESET_TOO_DEEP: { origin: "caller", retryable: false },
  ERR_PRESET_UNKNOWN_KEYS: { origin: "caller", retryable: false },
  ERR_PROMPT_VALIDATION: { origin: "caller", retryable: false },
  ERR_S3_OPERATION: { origin: "external", retryable: true },
  ERR_SIGNING_FAILURE: { origin: "external", retryable: false },
  ERR_SQS_OPERATION: { origin: "external", retryable: true },
  ERR_TEXT_EXTRACTION: { origin: "external", retryable: false },
  ERR_TEXT_EXTRACTION_MISSING_DEP: { origin: "external", retryable: false },
  ERR_TEXT_EXTRACTION_UNSUPPORTED: { origin: "caller", retryable: false },
  M3L_MESSAGING_NO_READER: { origin: "caller", retryable: false },
  M3L_MESSAGING_NO_TARGET: { origin: "caller", retryable: false },
  PROMISE_REJECTED: { origin: "external", retryable: true },
  RESULT_UNWRAP_ON_ERR: { origin: "caller", retryable: false },
  WRAPPED_ERROR: { origin: "external", retryable: "situational" },
};

/**
 * Type guard narrowing a raw string to a known built-in {@link M3LErrorCode}
 * — one already registered as a key of {@link M3L_ERROR_CATALOG}.
 *
 * Uses `Object.hasOwn` rather than a bare index/`in` lookup so a caller
 * passing a prototype-method name (`"toString"`, `"constructor"`,
 * `"__proto__"`, `"hasOwnProperty"`) — or any other string that happens to
 * collide with an inherited `Object.prototype` member — reliably narrows to
 * `false` instead of matching an inherited (non-classification) value.
 *
 * Never throws.
 *
 * @param code - Any string, typically an {@link M3LError}'s `code` field.
 * @returns `true` when `code` is a known built-in {@link M3LErrorCode}.
 *
 * @example
 * ```ts
 * import { isM3LErrorCode } from "@m3l-automation/m3l-common/core";
 *
 * isM3LErrorCode("ERR_S3_OPERATION"); // true
 * isM3LErrorCode("not-a-real-code"); // false
 * ```
 */
export function isM3LErrorCode(code: string): code is M3LErrorCode {
  return Object.hasOwn(M3L_ERROR_CATALOG, code);
}

/**
 * Looks up the fault-origin classification for a raw code string.
 *
 * Never throws.
 *
 * @param code - Any string, typically an {@link M3LError}'s `code` field.
 * @returns The classification for a known built-in code, or `undefined`.
 *
 * @example
 * ```ts
 * import { classifyErrorCode } from "@m3l-automation/m3l-common/core";
 *
 * const classification = classifyErrorCode("ERR_S3_OPERATION");
 * if (classification?.retryable === true) {
 *   // safe to retry without inspecting the instance further
 * }
 * ```
 */
export function classifyErrorCode(
  code: string,
): M3LErrorClassification | undefined {
  return isM3LErrorCode(code) ? M3L_ERROR_CATALOG[code] : undefined;
}
