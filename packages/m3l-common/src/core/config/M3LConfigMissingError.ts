/**
 * `core/config/M3LConfigMissingError` — typed fail-fast error for a
 * {@link M3LConfigParameter} declared `required` that no provider,
 * `defaultValue`, or `asyncFallback` supplies a value for.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LConfigMissingError}.
 *
 * `parameter` and `cause` are optional; the error code is always
 * `"ERR_CONFIG_MISSING"` and is set automatically — callers must not supply
 * it.
 */
interface M3LConfigMissingErrorOptions {
  /**
   * The name of the missing required parameter. When supplied, becomes the
   * error's `context.parameter` — no other detail is attached, since there
   * is no resolved value to (safely or unsafely) include.
   */
  readonly parameter?: string;
  /** The underlying cause, if this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LConfigParameter} when a parameter declared
 * `required: true` resolves through every level of its chain (provider,
 * `defaultValue`, `asyncFallback`) without producing a value.
 *
 * Callers that need to distinguish a missing required value from a
 * validation failure ({@link M3LConfigValidationError}, a resolved value
 * that broke an application constraint) should catch this type
 * specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigMissingError,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigReader,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const reader = new M3LConfigReader([]);
 * const apiKey = new M3LConfigParameter({
 *   name: "API_KEY",
 *   type: M3LConfigParameterType.STRING,
 *   required: true,
 * });
 *
 * try {
 *   await apiKey.getValueAsync(reader);
 * } catch (e) {
 *   if (e instanceof M3LConfigMissingError) {
 *     // e.context carries { parameter: "API_KEY" }
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LConfigMissingError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CONFIG_MISSING"`. */
  override readonly code: "ERR_CONFIG_MISSING";

  /**
   * Creates a new `M3LConfigMissingError`.
   *
   * @param message - Human-readable description of the missing-value
   *   failure.
   * @param options - Optional options bag; `parameter` names the missing
   *   parameter and becomes `context.parameter`, and `cause` carries an
   *   underlying error if applicable. The error code is always
   *   `"ERR_CONFIG_MISSING"` — it cannot be overridden.
   */
  constructor(message: string, options: M3LConfigMissingErrorOptions = {}) {
    super(message, {
      code: "ERR_CONFIG_MISSING",
      ...(options.parameter !== undefined && {
        context: { parameter: options.parameter },
      }),
      ...(options.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_CONFIG_MISSING";
  }
}
