/**
 * `core/config/M3LConfigParseError` — typed parse-failure error for the
 * file-backed config providers.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LConfigParseError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_CONFIG_PARSE"` and is set automatically — callers must not supply it.
 */
interface M3LConfigParseErrorOptions {
  /** Structured detail identifying the offending file. */
  readonly context?: Record<string, unknown>;
  /** The underlying parse error (e.g. `SyntaxError`, a YAML parse error). */
  readonly cause?: unknown;
}

/**
 * Thrown by a file-backed config provider (e.g. {@link M3LJSONConfigProvider},
 * {@link M3LYAMLConfigProvider}) when the target file exists and is readable
 * but its content cannot be parsed.
 *
 * A missing file (`ENOENT`) is tolerated and does **not** throw this error —
 * the provider simply yields `undefined` for every key. This error signals a
 * genuinely malformed file.
 *
 * @example
 * ```ts
 * import {
 *   M3LJSONConfigProvider,
 *   M3LConfigParseError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   new M3LJSONConfigProvider("./data/config/app.json");
 * } catch (e) {
 *   if (e instanceof M3LConfigParseError) {
 *     // e.cause carries the underlying SyntaxError / YAML parse error
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LConfigParseError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_CONFIG_PARSE"`. */
  override readonly code: "ERR_CONFIG_PARSE";

  /**
   * Creates a new `M3LConfigParseError`.
   *
   * @param message - Human-readable description of the parse failure.
   * @param options - Optional options bag; `context` carries the offending
   *   file path, and `cause` carries the underlying parse error. The error
   *   code is always `"ERR_CONFIG_PARSE"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LConfigParseErrorOptions) {
    super(message, {
      code: "ERR_CONFIG_PARSE",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_CONFIG_PARSE";
  }
}
