/**
 * `core/errors/codes` — the built-in machine-readable error-code vocabulary.
 *
 * {@link M3L_ERROR_CODES} and the {@link M3LErrorCode} union derived from it
 * live in their own module rather than inside `M3LError.ts` so that file stays
 * under the 25,000-byte `check:file-budget` ceiling. Adding a code grows this
 * file instead of the error-hierarchy module, so the vocabulary can keep
 * expanding without re-litigating the file-budget ratchet. Keeping the tuple
 * here also lets `catalog.ts` depend on the vocabulary without importing the
 * module that imports it back.
 *
 * @packageDocumentation
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
  "ERR_AGENT_DECISION_LOG_WRITE",
  "ERR_AGENT_INVALID_ACTION",
  "ERR_AGENT_POLICY_DECLARATION",
  "ERR_ANALYSIS_INVALID_RULE",
  "ERR_APPEND_ONLY_STREAM_WRITE",
  "ERR_ATHENA_QUERY_FAILED",
  "ERR_ATHENA_START_QUERY",
  "ERR_ATHENA_TEMPLATE_COMPILE",
  "ERR_AWS_CLIENT",
  "ERR_AWS_CREDENTIALS",
  "ERR_AWS_INVALID_PROFILE",
  "ERR_AWS_INVALID_REGION",
  "ERR_AWS_PROVISIONING",
  "ERR_BEDROCK_RUNTIME_MODEL",
  "ERR_BEDROCK_RUNTIME_NO_MODEL",
  "ERR_BEDROCK_RUNTIME_OPERATION",
  "ERR_BEDROCK_RUNTIME_STREAM",
  "ERR_BEDROCK_RUNTIME_TOOL_LOOP",
  "ERR_BINARY_FILE_EXPORT",
  "ERR_CHECKPOINT_CORRUPT",
  "ERR_CHECKPOINT_DEFINITION",
  "ERR_CHECKPOINT_FINGERPRINT_MISMATCH",
  "ERR_CHECKPOINT_IO",
  "ERR_CHECKPOINT_MISSING",
  "ERR_CHECKPOINT_PARSE",
  "ERR_CLOUDFORMATION_OPERATION",
  "ERR_CLOUDWATCH_ALARMS_OPERATION",
  "ERR_CLOUDWATCH_METRICS_OPERATION",
  "ERR_CODEPIPELINE_OPERATION",
  "ERR_CONFIG_COERCION",
  "ERR_CONFIG_MISSING",
  "ERR_CONFIG_MODULE_INVALID",
  "ERR_CONFIG_MODULE_NOT_FOUND",
  "ERR_CONFIG_PARSE",
  "ERR_CONFIG_UNSAFE_KEY",
  "ERR_CONFIG_VALIDATION",
  "ERR_CSV_EXPORT",
  "ERR_DYNAMODB_OPERATION",
  "ERR_ECS_OPERATION",
  "ERR_EKS_OPERATION",
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
  "ERR_LAMBDA_OPERATION",
  "ERR_LOGS_INSIGHTS_QUERY_FAILED",
  "ERR_LOGS_INSIGHTS_START_QUERY",
  "ERR_LOG_TABLE_ALIGN",
  "ERR_LOG_TABLE_BORDER",
  "ERR_NO_PROGRESS",
  "ERR_OPERATION_ABORTED",
  "ERR_PATH_RESOLUTION",
  "ERR_PIPELINE_DUPLICATE_OPERATION",
  "ERR_PIPELINE_EMPTY_OPERATIONS",
  "ERR_PIPELINE_INVALID_OPTION",
  "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
  "ERR_POLLING_INVALID_OPTION",
  "ERR_POLL_EXHAUSTED",
  "ERR_POLL_FAILURE",
  "ERR_PRESET_CYCLE",
  "ERR_PRESET_LOAD",
  "ERR_PRESET_TOO_DEEP",
  "ERR_PRESET_UNKNOWN_KEYS",
  "ERR_PROCEDURE_CONDITION_TOO_DEEP",
  "ERR_PROCEDURE_CYCLE_DETECTED",
  "ERR_PROCEDURE_DUPLICATE_CASE_ID",
  "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
  "ERR_PROCEDURE_DUPLICATE_STEP_ID",
  "ERR_PROCEDURE_EMPTY_STEPS",
  "ERR_PROCEDURE_INVALID_DECLARATION",
  "ERR_PROCEDURE_INVALID_DEFINITION",
  "ERR_PROCEDURE_INVALID_JUMP_TARGET",
  "ERR_PROCEDURE_INVALID_OPTION",
  "ERR_PROCEDURE_INVALID_PATTERN",
  "ERR_PROCEDURE_ITERATION_LIMIT",
  "ERR_PROCEDURE_MISSING_FALLBACK",
  "ERR_PROCEDURE_NO_PROGRESS",
  "ERR_PROCEDURE_UNDECLARED_JUMP",
  "ERR_PROCEDURE_UNKNOWN_REFERENCE",
  "ERR_PROMPT_VALIDATION",
  "ERR_RDS_DATA_OPERATION",
  "ERR_RDS_DATA_RESULT_TOO_LARGE",
  "ERR_S3_OPERATION",
  "ERR_SECRETS_MANAGER_OPERATION",
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
