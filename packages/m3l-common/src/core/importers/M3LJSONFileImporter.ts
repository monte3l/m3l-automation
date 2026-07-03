/**
 * `core/importers/M3LJSONFileImporter` — whole-document JSON reads.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import {
  ERR_IMPORT_PARSE,
  readSourceText,
} from "../../internal/importers/resolveSource.js";

/**
 * Reads and parses a single file-level source as a whole JSON document (not
 * streamed, not dispatched between JSON/JSONL — use {@link M3LJSONListImporter}
 * for that). Does not implement {@link M3LListImporter} and shares no base
 * class with the list importers.
 *
 * @example
 * ```typescript
 * import { M3LJSONFileImporter } from "@m3l-automation/m3l-common/core";
 *
 * const importer = new M3LJSONFileImporter();
 * const doc = await importer.read<{ id: number }[]>("./data/inputs/records.json");
 * ```
 */
export class M3LJSONFileImporter {
  /**
   * Reads `source` and parses it as a whole JSON document.
   *
   * @typeParam T - The expected shape of the parsed document. Defaults to
   *   `unknown` — the caller is responsible for validating the parsed value.
   * @param source - A file path (read from disk) or an in-memory `Buffer`
   *   (decoded as UTF-8).
   * @returns A promise resolving to the parsed document.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
   *   path that cannot be read, chaining the underlying filesystem error.
   * @throws {@link M3LError} with code `ERR_IMPORT_PARSE` when `source`'s
   *   content is not valid JSON, chaining the underlying parse error.
   *
   * @example
   * ```typescript
   * import { M3LError, M3LJSONFileImporter } from "@m3l-automation/m3l-common/core";
   *
   * const importer = new M3LJSONFileImporter();
   * try {
   *   const doc = await importer.read("./data/inputs/malformed.json");
   * } catch (error) {
   *   if (error instanceof M3LError) {
   *     console.error(error.code, error.cause);
   *   }
   * }
   * ```
   */
  async read<T = unknown>(source: string | Buffer): Promise<T> {
    const text = await readSourceText(source);
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new M3LError("failed to parse JSON document", {
        code: ERR_IMPORT_PARSE,
        cause,
      });
    }
  }
}
