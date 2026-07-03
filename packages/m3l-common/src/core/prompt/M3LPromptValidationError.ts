/**
 * `core/prompt/M3LPromptValidationError` — typed validation-failure error for
 * {@link M3LPrompt} and {@link M3LLoadingBar}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LPromptValidationError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_PROMPT_VALIDATION"` and is set automatically — callers must not
 * supply it.
 */
interface M3LPromptValidationErrorOptions {
  /**
   * Structured detail identifying the offending value, e.g. `value`/`min`/`max`
   * for a number-range violation. Never include a `password` value here —
   * secrets must not leak into error context.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this validation failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LPrompt.number} when a resolved numeric value is not
 * finite or falls outside `[min, max]`, when a contradictory `min > max`
 * range is supplied, or by {@link M3LLoadingBar} when constructed with a
 * non-positive `width`.
 *
 * Callers that need to distinguish a prompt-validation failure from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LPrompt,
 *   M3LPromptValidationError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const prompt = new M3LPrompt();
 * try {
 *   await prompt.number("Retries?", { min: 0, max: 10 });
 * } catch (e) {
 *   if (e instanceof M3LPromptValidationError) {
 *     // e.context carries the offending value and the min/max bounds
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LPromptValidationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PROMPT_VALIDATION"`. */
  override readonly code: "ERR_PROMPT_VALIDATION";

  /**
   * Creates a new `M3LPromptValidationError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Optional options bag; `context` carries the offending
   *   value (e.g. `{ value, min, max }`), and `cause` carries an underlying
   *   error if applicable. The error code is always
   *   `"ERR_PROMPT_VALIDATION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LPromptValidationErrorOptions) {
    super(message, {
      code: "ERR_PROMPT_VALIDATION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_PROMPT_VALIDATION";
  }
}
