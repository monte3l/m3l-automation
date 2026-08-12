/**
 * `core/importers/M3LTextFileImporter` — whole-file UTF-8 text reads.
 *
 * @packageDocumentation
 */

import {
  readSourceText,
  validatePositiveIntegerOption,
} from "../../internal/importers/resolveSource.js";

/**
 * Options accepted by {@link M3LTextFileImporter}'s constructor.
 *
 * @example
 * ```typescript
 * import type { M3LTextFileImporterOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LTextFileImporterOptions = { maxBytes: 1_000_000 };
 * ```
 */
export interface M3LTextFileImporterOptions {
  /**
   * The maximum number of bytes the source may occupy. Checked before any
   * content is buffered (a file-path source is checked via `stat`, never
   * read past the check). Defaults to unbounded when omitted.
   *
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` at construction
   *   when supplied and not a positive integer.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` from `read` when
   *   the source exceeds this bound.
   */
  readonly maxBytes?: number;
}

/**
 * Reads the decoded UTF-8 text content of a single file-level source, whole
 * (not streamed or parsed). Does not implement {@link M3LListImporter} and
 * shares no base class with the list importers.
 *
 * @example
 * ```typescript
 * import { M3LTextFileImporter } from "@m3l-automation/m3l-common/core";
 *
 * const importer = new M3LTextFileImporter({ maxBytes: 1_000_000 });
 * const text = await importer.read("./data/inputs/notes.txt");
 * ```
 */
export class M3LTextFileImporter {
  readonly #maxBytes: number | undefined;

  /**
   * Creates a text file importer.
   *
   * @param options - Importer options; see {@link M3LTextFileImporterOptions}.
   */
  constructor(options: M3LTextFileImporterOptions = {}) {
    validatePositiveIntegerOption(options.maxBytes, "maxBytes");
    this.#maxBytes = options.maxBytes;
  }

  /**
   * Reads `source` and returns its decoded UTF-8 text.
   *
   * @param source - A file path (read from disk) or an in-memory `Buffer`
   *   (decoded as UTF-8).
   * @returns A promise resolving to the decoded text of `source`.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
   *   path that cannot be read, chaining the underlying filesystem error, or
   *   when `source` exceeds the configured `maxBytes`.
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
    return readSourceText(source, this.#maxBytes);
  }
}
