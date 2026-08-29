/**
 * `errors/console-error` — the `M3LConsoleError` hierarchy raised by the
 * console server.
 *
 * The console server raises exactly one error class, discriminated by a
 * closed `code` union, so every layer above `errors/` can narrow a caught
 * value to a single type and switch on its `code` rather than maintaining a
 * per-failure-mode class hierarchy.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of machine-readable error codes the console server raises.
 *
 * Deliberately never registered in m3l-common's own `M3L_ERROR_CODES` tuple
 * — that tuple is the library's own emitted-code catalog, not a registry for
 * every consumer package. A consequence: {@link Core.classifyErrorCode}
 * returns `undefined` for every one of these codes.
 *
 * `ERR_CONSOLE_UNAVAILABLE` is raised when the server refuses a request
 * because it is draining (ADR-0049): a routine, expected outcome rather than
 * a fault, distinct from every other code here.
 *
 * The seven `ERR_CONSOLE_STORE_*` codes are the ADR-0069 embedded-persistence
 * failures, raised by the store driver port and its callers. Of these,
 * `ERR_CONSOLE_STORE_UNSUPPORTED` is distinguished as ADR-0069's **stability
 * checkpoint's** failure: it is raised at boot when the `node:sqlite` builtin
 * no longer exposes the members the driver port consumes — the recorded
 * trigger condition for adopting one of that ADR's fallback persistence
 * strategies. `ERR_CONSOLE_STORE_MIGRATION_FAILED` and
 * `ERR_CONSOLE_STORE_SCHEMA_DRIFT` are raised by the migration runner
 * (`store/migrations/runner.ts`): the former for an invalid registry or a
 * failed migration, the latter when the database's schema disagrees with
 * what the registry expects — either strictly ahead of every known
 * migration, or an already-applied migration whose recorded history no
 * longer matches its declared SQL.
 *
 * `ERR_CONSOLE_STREAM_CLOSED` and `ERR_CONSOLE_STREAM_DUPLICATE` are raised
 * by `stream/event-stream.ts` (X4, ADR-0065, ADR-0066). Neither is
 * reachable from an HTTP request: the SSE route only ever *subscribes* to
 * an already-open stream, while `publish`/`end`/`open` are called by
 * `runs/` — so a caller can never trigger either code, and both are genuine
 * internal defects rather than a routine, expected outcome.
 *
 * The two `ERR_CONSOLE_RUN_*` codes are the X4 run-registry's own failure
 * modes, layered on top of `console_runs` (`store/migrations/registry.ts`'s
 * v3). `ERR_CONSOLE_RUN_NOT_FOUND` is raised when a lookup by run id matches
 * no row — a routine, caller-facing "not found", not a fault.
 * `ERR_CONSOLE_RUN_TRANSITION_INVALID` is raised when a guarded status
 * transition's `UPDATE ... WHERE status = <expected>` matches zero rows: the
 * run exists, but its current status was not the one the caller's transition
 * expected, so the write that would have advanced its FSM never applied.
 *
 * The three further `ERR_CONSOLE_RUN_*` codes are the X4 run-governor's
 * caller-facing failure modes: `ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND` when the
 * resolver finds no script directory for the requested name,
 * `ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED` when a non-dry-run request arrives
 * without `confirmed: true`, and `ERR_CONSOLE_RUN_CAPACITY_EXCEEDED` when the
 * run governor's queue is full.
 *
 * Two further codes are `http/body.ts`'s request-body reading failures
 * (X4 slice 7-pre): `ERR_CONSOLE_BODY_TOO_LARGE` when a body exceeds the
 * configured byte cap (checked from `content-length` before any byte is read
 * when possible, otherwise enforced while streaming), and
 * `ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE` when a non-empty body's `content-type`
 * is not `application/json`. Both are caller-origin, non-retryable, non-fault
 * outcomes — see `http/envelope.ts`'s classification table.
 *
 * The five final codes are the X6 workbench-sessions module's own failure
 * modes, layered on top of `console_sessions`/`console_session_steps`/
 * `console_session_bindings`/`console_session_decisions`
 * (`store/migrations/registry.ts`'s v4). `ERR_CONSOLE_SESSION_NOT_FOUND` and
 * `ERR_CONSOLE_SESSION_STEP_NOT_FOUND` are raised when a lookup by session or
 * step id matches no row — routine, caller-facing "not found" outcomes, not
 * faults. `ERR_CONSOLE_SESSION_TRANSITION_INVALID` is raised when a guarded
 * session/step/decision status transition's guarded `UPDATE` matches zero
 * rows: unlike `ERR_CONSOLE_RUN_TRANSITION_INVALID`
 * (server-internal — only the run orchestrator ever calls that transition),
 * this code IS reachable directly from an HTTP caller in a later slice (e.g.
 * answering an already-answered decision, a double-submit race), so it is
 * caller-facing rather than a fault. `ERR_CONSOLE_SESSION_CLOSED` is raised
 * when a caller attempts to write a step to a session that is already
 * `closed`. `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` mirrors
 * `ERR_CONSOLE_RUN_CAPACITY_EXCEEDED`'s shape: raised when a later slice's
 * concurrent-open-session cap is reached.
 *
 * `ERR_CONSOLE_SESSION_REFERENCE_INVALID` is X6 slice 2's own addition
 * (`sessions/reference.ts`, ADR-0068): raised by `parseStepReference` when
 * caller-facing reference text does not match the
 * `step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*` grammar, and
 * by `resolveStepReference` when a well-formed reference no longer matches
 * the data it names (an impossible walk, or a forbidden prototype-pollution
 * property name). Either way it is a caller-facing "your reference string is
 * malformed, or no longer matches the data it names" outcome, never a server
 * fault.
 *
 * The two final codes are X6 slice 3's own addition (`sessions/artifacts.ts`,
 * ADR-0068/ADR-0069): the session artifact store's own failure modes.
 * `ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE` is raised by `put` when a
 * payload's JSON-serialized byte size exceeds either the configured
 * per-artifact cap or the caller-supplied running session-total cap — a
 * caller-facing "you tried to persist more data than this deployment
 * allows" outcome. `ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT` is raised by `put`
 * when an exclusive-create write collides with an existing artifact file
 * (`EEXIST`, never silently overwritten) or otherwise fails to persist, by
 * `readArtifact` when a file-backed artifact's on-disk bytes no longer match
 * its recorded digest, and by `decodeArtifactRef` when persisted reference
 * text cannot be parsed or does not match the reference envelope shape —
 * every one of these means the store or filesystem drifted from what this
 * module itself wrote, so it is a genuine internal fault, not a caller
 * mistake.
 *
 * @example
 * ```ts
 * function isConfigError(code: M3LConsoleErrorCode): boolean {
 *   return code === "ERR_CONSOLE_CONFIG_INVALID";
 * }
 * ```
 */
