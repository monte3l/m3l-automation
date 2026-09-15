/**
 * `errors/mcp-error` — the single error type this package throws
 * (ADR-0062). One class with a closed `code` union rather than a class per
 * failure mode: each code (`ERR_MCP_POLICY`, `ERR_MCP_DECISION_LOG`,
 * `ERR_MCP_CONFIG`, `ERR_MCP_IDENTITY`, `ERR_MCP_CLI`) names the *subsystem*
 * a failure came from, which is all a caller needs to branch on — the
 * message carries the specific detail, undecorated, so a client surfacing
 * it verbatim never doubles up a prefix the caller already renders from
 * `code`.
 *
 * @packageDocumentation
 */

import { Core } from "@monte3l/m3l-common";

/**
 * The closed set of subsystems an {@link M3LMcpError} can be raised from:
 * the ADR-0060 policy gate, the ADR-0061 decision log, this package's own
 * configuration loading, MCP client identity resolution, and the spawned
 * `m3l` CLI. Closed deliberately — a `switch` over this union stays
 * exhaustive as the codebase grows, catching an unhandled subsystem at
 * compile time rather than at a client's stderr log.
 *
 * Deliberately never registered in m3l-common's own `M3L_ERROR_CODES` tuple
 * — that tuple is the library's own emitted-code catalog, not a registry for
 * every consumer package. A consequence: `Core.classifyErrorCode` returns
 * `undefined` for every one of these codes.
 */
export type M3LMcpErrorCode =
  | "ERR_MCP_POLICY"
  | "ERR_MCP_DECISION_LOG"
  | "ERR_MCP_CONFIG"
  | "ERR_MCP_IDENTITY"
  /**
   * Failures of the spawned `m3l` CLI: an exit code outside the command's
   * accepted set, a timeout, a truncated stream, or unparseable `--json`
   * output.
   */
  | "ERR_MCP_CLI";

/**
 * Constructor options for {@link M3LMcpError}.
 */
interface M3LMcpErrorOptions {
  /** The underlying failure that caused this error, if any. */
  readonly cause?: unknown;
  /** Structured diagnostic detail. Defaults to `{}` when omitted. */
  readonly context?: Record<string, unknown>;
}

/**
 * This package's sole error type, discriminated by {@link M3LMcpErrorCode}.
 * Extends `Core.M3LError`, so callers can still narrow via
 * `instanceof Core.M3LError`. `message` is stored verbatim — never prefixed
 * or decorated with `code` — because a caller that already branches on
 * `code` would otherwise see it duplicated in the rendered text.
 *
 * @example
 * ```ts
 * import { M3LMcpError } from "./mcp-error.js";
 *
 * // extends Core.M3LError, so `instanceof Core.M3LError` still narrows it
 * throw new M3LMcpError("ERR_MCP_CONFIG", "agent-policy.json is missing");
 * ```
 */
export class M3LMcpError extends Core.M3LError {
  /** Which subsystem raised this error. See {@link M3LMcpErrorCode}. */
  override readonly code: M3LMcpErrorCode;

  /**
   * Creates a new `M3LMcpError`.
   *
   * @param code - See {@link M3LMcpErrorCode}.
   * @param message - Human-readable detail, stored verbatim as `Error#message`.
   * @param options - Optional `cause` and `context`. `cause` may be any
   *   `unknown` value, not only an `Error` — a caught value from an untyped
   *   boundary (e.g. a rejected promise) is never guaranteed to be an `Error`
   *   instance.
   */
  constructor(
    code: M3LMcpErrorCode,
    message: string,
    options: M3LMcpErrorOptions = {},
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
 * Narrows `value` to {@link M3LMcpError}. Implemented with `instanceof`
 * rather than a structural check on `name`/`code` — a duck-typed check
 * would accept a plain object forged to look like one (e.g. deserialized
 * from a log), which defeats the point of a typed error channel.
 * `instanceof` alone answers the question without reading any property off
 * `value`, so a hostile object with a throwing `code` getter cannot make
 * this throw.
 *
 * @param value - Any value, including `null`/`undefined`/primitives.
 * @returns `true` only for a genuine `M3LMcpError` instance.
 *
 * @example
 * ```ts
 * import { isM3LMcpError } from "./mcp-error.js";
 *
 * try {
 *   // ...
 * } catch (cause) {
 *   if (isM3LMcpError(cause)) {
 *     // cause.code is narrowed to M3LMcpErrorCode here
 *   }
 * }
 * ```
 */
export function isM3LMcpError(value: unknown): value is M3LMcpError {
  return value instanceof M3LMcpError;
}
