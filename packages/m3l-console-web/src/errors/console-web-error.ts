/**
 * `errors/console-web-error` — the `M3LConsoleWebError` raised by the
 * console web frontend.
 *
 * The frontend raises exactly one error class, discriminated by a closed
 * `code` union, so bootstrap failures (e.g. a missing DOM mount point) carry
 * a machine-readable code alongside the human-readable message, matching the
 * pattern used by the console server's own error hierarchy.
 *
 * @packageDocumentation
 */

/**
 * The closed set of machine-readable error codes the console web frontend
 * raises.
 *
 * `ERR_CONSOLE_WEB_ROOT_MISSING` is raised at bootstrap time in `main.tsx`
 * when `document.getElementById("root")` returns `null` — the host page is
 * missing the element React is meant to mount into.
 *
 * @example
 * ```ts
 * function isRootMissing(code: M3LConsoleWebErrorCode): boolean {
 *   return code === "ERR_CONSOLE_WEB_ROOT_MISSING";
 * }
 * ```
 */
export type M3LConsoleWebErrorCode = "ERR_CONSOLE_WEB_ROOT_MISSING";

/**
 * The single error class the console web frontend raises, discriminated by
 * {@link M3LConsoleWebErrorCode}. Extends the built-in `Error`, so callers
 * can still narrow via `instanceof Error`.
 *
 * @example
 * ```ts
 * import { M3LConsoleWebError } from "./errors/console-web-error.js";
 *
 * const container = document.getElementById("root");
 * if (container === null) {
 *   throw new M3LConsoleWebError(
 *     "ERR_CONSOLE_WEB_ROOT_MISSING",
 *     "m3l-console-web: #root element not found",
 *   );
 * }
 * ```
 */
export class M3LConsoleWebError extends Error {
  /** The specific failure mode within the console web frontend. */
  readonly code: M3LConsoleWebErrorCode;

  /**
   * Creates a new `M3LConsoleWebError`.
   *
   * @param code - The specific failure mode.
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause`, forwarded to `Error`.
   */
  constructor(
    code: M3LConsoleWebErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "M3LConsoleWebError";
    this.code = code;
  }
}
