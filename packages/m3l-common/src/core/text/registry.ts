/**
 * The extractor registry — routes an extraction request to the right
 * registered extractor by MIME type, falling back to file extension.
 *
 * @packageDocumentation
 */

import path from "node:path";

import { M3LTextExtractionError } from "./errors.js";
import { M3LPlainTextExtractor } from "./plain-text.js";
import type {
  M3LTextExtractionOptions,
  M3LTextExtractionResult,
  M3LTextExtractor,
} from "./contract.js";

/**
 * Dispatches text extraction to the correct registered extractor, decoupling
 * format detection from extraction logic.
 *
 * Dispatch order: the first registered extractor whose `mimeTypes` includes the
 * requested MIME type wins; if none match, the registry falls back to the first
 * whose `extensions` includes the file's extension. On conflicts,
 * **first-registered wins**. When nothing matches, `extract()` throws an
 * {@link M3LTextExtractionError} naming the unsupported MIME type and extension
 * — it never returns a silent empty result.
 *
 * @example
 * ```ts
 * import {
 *   M3LTextExtractorRegistry,
 *   M3LTextExtractionError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const registry = new M3LTextExtractorRegistry();
 * try {
 *   const { text } = await registry.extract("text/plain", "./notes.txt");
 *   console.log(text);
 * } catch (error) {
 *   if (error instanceof M3LTextExtractionError) {
 *     console.error(error.code, error.message);
 *   }
 * }
 * ```
 */
export class M3LTextExtractorRegistry {
  readonly #extractors: M3LTextExtractor[];

  /**
   * Creates a registry.
   *
   * @param extractors - When omitted, the registry starts with a single
   *   {@link M3LPlainTextExtractor} (the dep-free core extractor, always
   *   available). When an array is passed, exactly those extractors are
   *   registered in array order and **no** default is added, giving the caller
   *   full control of precedence.
   */
  constructor(extractors?: readonly M3LTextExtractor[]) {
    this.#extractors =
      extractors === undefined
        ? [new M3LPlainTextExtractor()]
        : [...extractors];
  }

  /**
   * Appends an extractor. Registration order is the precedence order, and
   * `register()` always **appends** — so a later `register()` call has
   * **lower** precedence than every extractor already registered (including
   * the default {@link M3LPlainTextExtractor} added by the no-arg
   * constructor). To override a built-in for a given format, don't rely on
   * `register()` to reorder anything; instead place your extractor _before_
   * it via the constructor array form
   * (`new M3LTextExtractorRegistry([yours, ...builtins])`).
   *
   * @param extractor - The extractor to register.
   */
  register(extractor: M3LTextExtractor): void {
    this.#extractors.push(extractor);
  }

  /**
   * Routes an extraction request to the first matching registered extractor.
   *
   * @param mimeType - The source file's MIME type (checked first).
   * @param filePath - Path to the source file; its extension is the fallback.
   * @param options - Optional extraction options forwarded to the extractor.
   * @returns The uniform extraction result.
   * @throws {@link M3LTextExtractionError} if no registered extractor supports
   *   the MIME type or the file extension.
   */
  async extract(
    mimeType: string,
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult> {
    const byMime = this.#extractors.find((extractor) =>
      extractor.mimeTypes.includes(mimeType),
    );
    if (byMime !== undefined) return byMime.extract(filePath, options);

    const extension = path.extname(filePath).toLowerCase();
    const byExtension = this.#extractors.find((extractor) =>
      extractor.extensions.includes(extension),
    );
    if (byExtension !== undefined)
      return byExtension.extract(filePath, options);

    throw new M3LTextExtractionError(
      `no registered extractor supports MIME type '${mimeType}' or extension '${extension}'`,
      {
        code: "ERR_TEXT_EXTRACTION_UNSUPPORTED",
        context: { mimeType, extension },
      },
    );
  }
}
