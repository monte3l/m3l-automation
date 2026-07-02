/**
 * `core/importers/M3LTextFileImporter` — whole-file UTF-8 text reads.
 *
 * @packageDocumentation
 */

import { readSourceText } from "../../internal/importers/resolveSource.js";

/**
 * Reads the decoded UTF-8 text content of a single file-level source, whole
 * (not streamed or parsed). Does not implement {@link M3LListImporter} and
 * shares no base class with the list importers.
 *
 * @example
 * ```typescript
 * import { M3LTextFileImporter } from "@m3l-automation/m3l-common/core";
 *
 * const importer = new M3LTextFileImporter();
 * const text = await importer.read("./data/inputs/notes.txt");
 * ```
 */
export class M3LTextFileImporter {
  /**
   * Reads `source` and returns its decoded UTF-8 text.
   *
   * @param source - A file path (read from disk) or an in-memory `Buffer`
   *   (decoded as UTF-8).
   * @returns A promise resolving to the decoded text of `source`.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
   *   path that cannot be read, chaining the underlying filesystem error.
   *
   * @example
   * ```typescript
   * import { M3LError, M3LTextFileImporter } from "@m3l-automation/m3l-common/core";
   *
   * const importer = new M3LTextFileImporter();
   * try {
   *   const text = await importer.read("./data/inputs/missing.txt");
   * } catch (error) {
   *   if (error instanceof M3LError) {
   *     console.error(error.code, error.cause);
   *   }
   * }
   * ```
   */
  async read(source: string | Buffer): Promise<string> {
    return readSourceText(source);
  }
}
