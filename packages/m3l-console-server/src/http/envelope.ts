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
const STATUS_CONFLICT = 409;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL = 500;
const STATUS_UNAVAILABLE = 503;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;

/** The status/origin/retryable/fault decision for one {@link M3LConsoleErrorCode}. */
interface ErrorClassification {
  /** The HTTP status this code maps to. */
  readonly status: number;
  /** Whether the failure originates from the caller or this library. */
  readonly origin: Core.M3LErrorOrigin;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: Core.M3LErrorRetryable;
  /**
   * Whether this outcome is a genuine server fault worth an error-level
   * diagnostic line. Deliberately distinct from `origin`: a drain refusal is
   * `origin: "library"` (the caller did nothing wrong) yet is not a fault
   * (the server is shutting down as instructed), so gating the diagnostic
   * log on `origin` alone would emit an error-level line for every request
   * refused during an ordinary shutdown.
   *
   * `retryable` and `fault` diverge for two codes, in opposite directions.
   * `ERR_CONSOLE_UNAVAILABLE` is `retryable: true, fault: false` (a drain
   * refusal — expected shutdown, not a fault). `ERR_CONSOLE_STORE_BUSY` is
   * the second divergence, and it diverges the OTHER way: both `retryable`
   * and `fault` are `true`, because a `SQLITE_BUSY` that survived the
   * `node:sqlite` builtin's own busy handler means ADR-0069's single-writer
   * invariant is actually broken — genuinely retryable (a later attempt may
   * find the writer free again), and genuinely worth an error-level
   * diagnostic line, unlike an ordinary drain.
   */
  readonly fault: boolean;
}

/**
 * Per-code classification: the HTTP status, origin, and retryability every
 * {@link M3LConsoleErrorCode} maps to. A `Record` keyed by the full code
 * union — rather than a lookup with a default — forces a compile error the
 * moment a new `M3LConsoleErrorCode` is added without an explicit decision
 * for it (the same exhaustiveness trick as `packages/m3l-cli/src/cli/errors.ts`).
 *
 * `ERR_CONSOLE_*` is deliberately absent from `Core`'s own classification
 * catalog (see `errors/console-error.ts`), so `Core.classifyErrorCode` can
 * never supply these decisions — this table is the only source of truth for
 * an `M3LConsoleError`'s `origin`/`retryable`.
 */
