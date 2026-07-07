/**
 * `core/config/M3LConfigValidationError` — typed schema-time
 * validation-failure error for {@link M3LConfigParameter}'s `validate` option.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LConfigValidationError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_CONFIG_VALIDATION"` and is set automatically — callers must not
 * supply it.
 */
interface M3LConfigValidationErrorOptions {
  /**
   * Structured detail identifying the failing parameter and constraint.
   * Carries `{ parameter, reason, valueType }` only — never the value itself,
   * so a validation failure is safe to log for any parameter, secret or not.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this validation failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LConfigParameter} when a coerced value (from a provider,
 * a static `defaultValue`, or an `asyncFallback`) fails its declared
 * `validate` function.
 *
 * Callers that need to distinguish a validation failure (the value parsed to
 * the right type but broke an application constraint) from a coercion
 * failure ({@link M3LConfigCoercionError}, a type mismatch) should catch this
 * type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigValidationError,
 *   M3LConfigValidators,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   new M3LConfigParameter({
 *     name: "PORT",
 *     type: M3LConfigParameterType.INT,
 *     defaultValue: 70000,
 *     validate: M3LConfigValidators.range(1, 65535),
 *   });
 * } catch (e) {
 *   if (e instanceof M3LConfigValidationError) {
 *     // e.context carries { parameter, reason, valueType } — never the value
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LConfigValidationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CONFIG_VALIDATION"`. */
  override readonly code: "ERR_CONFIG_VALIDATION";

  /**
   * Creates a new `M3LConfigValidationError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Optional options bag; `context` carries the failing
   *   parameter name, the validator's reason, and the value's redacted
   *   `typeof`, and `cause` carries an underlying error if applicable. The
   *   error code is always `"ERR_CONFIG_VALIDATION"` — it cannot be
   *   overridden.
   */
  constructor(message: string, options?: M3LConfigValidationErrorOptions) {
    super(message, {
      code: "ERR_CONFIG_VALIDATION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_CONFIG_VALIDATION";
  }
}
