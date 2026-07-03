/**
 * Plain-text extractor — the dependency-free core extractor.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";

import { M3LTextExtractionError } from "./errors.js";
import type { M3LTextExtractionResult, M3LTextExtractor } from "./contract.js";

/**
 * Extracts plain `.txt` files using only Node's `fs`. Always available with the
 * base install — it pulls in no optional peer dependency.
 *
 * @example
 * ```ts
 * import { M3LPlainTextExtractor } from "@m3l-automation/m3l-common/core";
 *
 * const extractor = new M3LPlainTextExtractor();
 * const { text } = await extractor.extract("./notes.txt");
 * ```
 */
export class M3LPlainTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = ["text/plain"];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".txt"];

  /**
   * Reads the file as UTF-8 text.
   *
   * @param filePath - Path to the `.txt` file.
   * @returns The file contents as the uniform result shape.
   * @throws {@link M3LTextExtractionError} if the file cannot be read.
   */
  async extract(filePath: string): Promise<M3LTextExtractionResult> {
    try {
      const text = await readFile(filePath, "utf8");
      return { text, truncated: false };
    } catch (cause) {
      throw new M3LTextExtractionError(
        `failed to read plain-text file '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }
}
