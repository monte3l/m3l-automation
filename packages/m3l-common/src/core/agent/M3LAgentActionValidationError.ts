/**
 * `core/agent/M3LAgentActionValidationError` — typed validation failure for a
 * malformed evaluation options bag.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAgentActionValidationError}.
 *
 * `cause` is optional; the error code is always `"ERR_AGENT_INVALID_ACTION"`
 * and is set automatically — callers must not supply it.
 */
interface M3LAgentActionValidationErrorOptions {
  /**
   * Structured detail naming the offending field and the violation kind —
   * **never a value**.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this validation failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link evaluateAgentAction} when its options bag is structurally
 * malformed — a non-object `action`, a blank `script`, an unrecognised `kind`,
 * a malformed `target`, an over-long `parameterNames`, a non-boolean `dryRun`,
 * a non-function `additionalSensitiveTargets`, or any unknown or dangerous
 * key.
 *
 * Also thrown by {@link agentDecisionLogEntry} when **its** options bag is
 * structurally malformed — a blank `identity.name`, a non-string `modelId` or
 * `awsPrincipal`, a `now` outside the range `Date` can represent, a negative
 * or non-finite `tokens` or `cost`, a non-integer `outcome.exitCode`, or any
 * unknown or dangerous key. Both boundaries share this one error class rather
 * than each minting its own, and both follow the same "`context` names the
 * field and the violation kind, never a value" discipline.
 *
 * A malformed input is a bug to surface loudly; a well-formed input the
 * current rule set cannot classify is a condition to escalate. This error is
 * therefore only ever thrown, never returned as a verdict.
 *
 * @example
 * ```ts
 * import {
 *   evaluateAgentAction,
 *   validateAgentPolicy,
 *   M3LAgentActionValidationError,
 *   M3LError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 *
 * try {
 *   evaluateAgentAction({ policy, action: { script: "  ", kind: "read-only" } });
 * } catch (e) {
 *   if (e instanceof M3LAgentActionValidationError) {
 *     // e.context names the offending field and the violation kind
 *   } else if (e instanceof M3LError) {
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LAgentActionValidationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AGENT_INVALID_ACTION"`. */
  override readonly code: "ERR_AGENT_INVALID_ACTION";

  /**
   * Creates a new `M3LAgentActionValidationError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Optional options bag; `context` names the offending
   *   field and the violation kind (never a value), and `cause` carries an
   *   underlying error if applicable. The error code is always
   *   `"ERR_AGENT_INVALID_ACTION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAgentActionValidationErrorOptions) {
    super(message, {
      code: "ERR_AGENT_INVALID_ACTION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_AGENT_INVALID_ACTION";
  }
}
