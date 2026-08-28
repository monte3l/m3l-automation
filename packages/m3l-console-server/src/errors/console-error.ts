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
  | "ERR_CONSOLE_RUN_TRANSITION_INVALID";

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
