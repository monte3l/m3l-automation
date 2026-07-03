/**
 * `core/files/M3LFileCopyError` — typed error for `M3LFileCopier`.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LFileCopyError}.
 *
 * `cause` and `context` are optional; the error code is always
 * `"ERR_FILE_COPY"` and is set automatically — callers must not supply it.
 */
interface M3LFileCopyErrorOptions {
  /**
   * Structured diagnostic detail, e.g. the offending option value or the
   * source/destination path involved in a batch-fatal failure.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, typically a raw Node.js `fs` error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LFileCopier} when constructor options are invalid
 * (`maxFileSizeBytes` / `largeFilePromptThresholdBytes` must be finite
 * positive integers) or when a batch-fatal I/O failure occurs — creating the
 * output directory tree, writing a file that already passed all per-file
 * checks, or writing the manifest.
 *
 * Recoverable per-file conditions (a source too large, a pre-existing
 * destination, an unreadable source, or a declined large-file prompt) are
 * never thrown; they are recorded as a skipped {@link M3LFileCopyResult}
 * entry so one bad file never aborts the batch.
 *
 * @example
 * ```ts
 * import { M3LFileCopyError } from "@m3l-automation/m3l-common/core";
 * import { mkdir } from "node:fs/promises";
 *
 * async function ensureOutputDir(outputDir: string): Promise<void> {
 *   try {
 *     await mkdir(outputDir, { recursive: true });
 *   } catch (cause) {
 *     throw new M3LFileCopyError("failed to create the output directory", {
 *       cause,
 *       context: { phase: "output-dir", outputDir },
 *     });
 *   }
 * }
 * ```
 */
export class M3LFileCopyError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_FILE_COPY"`. */
  override readonly code: "ERR_FILE_COPY";

  /**
   * Creates a new `M3LFileCopyError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `context` carries structured
   *   diagnostic detail and `cause` carries an underlying error, if
   *   applicable. The error code is always `"ERR_FILE_COPY"` — it cannot be
   *   overridden.
   */
  constructor(message: string, options?: M3LFileCopyErrorOptions) {
    super(message, {
      code: "ERR_FILE_COPY",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_FILE_COPY";
  }
}
