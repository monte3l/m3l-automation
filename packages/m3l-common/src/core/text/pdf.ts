/**
 * PDF text extractor backed by the optional `unpdf` peer dependency.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";

import type * as Unpdf from "unpdf";

import { M3LTextExtractionError } from "./errors.js";
import type { M3LTextExtractionResult, M3LTextExtractor } from "./contract.js";

/**
 * Extracts text and a page count from PDF files using `unpdf` (serverless-safe,
 * no native dependencies).
 *
 * `unpdf` is an **optional peer dependency** loaded via a lazy dynamic
 * `import()` on the first {@link extract} call — never at module load or
 * construction. If it is absent, `extract()` throws an
 * {@link M3LTextExtractionError} naming the missing dependency.
 *
 * @example
 * ```ts
 * import { M3LPdfTextExtractor } from "@m3l-automation/m3l-common/core";
 *
 * const extractor = new M3LPdfTextExtractor();
 * const { text, pages } = await extractor.extract("./report.pdf");
 * ```
 */
export class M3LPdfTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = ["application/pdf"];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".pdf"];

  /**
   * Extracts the PDF text and page count.
   *
   * @param filePath - Path to the `.pdf` file.
   * @returns The extracted text with a `pages` count.
   * @throws {@link M3LTextExtractionError} if `unpdf` is absent or extraction
   *   fails.
   */
  async extract(filePath: string): Promise<M3LTextExtractionResult> {
    const { extractText, getDocumentProxy } = await loadUnpdf();
    try {
      const data = await readFile(filePath);
      // `getDocumentProxy` resolves to unpdf's `PDFDocumentProxy`, whose type
      // lives behind a deep pdf.js subpath the linter's program cannot resolve
      // (it surfaces as an "error type", tripping no-unsafe-* on `.numPages`);
      // narrow the awaited value to the minimal shape we actually read.
      const pdf = (await getDocumentProxy(
        new Uint8Array(data),
      )) as unknown as PdfDocumentProxy;
      const { text } = await extractText(pdf, { mergePages: true });
      return { text, pages: pdf.numPages, truncated: false };
    } catch (cause) {
      throw new M3LTextExtractionError(
        `failed to extract PDF text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }
}

/**
 * Minimal structural view of unpdf's `PDFDocumentProxy` — only the `numPages`
 * field this extractor reads. The full type resides behind a deep pdf.js
 * subpath the type-aware linter cannot resolve, so we narrow to what we use.
 */
interface PdfDocumentProxy {
  readonly numPages: number;
}

/**
 * Lazily loads `unpdf`, wrapping an absent peer dependency as a typed error.
 */
async function loadUnpdf(): Promise<typeof Unpdf> {
  try {
    return await import("unpdf");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'unpdf' for PDF extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "unpdf" },
        cause,
      },
    );
  }
}
