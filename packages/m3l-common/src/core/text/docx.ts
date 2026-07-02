/**
 * DOCX text extractor backed by the optional `mammoth` peer dependency.
 *
 * @packageDocumentation
 */

import type * as Mammoth from "mammoth";

import { M3LTextExtractionError } from "./errors.js";
import type { M3LTextExtractionResult, M3LTextExtractor } from "./contract.js";

/**
 * Extracts raw text from DOCX files using `mammoth`'s `extractRawText()`
 * (images are dropped).
 *
 * `mammoth` is an **optional peer dependency** loaded via a lazy dynamic
 * `import()` on the first {@link extract} call — never at module load or
 * construction. If it is absent, `extract()` throws an
 * {@link M3LTextExtractionError} naming the missing dependency.
 *
 * @example
 * ```ts
 * import { M3LDocxTextExtractor } from "@m3l-automation/m3l-common/core";
 *
 * const extractor = new M3LDocxTextExtractor();
 * const { text } = await extractor.extract("./contract.docx");
 * ```
 */
export class M3LDocxTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".docx"];

  /**
   * Extracts the DOCX raw text.
   *
   * @param filePath - Path to the `.docx` file.
   * @returns The extracted text.
   * @throws {@link M3LTextExtractionError} if `mammoth` is absent or extraction
   *   fails.
   */
  async extract(filePath: string): Promise<M3LTextExtractionResult> {
    const mammoth = await loadMammoth();
    try {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return { text: value, truncated: false };
    } catch (cause) {
      throw new M3LTextExtractionError(
        `failed to extract DOCX text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }
}

/**
 * Lazily loads `mammoth`, wrapping an absent peer dependency as a typed error.
 */
async function loadMammoth(): Promise<typeof Mammoth> {
  try {
    return await import("mammoth");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'mammoth' for DOCX extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "mammoth" },
        cause,
      },
    );
  }
}
