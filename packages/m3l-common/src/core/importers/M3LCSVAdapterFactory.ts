/**
 * `core/importers/M3LCSVAdapterFactory` — builds `M3LCSVFormatAdapter`s.
 *
 * @packageDocumentation
 */

import { M3LCSVFormatAdapter } from "./M3LCSVFormatAdapter.js";

/**
 * Factory for {@link M3LCSVFormatAdapter} instances.
 *
 * @example
 * ```typescript
 * import { M3LCSVAdapterFactory } from "@m3l-automation/m3l-common/core";
 *
 * const factory = new M3LCSVAdapterFactory();
 * const adapter = factory.create({ columnMapping: { id: "id", name: "name" } });
 * ```
 */
export class M3LCSVAdapterFactory {
  /**
   * Builds a new {@link M3LCSVFormatAdapter} from `config`.
   *
   * @param config - Adapter configuration: an optional `columnMapping`
   *   record mapping raw CSV column headers to output property names.
   * @returns A new adapter usable as the `adapter` field of
   *   `M3LCSVListImporterOptions`.
   */
  create(
    config: { readonly columnMapping?: Record<string, string> } = {},
  ): M3LCSVFormatAdapter {
    return new M3LCSVFormatAdapter(config);
  }
}
