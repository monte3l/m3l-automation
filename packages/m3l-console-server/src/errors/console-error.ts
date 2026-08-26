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
  | "ERR_CONSOLE_UNAVAILABLE";

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
