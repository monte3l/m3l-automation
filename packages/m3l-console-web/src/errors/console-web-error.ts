/**
 * `errors/console-web-error` — the `M3LConsoleWebError` raised by the
 * console web frontend.
 *
 * The frontend raises exactly one error class, discriminated by a closed
 * `code` union, so bootstrap failures (e.g. a missing DOM mount point) carry
 * a machine-readable code alongside the human-readable message, matching the
 * pattern used by the console server's own error hierarchy.
 *
 * Imports `M3LError` from the `@m3l-automation/m3l-common/core/errors` leaf
 * subpath rather than the `/core` namespace barrel — that subpath's whole
 * transitive import graph is machine-proven free of `node:`/third-party
 * imports (`docs/adr/0004-exports-map-contract.md`'s dated Update), so this
 * browser bundle picks up the shared error hierarchy without pulling in the
 * rest of the Node-oriented library.
 *
 * @packageDocumentation
 */

import { M3LError } from "@m3l-automation/m3l-common/core/errors";

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
 * Constructor options for {@link M3LConsoleWebError}.
 */
interface M3LConsoleWebErrorOptions {
  /** The underlying failure that caused this error, if any. */
  readonly cause?: unknown;
}

/**
 * The single error class the console web frontend raises, discriminated by
 * {@link M3LConsoleWebErrorCode}. Extends `M3LError` (from the
 * `@m3l-automation/m3l-common/core/errors` leaf subpath), so callers can
 * still narrow via `instanceof M3LError`.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core/errors";
 *
 * import { M3LConsoleWebError } from "./errors/console-web-error.js";
 *
 * const container = document.getElementById("root");
 * if (container === null) {
 *   // extends M3LError, so `instanceof M3LError` still narrows it
 *   throw new M3LConsoleWebError(
 *     "ERR_CONSOLE_WEB_ROOT_MISSING",
 *     "m3l-console-web: #root element not found",
 *   );
 * }
 * ```
 */
export class M3LConsoleWebError extends M3LError {
  /** The specific failure mode within the console web frontend. */
  override readonly code: M3LConsoleWebErrorCode;

  /**
   * Creates a new `M3LConsoleWebError`.
   *
   * @param code - The specific failure mode.
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause`.
   */
  constructor(
    code: M3LConsoleWebErrorCode,
    message: string,
    options: M3LConsoleWebErrorOptions = {},
  ) {
    super(message, {
      code,
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.code = code;
  }
}
