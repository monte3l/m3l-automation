/**
 * `errors/mcp-error` — the single error type this package throws
 * (ADR-0062). One class with a closed `code` union rather than a class per
 * failure mode: the four codes (`ERR_MCP_POLICY`, `ERR_MCP_DECISION_LOG`,
 * `ERR_MCP_CONFIG`, `ERR_MCP_IDENTITY`) name the *subsystem* a failure came
 * from, which is all a caller needs to branch on — the message carries the
 * specific detail, undecorated, so a client surfacing it verbatim never
 * doubles up a prefix the caller already renders from `code`.
 *
 * @packageDocumentation
 */

/**
 * The closed set of subsystems an {@link M3LMcpError} can be raised from:
 * the ADR-0060 policy gate, the ADR-0061 decision log, this package's own
 * configuration loading, and MCP client identity resolution. Closed
 * deliberately — a `switch` over this union stays exhaustive as the
 * codebase grows, catching an unhandled subsystem at compile time rather
 * than at a client's stderr log.
 */
export type M3LMcpErrorCode =
  | "ERR_MCP_POLICY"
  | "ERR_MCP_DECISION_LOG"
  | "ERR_MCP_CONFIG"
  | "ERR_MCP_IDENTITY";

/**
 * This package's sole error type. `message` is stored verbatim — never
 * prefixed or decorated with `code` — because a caller that already
 * branches on `code` would otherwise see it duplicated in the rendered
 * text.
 *
 * @example
 * ```ts
 * import { M3LMcpError } from "./mcp-error.js";
 *
 * throw new M3LMcpError("agent-policy.json is missing", "ERR_MCP_CONFIG");
 * ```
 */
export class M3LMcpError extends Error {
  /** Which subsystem raised this error. See {@link M3LMcpErrorCode}. */
  readonly code: M3LMcpErrorCode;

  /**
   * @param message - Human-readable detail, stored verbatim as `Error#message`.
   * @param code - See {@link M3LMcpErrorCode}.
   * @param options - Optional `cause`, chained onto `Error#cause` when
   *   supplied. May be any `unknown` value, not only an `Error` — a caught
   *   value from an untyped boundary (e.g. a rejected promise) is never
   *   guaranteed to be an `Error` instance.
   */
  constructor(
    message: string,
    code: M3LMcpErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "M3LMcpError";
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
