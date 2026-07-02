/**
 * `core/importers/M3LCSVFormatAdapter` — a reusable column/format adapter for
 * `M3LCSVListImporter`.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { isDangerousKey } from "../security/index.js";

import { ERR_IMPORT_VALIDATION } from "../../internal/importers/resolveSource.js";

/**
 * A reusable column/format adapter: maps a raw CSV row
 * (`Record<string, string>`, as produced by the header-driven parse) to a
 * partial item using a configured column mapping.
 *
 * Constructed directly or via {@link M3LCSVAdapterFactory.create}, and passed
 * as the `adapter` field of `M3LCSVListImporterOptions`.
 *
 * @example
 * ```typescript
 * import { M3LCSVFormatAdapter } from "@m3l-automation/m3l-common/core";
 *
 * const adapter = new M3LCSVFormatAdapter({
 *   columnMapping: { id: "id", name: "name" },
 * });
 * adapter.map({ id: "1", name: "Ada" }); // { id: "1", name: "Ada" }
 * ```
 */
export class M3LCSVFormatAdapter {
  /** The configured raw-column-to-output-property mapping. */
  readonly #columnMapping: Record<string, string> | undefined;

  /**
   * Creates a CSV format adapter.
   *
   * @param config - Adapter configuration. `columnMapping` is optional; when
   *   omitted, {@link map} returns the raw row unchanged.
   * @throws {@link M3LError} with code `ERR_IMPORT_VALIDATION` when any
   *   `columnMapping` OUTPUT key is a prototype-pollution vector
   *   (`__proto__`, `constructor`, `prototype`) — checked once at
   *   construction, since the mapping targets are written as property keys
   *   on every mapped row.
   */
  constructor(
    config: { readonly columnMapping?: Record<string, string> } = {},
  ) {
    const mapping = config.columnMapping;
    if (mapping !== undefined) {
      for (const outputKey of Object.values(mapping)) {
        if (isDangerousKey(outputKey)) {
          throw new M3LError(
            `unsafe columnMapping output key: "${outputKey}"`,
            { code: ERR_IMPORT_VALIDATION, context: { outputKey } },
          );
        }
      }
    }
    this.#columnMapping = mapping;
  }

  /**
   * Maps a raw CSV row to a partial item using the configured column
   * mapping. Columns not present in the mapping are dropped; when no mapping
   * was configured, `row` is returned unchanged.
   *
   * @param row - A raw CSV row, keyed by header name.
   * @returns The mapped partial item.
   */
  map(row: Record<string, string>): Record<string, unknown> {
    const mapping = this.#columnMapping;
    if (mapping === undefined) return { ...row };

    const mapped: Record<string, unknown> = {};
    for (const [rawColumn, outputKey] of Object.entries(mapping)) {
      if (Object.hasOwn(row, rawColumn)) {
        mapped[outputKey] = row[rawColumn];
      }
    }
    return mapped;
  }
}
