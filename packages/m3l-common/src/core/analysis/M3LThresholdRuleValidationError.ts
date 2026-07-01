/**
 * `core/analysis/M3LThresholdRuleValidationError` — typed validation failure
 * for a malformed {@link M3LThresholdRule}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LThresholdRuleValidationError}.
 *
 * `cause` is optional; the error code is always `"ERR_ANALYSIS_INVALID_RULE"`
 * and is set automatically — callers must not supply it.
 */
interface M3LThresholdRuleValidationErrorOptions {
  /** Structured detail identifying the offending rule and the violation. */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this validation failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LThresholdEvaluator.evaluate} when a
 * {@link M3LThresholdRule} fails validation — an unrecognized `operator`, an
 * unrecognized `aggregation`, or a field-requiring aggregation
 * (`any-row` / `sum` / `avg` / `min` / `max`) missing its `field`.
 *
 * Callers that need to distinguish a rule-shape problem from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LThresholdEvaluator,
 *   M3LThresholdRuleValidationError,
 *   type M3LThresholdRule,
 * } from "@m3l-automation/m3l-common/core";
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * const rules: M3LThresholdRule[] = [
 *   { name: "bad", operator: ">", value: 1, aggregation: "avg", severity: "warning" },
 * ];
 *
 * try {
 *   new M3LThresholdEvaluator().evaluate(rules, []);
 * } catch (e) {
 *   if (e instanceof M3LThresholdRuleValidationError) {
 *     // e.context carries the rule name and the invalid detail
 *   } else if (e instanceof M3LError) {
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LThresholdRuleValidationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ANALYSIS_INVALID_RULE"`. */
  override readonly code: "ERR_ANALYSIS_INVALID_RULE";

  /**
   * Creates a new `M3LThresholdRuleValidationError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Optional options bag; `context` carries the offending
   *   rule name plus the invalid operator/aggregation/missing-field detail,
   *   and `cause` carries an underlying error if applicable. The error code
   *   is always `"ERR_ANALYSIS_INVALID_RULE"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LThresholdRuleValidationErrorOptions,
  ) {
    super(message, {
      code: "ERR_ANALYSIS_INVALID_RULE",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_ANALYSIS_INVALID_RULE";
  }
}
