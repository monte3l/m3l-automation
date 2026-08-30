/**
 * `lib/errors` — the single script-local error type for `agent-operator`.
 *
 * Every failure this script raises pins one of six documented codes onto a
 * single `M3LAgentOperatorCliError` class rather than a dedicated subclass
 * per code: the codes differ only in the string that identifies them, not in
 * shape or behaviour, so a subclass hierarchy would add nothing but ceremony
 * a `catch (e) { switch (e.code) }` site already needs to do anyway.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of machine-readable codes `agent-operator` can raise.
 * Every {@link M3LAgentOperatorCliError} is constructed with exactly one of
 * these — narrow on `.code` at a catch site to distinguish failure modes.
 *
 * @example
 * ```ts
 * import type { M3LAgentOperatorErrorCode } from "./errors.js";
 *
 * function isConfigFailure(code: M3LAgentOperatorErrorCode): boolean {
 *   return code === "ERR_AGENT_OPERATOR_CONFIG";
 * }
 * ```
 */
export type M3LAgentOperatorErrorCode =
  | "ERR_AGENT_OPERATOR_CONFIG"
  | "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT"
  | "ERR_AGENT_OPERATOR_CLI_SPAWN"
  | "ERR_AGENT_OPERATOR_CLI_OUTPUT"
  | "ERR_AGENT_OPERATOR_SCRIPT_NAME"
  | "ERR_AGENT_OPERATOR_POLICY";

/**
 * Enrichment fields for {@link M3LAgentOperatorCliError}, forwarded verbatim
 * to `Core.M3LError`'s options bag alongside the pinned `code`. Module-private
 * — callers catch `M3LAgentOperatorCliError` instances, they don't construct
 * them with a hand-built options bag, so this type has no reason to be public.
 */
interface M3LAgentOperatorCliErrorOptions {
  /** Structured diagnostic context. Never place raw stdout/stderr, a spawn
   * `error.message`, a filesystem path, or model-supplied text here. */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this error wraps another failure. */
  readonly cause?: unknown;
  /** Overrides the catalog-derived origin classification for this instance. */
  readonly origin?: Core.M3LErrorOrigin;
  /** Overrides the catalog-derived retryable classification for this instance. */
  readonly retryable?: Core.M3LErrorRetryable;
}

/**
 * The single error type raised by every `agent-operator` failure path.
 * Extends `Core.M3LError` so a caller can narrow with an `instanceof`
 * check against `Core.M3LError` first, then against
 * `M3LAgentOperatorCliError`, then on `.code` for the specific failure mode —
 * never a bare thrown string.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { M3LAgentOperatorCliError } from "./errors.js";
 *
 * function assertHasName(name: string | undefined): asserts name is string {
 *   if (name === undefined) {
 *     throw new M3LAgentOperatorCliError(
 *       "script name is required",
 *       "ERR_AGENT_OPERATOR_SCRIPT_NAME",
 *     );
 *   }
 * }
 *
 * try {
 *   assertHasName(undefined);
 * } catch (error) {
 *   if (error instanceof Core.M3LError) {
 *     console.error(error.code);
 *   }
 * }
 * ```
 */
export class M3LAgentOperatorCliError extends Core.M3LError {
  /**
   * Re-narrows `Core.M3LError.code` (typed `string` on the base class) down
   * to this class's own closed vocabulary. Declaration-only — it emits no
   * runtime field and adds no assignment; the constructor below already
   * establishes the invariant by always passing one
   * {@link M3LAgentOperatorErrorCode} literal to `super`. Without this, a
   * `switch (error.code)` at a catch site gets no exhaustiveness check and
   * no `never` default, despite the class's own guidance above to narrow on
   * `.code`.
   */
  declare readonly code: M3LAgentOperatorErrorCode;

  /**
   * @param message - Human-readable description of the failure. Must never
   *   echo a spawn `error.message`, a raw filesystem path, or
   *   model-supplied text.
   * @param code - The pinned {@link M3LAgentOperatorErrorCode} identifying
   *   the failure mode.
   * @param options - Optional `context`/`cause`/`origin`/`retryable`
   *   enrichment forwarded to `Core.M3LError`.
   */
  constructor(
    message: string,
    code: M3LAgentOperatorErrorCode,
    options?: M3LAgentOperatorCliErrorOptions,
  ) {
    super(message, { ...options, code });
  }
}
