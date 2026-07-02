/**
 * `core/config/M3LConfigCoercionError` — typed coercion-failure error for
 * {@link coerceConfigValue}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LConfigCoercionError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_CONFIG_COERCION"` and is set automatically — callers must not supply
 * it.
 */
interface M3LConfigCoercionErrorOptions {
  /** Structured detail identifying the offending raw value and target type. */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this coercion failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link coerceConfigValue} when a raw configuration value cannot be
 * coerced to its declared {@link M3LConfigParameterType}.
 *
 * Callers that need to distinguish a coercion failure from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   coerceConfigValue,
 *   M3LConfigCoercionError,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   coerceConfigValue("not-a-number", M3LConfigParameterType.INT);
 * } catch (e) {
 *   if (e instanceof M3LConfigCoercionError) {
 *     // e.context carries the raw value and the target type
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LConfigCoercionError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CONFIG_COERCION"`. */
  override readonly code: "ERR_CONFIG_COERCION";

  /**
   * Creates a new `M3LConfigCoercionError`.
   *
   * @param message - Human-readable description of the coercion failure.
   * @param options - Optional options bag; `context` carries the offending
   *   raw value and target type, and `cause` carries an underlying error if
   *   applicable. The error code is always `"ERR_CONFIG_COERCION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LConfigCoercionErrorOptions) {
    super(message, {
      code: "ERR_CONFIG_COERCION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_CONFIG_COERCION";
  }
}
