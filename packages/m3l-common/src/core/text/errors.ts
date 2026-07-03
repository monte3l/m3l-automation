/**
 * Typed error for the `core/text` extraction subsystem.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import type { M3LErrorOptions } from "../errors/index.js";

/**
 * The closed set of error codes an {@link M3LTextExtractionError} can carry:
 *
 * - `"ERR_TEXT_EXTRACTION"` — a generic extraction failure (unreadable source,
 *   corrupt input, or an exception from a backing library).
 * - `"ERR_TEXT_EXTRACTION_MISSING_DEP"` — an optional peer dependency for the
 *   requested format could not be loaded.
 * - `"ERR_TEXT_EXTRACTION_UNSUPPORTED"` — no registered extractor handles the
 *   given MIME type or extension.
 */
type M3LTextExtractionErrorCode =
  | "ERR_TEXT_EXTRACTION"
  | "ERR_TEXT_EXTRACTION_MISSING_DEP"
  | "ERR_TEXT_EXTRACTION_UNSUPPORTED";

/**
 * Constructor options for {@link M3LTextExtractionError} — mirrors
 * {@link M3LErrorOptions} but narrows `code` to the closed
 * {@link M3LTextExtractionErrorCode} union.
 */
interface M3LTextExtractionErrorOptions extends Omit<M3LErrorOptions, "code"> {
  /** The specific extraction failure code. */
  readonly code: M3LTextExtractionErrorCode;
}

/**
 * Raised when text extraction fails — an unreadable source file, a missing
 * optional peer dependency, or an exception thrown by a backing library.
 *
 * Always chains the underlying failure via {@link M3LErrorOptions.cause}; the
 * extraction subsystem never throws a bare string or lets an unwrapped library
 * exception (e.g. a raw `ERR_MODULE_NOT_FOUND`) escape.
 *
 * @example
 * ```ts
 * import { M3LTextExtractionError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   await registry.extract("application/pdf", "./report.pdf");
 * } catch (error) {
 *   if (error instanceof M3LTextExtractionError) {
 *     console.error(error.code, error.message, error.cause);
 *   }
 * }
 * ```
 */
export class M3LTextExtractionError extends M3LError {
  /** Narrows the inherited `code` to the closed extraction-code union. */
  override readonly code: M3LTextExtractionErrorCode;

  /**
   * Creates a new `M3LTextExtractionError`.
   *
   * @param message - Human-readable description of the extraction failure.
   * @param options - Required options bag carrying a
   *   {@link M3LTextExtractionErrorCode} `code`, optional `context`, and
   *   optional `cause` (the underlying failure to chain).
   */
  constructor(message: string, options: M3LTextExtractionErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}
