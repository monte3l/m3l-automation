/**
 * `http/envelope` — maps a caught value to the REST error envelope
 * (ADR-0066) and its HTTP status.
 *
 * Only an {@link M3LConsoleError}'s own `message` ever reaches a caller.
 * Every other value — a foreign `Core.M3LError`, a plain `Error`, a string,
 * `null` — collapses to a fixed generic message: a library/SDK message can
 * carry a path, a bucket name, or a token fragment, and the operator gets
 * the envelope while the real error goes to `M3LLogger` separately
 * (ADR-0070's display-vs-persist split).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleErrorCode } from "../errors/console-error.js";
import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LConsoleResponse } from "./respond.js";
import { jsonResponse } from "./respond.js";

/** The fixed message every non-`M3LConsoleError` value collapses to. */
const GENERIC_MESSAGE = "An unexpected error occurred.";

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHENTICATED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_INTERNAL = 500;

/**
 * Per-code classification: the HTTP status every {@link M3LConsoleErrorCode}
 * maps to. A `Record` keyed by the full code union — rather than a lookup
 * with a default — forces a compile error the moment a new
 * `M3LConsoleErrorCode` is added without an explicit status decision for it
 * (the same exhaustiveness trick as `packages/m3l-cli/src/cli/errors.ts`).
 */
const STATUS_BY_CODE: Record<M3LConsoleErrorCode, number> = {
  ERR_CONSOLE_BAD_REQUEST: STATUS_BAD_REQUEST,
  ERR_CONSOLE_UNAUTHENTICATED: STATUS_UNAUTHENTICATED,
  ERR_CONSOLE_NOT_FOUND: STATUS_NOT_FOUND,
  ERR_CONSOLE_METHOD_NOT_ALLOWED: STATUS_METHOD_NOT_ALLOWED,
  ERR_CONSOLE_CONFIG_INVALID: STATUS_INTERNAL,
  ERR_CONSOLE_INTERNAL: STATUS_INTERNAL,
  ERR_CONSOLE_ROUTE_CONFLICT: STATUS_INTERNAL,
  ERR_CONSOLE_DRAIN_FAILED: STATUS_INTERNAL,
  ERR_CONSOLE_LISTEN_FAILED: STATUS_INTERNAL,
};

/**
 * The REST error envelope body (ADR-0066). Never carries a stack trace or a
 * `cause` chain — only a code, a message safe to show an operator, the HTTP
 * status, the request's correlation id, and (when known) the error's
 * classification.
 *
 * @example
 * ```ts
 * const envelope: M3LConsoleErrorEnvelope = {
 *   error: {
 *     code: "ERR_CONSOLE_NOT_FOUND",
 *     message: "route not found",
 *     status: 404,
 *     correlationId: "corr-1",
 *   },
 * };
 * ```
 */
export interface M3LConsoleErrorEnvelope {
  readonly error: {
    /** The machine-readable error code. */
    readonly code: string;
    /** A message safe to show the operator — never a foreign error's own text. */
    readonly message: string;
    /** The HTTP status this error maps to. */
    readonly status: number;
    /** The request's correlation id, so a log line can be cross-referenced. */
    readonly correlationId: string;
    /** The error's classified origin, when known. */
    readonly origin?: Core.M3LErrorOrigin;
    /** The error's classified retryability, when known. */
    readonly retryable?: Core.M3LErrorRetryable;
  };
}

/**
 * Returns the HTTP status {@link M3LConsoleErrorCode} `code` maps to.
 *
 * @param code - The console error code.
 * @returns The mapped HTTP status.
 *
 * @example
 * ```ts
 * httpStatusForCode("ERR_CONSOLE_NOT_FOUND"); // 404
 * ```
 */
export function httpStatusForCode(code: M3LConsoleErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Builds the envelope's `error` field for an {@link M3LConsoleError}: its
 * own code and message, the mapped status, and the table's `origin`/
 * `retryable`, conditionally spread so an undefined field is never keyed at
 * all (`exactOptionalPropertyTypes`).
 */
function envelopeForConsoleError(
  error: M3LConsoleError,
  correlationId: string,
): M3LConsoleErrorEnvelope {
  const status = httpStatusForCode(error.code);
  return {
    error: {
      code: error.code,
      message: error.message,
      status,
      correlationId,
      ...(error.origin !== undefined && { origin: error.origin }),
      ...(error.retryable !== undefined && { retryable: error.retryable }),
    },
  };
}

/**
 * Builds the envelope's `error` field for any value that is not an
 * {@link M3LConsoleError}: a fixed status and generic message, never the
 * value's own text. For a foreign `Core.M3LError`, `Core.classifyErrorCode`
 * may still supply `origin`/`retryable` — nothing else about the foreign
 * error crosses the boundary.
 */
function envelopeForForeignValue(
  error: unknown,
  correlationId: string,
): M3LConsoleErrorEnvelope {
  const classification =
    error instanceof Core.M3LError
      ? Core.classifyErrorCode(error.code)
      : undefined;

  return {
    error: {
      code: "ERR_CONSOLE_INTERNAL",
      message: GENERIC_MESSAGE,
      status: STATUS_INTERNAL,
      correlationId,
      ...(classification?.origin !== undefined && {
        origin: classification.origin,
      }),
      ...(classification?.retryable !== undefined && {
        retryable: classification.retryable,
      }),
    },
  };
}

/**
 * Builds the {@link M3LConsoleErrorEnvelope} for a caught value.
 *
 * @param error - Any value caught while handling a request.
 * @param correlationId - The request's correlation id.
 * @returns The resulting envelope. Never carries a stack trace, a `cause`
 *   chain, or (for a non-`M3LConsoleError` value) the value's own message.
 *
 * @example
 * ```ts
 * const envelope = errorEnvelope(
 *   new M3LConsoleError("ERR_CONSOLE_NOT_FOUND", "route not found"),
 *   "corr-1",
 * );
 * ```
 */
export function errorEnvelope(
  error: unknown,
  correlationId: string,
): M3LConsoleErrorEnvelope {
  if (error instanceof M3LConsoleError) {
    return envelopeForConsoleError(error, correlationId);
  }
  return envelopeForForeignValue(error, correlationId);
}

/**
 * Builds the full {@link M3LConsoleResponse} for a caught value: the
 * envelope's status and its JSON-serialized body.
 *
 * @param error - Any value caught while handling a request.
 * @param correlationId - The request's correlation id.
 * @returns The resulting {@link M3LConsoleResponse}.
 *
 * @example
 * ```ts
 * import type { ServerResponse } from "node:http";
 *
 * function reply(res: ServerResponse, error: unknown, correlationId: string): void {
 *   const response = errorResponse(error, correlationId);
 *   res.writeHead(response.status);
 *   res.end(response.body);
 * }
 * ```
 */
export function errorResponse(
  error: unknown,
  correlationId: string,
): M3LConsoleResponse {
  const envelope = errorEnvelope(error, correlationId);
  return jsonResponse(envelope.error.status, envelope);
}