export type M3LConsoleErrorCode =
  | "ERR_CONSOLE_CONFIG_INVALID"
  | "ERR_CONSOLE_BAD_REQUEST"
  | "ERR_CONSOLE_UNAUTHENTICATED"
  | "ERR_CONSOLE_NOT_FOUND"
  | "ERR_CONSOLE_METHOD_NOT_ALLOWED"
  | "ERR_CONSOLE_ROUTE_CONFLICT"
  | "ERR_CONSOLE_INTERNAL"
  | "ERR_CONSOLE_DRAIN_FAILED"
  | "ERR_CONSOLE_LISTEN_FAILED"
  | "ERR_CONSOLE_UNAVAILABLE"
  | "ERR_CONSOLE_STORE_UNSUPPORTED"
  | "ERR_CONSOLE_STORE_OPEN_FAILED"
  | "ERR_CONSOLE_STORE_BUSY"
  | "ERR_CONSOLE_STORE_CLOSED"
  | "ERR_CONSOLE_STORE_QUERY_FAILED"
  | "ERR_CONSOLE_STORE_MIGRATION_FAILED"
  | "ERR_CONSOLE_STORE_SCHEMA_DRIFT"
  | "ERR_CONSOLE_STREAM_CLOSED"
  | "ERR_CONSOLE_STREAM_DUPLICATE"
  | "ERR_CONSOLE_RUN_NOT_FOUND"
  | "ERR_CONSOLE_RUN_TRANSITION_INVALID"
  | "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"
  | "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"
  | "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"
  | "ERR_CONSOLE_BODY_TOO_LARGE"
  | "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE"
  | "ERR_CONSOLE_SESSION_NOT_FOUND"
  | "ERR_CONSOLE_SESSION_STEP_NOT_FOUND"
  | "ERR_CONSOLE_SESSION_TRANSITION_INVALID"
  | "ERR_CONSOLE_SESSION_CLOSED"
  | "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED"
  | "ERR_CONSOLE_SESSION_REFERENCE_INVALID"
  | "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"
  | "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT";

/**
 * Constructor options for {@link M3LConsoleError}.
 */
interface M3LConsoleErrorOptions {
  /** The underlying failure that caused this error, if any. */
  readonly cause?: unknown;
  /** Structured diagnostic detail. Defaults to `{}` when omitted. */
  readonly context?: Record<string, unknown>;
}

/**
 * The single error class the console server raises, discriminated by
 * {@link M3LConsoleErrorCode}. Extends `Core.M3LError`, so callers can still
 * narrow via `instanceof Core.M3LError`.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * // extends Core.M3LError, so `instanceof M3LError` still narrows it
 * throw new M3LConsoleError(
 *   "ERR_CONSOLE_CONFIG_INVALID",
 *   "M3L_CONSOLE_OPERATOR_NAME must not be blank",
 * );
 * ```
 */
export class M3LConsoleError extends Core.M3LError {
  /** The specific failure mode within the console server. */
  override readonly code: M3LConsoleErrorCode;

  /**
   * Creates a new `M3LConsoleError`.
   *
   * @param code - The specific failure mode.
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause` and `context`.
   */
  constructor(
    code: M3LConsoleErrorCode,
    message: string,
    options: M3LConsoleErrorOptions = {},
  ) {
    super(message, {
      code,
      ...(options.cause !== undefined && { cause: options.cause }),
      ...(options.context !== undefined && { context: options.context }),
    });
    this.code = code;
  }
}

/**
 * Type guard — narrows an unknown caught value to {@link M3LConsoleError}.
 *
 * @param error - Any value caught at an API boundary.
 * @returns `true` when `error` is an `M3LConsoleError` instance.
 *
 * @example
 * ```ts
 * try {
 *   run();
 * } catch (error: unknown) {
 *   if (isConsoleError(error)) {
 *     // error.code narrows to M3LConsoleErrorCode
 *   }
 * }
 * ```
 */
export function isConsoleError(error: unknown): error is M3LConsoleError {
  return error instanceof M3LConsoleError;
}