const CLASSIFICATION_BY_CODE: Record<M3LConsoleErrorCode, ErrorClassification> =
  {
    ERR_CONSOLE_BAD_REQUEST: {
      status: STATUS_BAD_REQUEST,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_UNAUTHENTICATED: {
      status: STATUS_UNAUTHENTICATED,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_NOT_FOUND: {
      status: STATUS_NOT_FOUND,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_METHOD_NOT_ALLOWED: {
      status: STATUS_METHOD_NOT_ALLOWED,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_CONFIG_INVALID: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_INTERNAL: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_ROUTE_CONFLICT: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_DRAIN_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_LISTEN_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_UNAVAILABLE: {
      status: STATUS_UNAVAILABLE,
      origin: "library",
      retryable: true,
      fault: false,
    },
    ERR_CONSOLE_STORE_UNSUPPORTED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STORE_OPEN_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STORE_QUERY_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STORE_BUSY: {
      status: STATUS_UNAVAILABLE,
      origin: "library",
      retryable: true,
      fault: true,
    },
    ERR_CONSOLE_STORE_CLOSED: {
      status: STATUS_UNAVAILABLE,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STORE_MIGRATION_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STORE_SCHEMA_DRIFT: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    // Neither stream code is reachable from an HTTP request: the SSE route
    // only ever *subscribes* to an already-open stream, while
    // `open`/`publish` are called by `runs/`. A caller can never trigger
    // either, so both are genuine internal defects — `origin: "library"`,
    // `retryable: false`, `fault: true` — with none of the
    // caller-steerable-log-severity concern that makes `ERR_CONSOLE_UNAVAILABLE`
    // `fault: false`.
    ERR_CONSOLE_STREAM_CLOSED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_STREAM_DUPLICATE: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_RUN_NOT_FOUND: {
      status: STATUS_NOT_FOUND,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_RUN_TRANSITION_INVALID: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND: {
      status: STATUS_NOT_FOUND,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED: {
      status: STATUS_CONFLICT,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_RUN_CAPACITY_EXCEEDED: {
      status: STATUS_TOO_MANY_REQUESTS,
      origin: "caller",
      retryable: true,
      fault: false,
    },
    // `retryable: false` even though the run's state changed under the
    // caller: retrying a cancel against a run that already ended will get
    // the same 409 forever. The right next action is to read the run, not to
    // repeat the request.
    ERR_CONSOLE_RUN_NOT_CANCELLABLE: {
      status: STATUS_CONFLICT,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_BODY_TOO_LARGE: {
      status: STATUS_PAYLOAD_TOO_LARGE,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE: {
      status: STATUS_UNSUPPORTED_MEDIA_TYPE,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    // X6 workbench-sessions module, slice 1 (ADR-0068/ADR-0069). Unlike
    // ERR_CONSOLE_RUN_TRANSITION_INVALID (server-internal — only the run
    // orchestrator ever calls that transition), a session/step/decision
    // transition IS reachable directly from an HTTP caller in a later slice
    // (e.g. answering an already-answered decision, a double-submit race),
    // so ERR_CONSOLE_SESSION_TRANSITION_INVALID is caller-facing, not a
    // fault — see `errors/console-error.ts`'s own TSDoc for the full
    // rationale on all five codes below.
    ERR_CONSOLE_SESSION_NOT_FOUND: {
      status: STATUS_NOT_FOUND,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_SESSION_STEP_NOT_FOUND: {
      status: STATUS_NOT_FOUND,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_SESSION_TRANSITION_INVALID: {
      status: STATUS_CONFLICT,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_SESSION_CLOSED: {
      status: STATUS_CONFLICT,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    ERR_CONSOLE_SESSION_LIMIT_EXCEEDED: {
      status: STATUS_TOO_MANY_REQUESTS,
      origin: "caller",
      retryable: true,
      fault: false,
    },
    // X6 workbench-sessions module, slice 2 (ADR-0068). Malformed reference
    // text or a reference that no longer matches the data it names is
    // always caller-facing — see `errors/console-error.ts`'s own TSDoc.
    ERR_CONSOLE_SESSION_REFERENCE_INVALID: {
      status: STATUS_BAD_REQUEST,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    // X6 workbench-sessions module, slice 3. A payload that exceeds the
    // deployment's configured artifact/session cap is a caller-facing input
    // problem (the operation itself produced more data than this deployment
    // allows) — 413, non-retryable, not a fault.
    ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE: {
      status: STATUS_PAYLOAD_TOO_LARGE,
      origin: "caller",
      retryable: false,
      fault: false,
    },
    // A persisted artifact reference that can't be decoded, or a file-backed
    // artifact whose content no longer matches its recorded digest, means the
    // store or filesystem drifted from what this module itself wrote — an
    // internal fault, not a caller mistake.
    ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    // X10b console-server script discovery. A config module that resolved
    // (per `runs/catalog.ts`'s `resolveConfigModulePath` check) but then
    // fails to load its descriptors is a real server-side defect an
    // operator should see an error-level diagnostic for — not a caller
    // mistake.
    ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED: {
      status: STATUS_INTERNAL,
      origin: "library",
      retryable: false,
      fault: true,
    },
    // X7 human-action audit (ADR-0070). An action the console cannot audit
    // is refused, never performed unaudited — the trail may be writable again
    // on the next attempt, so this is a retryable 503, not a fault.
    ERR_CONSOLE_AUDIT_WRITE_FAILED: {
      status: STATUS_UNAVAILABLE,
      origin: "library",
      retryable: true,
      fault: false,
    },
    // X7 human-action audit (ADR-0070), the caller-fault half of the trail's
    // two codes. A record the console refuses to BUILD — a non-string list
    // entry, a non-scalar `detail` value, an `inline` ADR-0068 ref carrying
    // the parameter VALUE — is a caller mistake caught before any filesystem
    // call: retrying it changes nothing, and it is not a server fault.
    ERR_CONSOLE_AUDIT_RECORD_INVALID: {
      status: STATUS_BAD_REQUEST,
      origin: "caller",
      retryable: false,
      fault: false,
    },
  };

/**
 * The classification used when a caught {@link M3LConsoleError}'s `code`
 * falls outside {@link M3LConsoleErrorCode} at runtime (a value that defeats
 * the type system — e.g. a boundary that decoded an external value into this
 * class without validating it against the union first). Not a licence to
 * skip a table entry for a real code: {@link CLASSIFICATION_BY_CODE}'s
 * `Record` type still forces a compile error for that.
 */
const FALLBACK_CLASSIFICATION: ErrorClassification = {
  status: STATUS_INTERNAL,
  origin: "library",
  retryable: false,
  fault: true,
};

/**
 * Resolves the {@link ErrorClassification} for `code`, falling back to
 * {@link FALLBACK_CLASSIFICATION} when `code` is not an own key of
 * {@link CLASSIFICATION_BY_CODE} — which can only happen at runtime, for a
 * value that defeats the compile-time exhaustiveness check.
 *
 * Checks {@link Object.hasOwn} rather than `??`-ing the lookup: a `code` that
 * happens to name an inherited `Object.prototype` member (`"constructor"`,
 * `"toString"`, `"valueOf"`, `"__proto__"`) resolves to that prototype
 * function via plain bracket access, and a function is never `null`/
 * `undefined` — so `??` would never fire and this would return a
 * classification with an `undefined` `status`, which is exactly the
 * socket-hang {@link FALLBACK_CLASSIFICATION} exists to prevent.
 */
function classificationForCode(code: M3LConsoleErrorCode): ErrorClassification {
  return Object.hasOwn(CLASSIFICATION_BY_CODE, code)
    ? CLASSIFICATION_BY_CODE[code]
    : FALLBACK_CLASSIFICATION;
}

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
 * Returns `true` when `error` represents a genuine server fault worth an
 * error-level diagnostic line — i.e. when it is *not* an
 * {@link M3LConsoleError} whose {@link ErrorClassification.fault} is
 * `false`. Every other value (a foreign `Core.M3LError`, a plain `Error`, a
 * thrown non-`Error` value, `null`, or `undefined`) returns `true`.
 *
 * `fault` is deliberately a separate field from `origin`, not a synonym for
 * `origin !== "caller"`: `ERR_CONSOLE_UNAVAILABLE` is `origin: "library"`
 * (the caller did nothing wrong) yet `fault: false` (the server is
 * shutting down as instructed, not malfunctioning). Reimplementing this as
 * an `origin`-only check (comparing `origin` against `"library"` instead of
 * reading `fault`) would silently re-break the drain case: every request a
 * draining server refuses would once again log a spurious error-level
 * diagnostic line.
 *
 * `ERR_CONSOLE_STORE_BUSY` is the second code where `retryable` and `fault`
 * diverge, and it diverges the OTHER way from `ERR_CONSOLE_UNAVAILABLE`: a
 * drain refusal is `retryable: true, fault: false` (the server is shutting
 * down as instructed), whereas a `SQLITE_BUSY` that survived the `node:sqlite`
 * builtin's own busy handler means ADR-0069's single-writer invariant is
 * actually broken — genuinely retryable, and genuinely worth an error-level
 * diagnostic line, so it is `retryable: true, fault: true`.
 *
 * `http/handler` uses this to gate its diagnostic
 * {@link Core.M3LLogger.errorFrom} line (ADR-0070's display-vs-persist
 * split): a non-fault error already reads clearly from the outcome line's
 * status alone, so logging it again as a diagnostic would be noise and
 * would let a caller remotely steer log severity by choosing which routine
 * error to trigger.
 *
 * A THIRD, targeted exemption alongside the two above: an instance of
 * {@link Core.M3LOperationAbortedError} also returns `false`, even though it
 * is not an {@link M3LConsoleError} at all (every other non-`M3LConsoleError`
 * value is a fault, per the general rule below). `http/body.ts`'s
 * `readJsonBody` rejects with this exact error when its request's
 * `AbortSignal` fires mid-read, and that signal is always the composite of
 * the drain signal and the per-connection abort controller (see
 * `http/handler.ts`'s `beginRequest`) — so an abort here means either the
 * client disconnected or the server is draining, never a server defect.
 * Without this exemption, every ordinary mid-body client disconnect would
 * log a spurious "unhandled failure handling POST /api/v1/runs"-style
 * diagnostic line. This does NOT change what HTTP status the aborted
 * request's envelope carries (still the fixed generic-internal status
 * `envelopeForForeignValue` gives any non-`M3LConsoleError` value) — the
 * socket is already gone by the time that status would matter, so there is
 * nothing to re-map it to.
 *
 * @param error - Any value caught while handling a request.
 * @returns `true` when `error` is a genuine fault.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * isFaultError(
 *   new M3LConsoleError("ERR_CONSOLE_NOT_FOUND", "route not found"),
 * ); // false
 * isFaultError(new Error("boom")); // true
 * isFaultError(new Core.M3LOperationAbortedError()); // false — routine abort
 * ```
 */
export function isFaultError(error: unknown): boolean {
  if (error instanceof Core.M3LOperationAbortedError) return false;
  if (!(error instanceof M3LConsoleError)) return true;
  return classificationForCode(error.code).fault;
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
  return classificationForCode(code).status;
}

/**
 * Builds the envelope's `error` field for an {@link M3LConsoleError}: its
 * own code and message, and {@link CLASSIFICATION_BY_CODE}'s status/origin/
 * retryable for that code — never the instance's own `origin`/`retryable`
 * fields, which are always `undefined` (`ERR_CONSOLE_*` is absent from
 * `Core`'s classification catalog, and this package's error options accept
 * no override).
 */
function envelopeForConsoleError(
  error: M3LConsoleError,
  correlationId: string,
): M3LConsoleErrorEnvelope {
  const classification = classificationForCode(error.code);
  return {
    error: {
      code: error.code,
      message: error.message,
      status: classification.status,
      correlationId,
      origin: classification.origin,
      retryable: classification.retryable,
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
