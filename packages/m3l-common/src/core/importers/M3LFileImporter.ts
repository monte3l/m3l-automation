/**
 * `core/importers/M3LFileImporter` — whole-file raw-bytes reads.
 *
 * @packageDocumentation
 */

import { readSourceBytes } from "../../internal/importers/resolveSource.js";

/**
 * Reads the raw bytes of a single file-level source, whole (not streamed or
 * parsed). Does not implement {@link M3LListImporter} and shares no base
 * class with the list importers.
 *
 * @example
 * ```typescript
 * import { M3LFileImporter } from "@m3l-automation/m3l-common/core";
 *
 * const importer = new M3LFileImporter();
 * const bytes = await importer.read("./data/inputs/report.pdf");
 * ```
 */
export class M3LFileImporter {
  /**
   * Reads `source` and returns its raw bytes.
   *
   * @param source - A file path (read from disk) or an in-memory `Buffer`
   *   (returned as-is).
   * @returns A promise resolving to the raw bytes of `source`.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
   *   path that cannot be read, chaining the underlying filesystem error.
   *
   * @example
   * ```typescript
   * import { M3LError, M3LFileImporter } from "@m3l-automation/m3l-common/core";
   *
   * const importer = new M3LFileImporter();
   * try {
   *   const bytes = await importer.read("./data/inputs/missing.bin");
   * } catch (error) {
   *   if (error instanceof M3LError) {
   *     console.error(error.code, error.cause);
   *   }
   * }
   * ```
   */
  async read(source: string | Buffer): Promise<Buffer> {
    return readSourceBytes(source);
  }
}
