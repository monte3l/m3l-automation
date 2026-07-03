/**
 * `core/importers/M3LFileListImporter` — reads several file-level sources at
 * once.
 *
 * @packageDocumentation
 */

import { readSourceBytes } from "../../internal/importers/resolveSource.js";

/**
 * Reads the raw bytes of several file-level sources, in order. Does not
 * implement {@link M3LListImporter} and shares no base class with the list
 * importers.
 *
 * @example
 * ```typescript
 * import { M3LFileListImporter } from "@m3l-automation/m3l-common/core";
 *
 * const importer = new M3LFileListImporter();
 * const contents = await importer.read([
 *   "./data/inputs/a.bin",
 *   "./data/inputs/b.bin",
 * ]);
 * ```
 */
export class M3LFileListImporter {
  /**
   * Reads every source in `sources` and returns their raw bytes, in the same
   * order.
   *
   * @param sources - A list of file paths (read from disk) and/or in-memory
   *   `Buffer`s (returned as-is).
   * @returns A promise resolving to the raw bytes of each source, in order.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when any source is
   *   a path that cannot be read, chaining the underlying filesystem error.
   *
   * @example
   * ```typescript
   * import { M3LError, M3LFileListImporter } from "@m3l-automation/m3l-common/core";
   *
   * const importer = new M3LFileListImporter();
   * try {
   *   const contents = await importer.read(["./data/inputs/missing.bin"]);
   * } catch (error) {
   *   if (error instanceof M3LError) {
   *     console.error(error.code, error.cause);
   *   }
   * }
   * ```
   */
  async read(
    sources: readonly (string | Buffer)[],
  ): Promise<readonly Buffer[]> {
    // Sequential by design: bounds open-file-descriptor usage on a large
    // source list and gives simple first-failure error semantics (the first
    // unreadable source rejects immediately, rather than every in-flight
    // read racing to settle under Promise.all).
    const results: Buffer[] = [];
    for (const source of sources) {
      results.push(await readSourceBytes(source));
    }
    return results;
  }
}
