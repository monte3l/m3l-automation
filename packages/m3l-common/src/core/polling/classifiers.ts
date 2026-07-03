/**
 * `core/polling/classifiers` — composable, pure {@link M3LRetryClassifier}
 * functions plus the built-in AWS and HTTP classifiers.
 *
 * Every classifier accepts `unknown` and never throws on a foreign value; each
 * built-in returns `"unknown"` for anything outside its narrow concern, so they
 * combine without overlap via {@link combineClassifiers}.
 *
 * @packageDocumentation
 */

import type {
  M3LRetryAdvice,
  M3LRetryClassifier,
  M3LRetryDecision,
} from "./M3LRetryRunner.js";

/**
 * Canonical AWS throttling / rate-limit error names (16), matched
 * case-sensitively against `err.name` or `err.Code`.
 */
const AWS_THROTTLING_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "Throttling",
  "ThrottledException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "RequestThrottled",
  "RequestThrottledException",
  "ProvisionedThroughputExceededException",
  "TransactionInProgressException",
  "SlowDown",
  "PriorRequestNotComplete",
  "BandwidthLimitExceeded",
  "LimitExceededException",
  "EC2ThrottledException",
  "RequestTimeout",
  "RequestTimeoutException",
]);

/** HTTP 429 Too Many Requests — the canonical rate-limit response. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** HTTP 400 Bad Request. */
const HTTP_BAD_REQUEST = 400;

/** HTTP 401 Unauthorized. */
const HTTP_UNAUTHORIZED = 401;

/** HTTP 403 Forbidden. */
const HTTP_FORBIDDEN = 403;

/** HTTP 404 Not Found. */
const HTTP_NOT_FOUND = 404;

/** HTTP 500 Internal Server Error. */
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** HTTP 502 Bad Gateway. */
const HTTP_BAD_GATEWAY = 502;

/** HTTP 503 Service Unavailable. */
const HTTP_SERVICE_UNAVAILABLE = 503;

/** HTTP 504 Gateway Timeout. */
const HTTP_GATEWAY_TIMEOUT = 504;

/** Transient HTTP 5xx status codes treated as retriable. */
const TRANSIENT_5XX: ReadonlySet<number> = new Set([
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_BAD_GATEWAY,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_GATEWAY_TIMEOUT,
]);

/** Recognisable non-retriable HTTP client-error statuses. */
const FATAL_HTTP_STATUS: ReadonlySet<number> = new Set([
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
]);

/**
 * Network-level transient error codes / names matched against `err.code` or
 * `err.name`.
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "EADDRINUSE",
  "TimeoutError",
]);

/** Safely read a string-valued property from an unknown value. */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : undefined;
}

/** Safely read a number-valued property from an unknown value. */
function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : undefined;
}

/** Extract an HTTP status code from the common shapes AWS/HTTP errors use. */
function readHttpStatus(value: unknown): number | undefined {
  const direct = readNumber(value, "status") ?? readNumber(value, "statusCode");
  if (direct !== undefined) return direct;
  if (typeof value === "object" && value !== null) {
    const metadata = (value as Record<string, unknown>).$metadata;
    return readNumber(metadata, "httpStatusCode");
  }
  return undefined;
}

/**
 * Compose several classifiers into one. They are consulted in order and the
 * first non-`"unknown"` decision wins; if all abstain, the result is
 * `"unknown"`. The returned classifier is pure and never throws.
 *
 * @param classifiers - Classifiers to consult, in priority order.
 * @returns A single combined {@link M3LRetryClassifier}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common/core";
 *
 * const classifier = Core.combineClassifiers(
 *   Core.awsThrottlingClassifier,
 *   Core.awsNetworkClassifier,
 *   Core.httpRetryAfterClassifier,
 * );
 * ```
 */
export function combineClassifiers(
  ...classifiers: readonly M3LRetryClassifier[]
): M3LRetryClassifier {
  return (err: unknown): M3LRetryDecision | M3LRetryAdvice => {
    for (const classify of classifiers) {
      const result = classify(err);
      const decision = typeof result === "string" ? result : result.decision;
      if (decision !== "unknown") return result;
    }
    return "unknown";
  };
}

/**
 * Detects AWS throttling / rate-limit errors by name or `$metadata`, plus
 * transient 5xx statuses, mapping them to `"retriable"`. Everything else is
 * `"unknown"` (never `"fatal"`), so it composes cleanly with other classifiers.
 *
 * @param err - The thrown value (any shape).
 * @returns `"retriable"` for a recognised throttle, otherwise `"unknown"`.
 */
export const awsThrottlingClassifier: M3LRetryClassifier = (
  err: unknown,
): M3LRetryDecision => {
  const name = readString(err, "name") ?? readString(err, "Code");
  if (name !== undefined && AWS_THROTTLING_NAMES.has(name)) return "retriable";

  const status = readHttpStatus(err);
  if (status !== undefined && TRANSIENT_5XX.has(status)) return "retriable";

  return "unknown";
};

/**
 * Detects network-level transient errors (connection resets, timeouts, DNS
 * failures) by `err.code` or `err.name`, mapping them to `"retriable"`.
 * Everything else is `"unknown"`.
 *
 * @param err - The thrown value (any shape).
 * @returns `"retriable"` for a recognised network fault, otherwise `"unknown"`.
 */
export const awsNetworkClassifier: M3LRetryClassifier = (
  err: unknown,
): M3LRetryDecision => {
  const code = readString(err, "code") ?? readString(err, "name");
  if (code !== undefined && NETWORK_CODES.has(code)) return "retriable";
  return "unknown";
};

/**
 * Maps HTTP status codes to retry decisions: `429` and transient 5xx
 * (500/502/503/504) are `"retriable"`; recognisable non-retriable statuses
 * (400/401/403/404) are `"fatal"`; anything without a recognisable HTTP status
 * is `"unknown"`. When the error carries `retryAfterMs`, a retriable verdict
 * includes it as a `delayMs` override so the server drives the backoff.
 *
 * @param err - The thrown value (any shape).
 * @returns A decision or, for a rate-limited response carrying `retryAfterMs`,
 *   a {@link M3LRetryAdvice} with `delayMs`.
 */
export const httpRetryAfterClassifier: M3LRetryClassifier = (
  err: unknown,
): M3LRetryDecision | M3LRetryAdvice => {
  const status = readHttpStatus(err);
  if (status === undefined) return "unknown";

  const retriable =
    status === HTTP_TOO_MANY_REQUESTS || TRANSIENT_5XX.has(status);
  if (retriable) {
    const retryAfterMs = readNumber(err, "retryAfterMs");
    if (retryAfterMs !== undefined) {
      return { decision: "retriable", delayMs: retryAfterMs };
    }
    return "retriable";
  }

  if (FATAL_HTTP_STATUS.has(status)) return "fatal";
  return "unknown";
};
