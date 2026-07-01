/**
 * `core/json/M3LJSONFormatDetectionError` — typed read-failure error for
 * {@link M3LJSONFormatDetector.detect}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LJSONFormatDetectionError}.
 *
 * `cause` is optional; the error code is always `"ERR_JSON_DETECT_READ"` and
 * is set automatically — callers must not supply it.
 */
interface M3LJSONFormatDetectionErrorOptions {
  /** The underlying filesystem error that triggered the read failure. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LJSONFormatDetector.detect} when the target file cannot
 * be read (e.g. it does not exist, or a permission error occurs) at any depth
 * other than `"extension"`, which never touches the filesystem.
 *
 * Callers that need to distinguish a detection read failure from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LJSONFormatDetector,
 *   M3LJSONFormatDetectionError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const detector = new M3LJSONFormatDetector();
 * try {
 *   const result = await detector.detect("./data/inputs/missing.json");
 * } catch (e) {
 *   if (e instanceof M3LJSONFormatDetectionError) {
 *     // the file could not be read; e.cause carries the underlying fs error
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LJSONFormatDetectionError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_JSON_DETECT_READ"`. */
  override readonly code: "ERR_JSON_DETECT_READ";

  /**
   * Creates a new `M3LJSONFormatDetectionError`.
   *
   * @param message - Human-readable description of the read failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   filesystem error. The error code is always `"ERR_JSON_DETECT_READ"` —
   *   it cannot be overridden.
   */
  constructor(message: string, options?: M3LJSONFormatDetectionErrorOptions) {
    super(message, { code: "ERR_JSON_DETECT_READ", cause: options?.cause });
    this.code = "ERR_JSON_DETECT_READ";
  }
}
