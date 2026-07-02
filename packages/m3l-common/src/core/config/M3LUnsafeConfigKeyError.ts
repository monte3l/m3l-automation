/**
 * `core/config/M3LUnsafeConfigKeyError` — typed prototype-pollution guard
 * error raised by config providers that build objects from parsed or
 * external input.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LUnsafeConfigKeyError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_CONFIG_UNSAFE_KEY"` and is set automatically — callers must not
 * supply it.
 */
interface M3LUnsafeConfigKeyErrorOptions {
  /** Structured detail identifying the offending key and its source. */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by a config provider (e.g. {@link M3LInMemoryConfigProvider},
 * {@link M3LJSONConfigProvider}, {@link M3LLambdaEventConfigProvider},
 * {@link M3LPresetConfigProvider}) when it encounters a prototype-pollution
 * vector key (`__proto__`, `constructor`, or `prototype`) while building an
 * internal value map from parsed or external input.
 *
 * Callers that need to distinguish an unsafe-key rejection from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LInMemoryConfigProvider,
 *   M3LUnsafeConfigKeyError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   new M3LInMemoryConfigProvider(
 *     JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
 *   );
 * } catch (e) {
 *   if (e instanceof M3LUnsafeConfigKeyError) {
 *     // e.context carries the offending key
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LUnsafeConfigKeyError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CONFIG_UNSAFE_KEY"`. */
  override readonly code: "ERR_CONFIG_UNSAFE_KEY";

  /**
   * Creates a new `M3LUnsafeConfigKeyError`.
   *
   * @param message - Human-readable description of the unsafe-key rejection.
   * @param options - Optional options bag; `context` carries the offending
   *   key, and `cause` carries an underlying error if applicable. The error
   *   code is always `"ERR_CONFIG_UNSAFE_KEY"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LUnsafeConfigKeyErrorOptions) {
    super(message, {
      code: "ERR_CONFIG_UNSAFE_KEY",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_CONFIG_UNSAFE_KEY";
  }
}
