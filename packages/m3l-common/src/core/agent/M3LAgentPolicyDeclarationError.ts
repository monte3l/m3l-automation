/**
 * `core/agent/M3LAgentPolicyDeclarationError` — typed validation failure for a
 * malformed agent policy declaration.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAgentPolicyDeclarationError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_AGENT_POLICY_DECLARATION"` and is set automatically — callers must not
 * supply it.
 */
interface M3LAgentPolicyDeclarationErrorOptions {
  /**
   * Structured detail naming the offending grant index or key and the
   * violation kind — **never a value**.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this validation failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link validateAgentPolicy} when a declaration fails validation —
 * a non-object input, an unknown `version`, an absent/empty/over-long
 * `scripts` list, a grant with neither or both of `operations` and
 * `allOperations`, a duplicate script or operation, an all-omitted
 * `sensitiveTargets` spec, or any unknown or dangerous key.
 *
 * Callers that need to distinguish a declaration-shape problem from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   validateAgentPolicy,
 *   M3LAgentPolicyDeclarationError,
 *   M3LError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   validateAgentPolicy({ version: 2, scripts: [] });
 * } catch (e) {
 *   if (e instanceof M3LAgentPolicyDeclarationError) {
 *     // e.context names the offending field and the violation kind
 *   } else if (e instanceof M3LError) {
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LAgentPolicyDeclarationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AGENT_POLICY_DECLARATION"`. */
  override readonly code: "ERR_AGENT_POLICY_DECLARATION";

  /**
   * Creates a new `M3LAgentPolicyDeclarationError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Optional options bag; `context` names the offending
   *   grant index or key plus the violation kind (never a value), and `cause`
   *   carries an underlying error if applicable. The error code is always
   *   `"ERR_AGENT_POLICY_DECLARATION"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LAgentPolicyDeclarationErrorOptions,
  ) {
    super(message, {
      code: "ERR_AGENT_POLICY_DECLARATION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_AGENT_POLICY_DECLARATION";
  }
}
