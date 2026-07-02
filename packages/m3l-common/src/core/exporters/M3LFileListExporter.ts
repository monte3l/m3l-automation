/**
 * `core/exporters/M3LFileListExporter` — whole-file list writer.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { M3LError } from "../errors/index.js";

/**
 * Construction options for {@link M3LFileListExporter}.
 *
 * @typeParam TItem - The shape of each exported item.
 */
export interface M3LFileListExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
}

/**
 * Writes an entire list of items to a single file in one call, as a JSON
 * array. Unlike {@link M3LJSONListExporter}, this exporter does not extend
 * the event emitter base, has no `exportStream()`, and never streams — the
 * whole list is serialized and written in a single `fsp.writeFile` call.
 *
 * @typeParam TItem - The shape of each exported item.
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LFileListExporter<{ id: string }>({
 *   filePath: "./data/outputs/list.json",
 * });
 * await exporter.export([{ id: "1" }, { id: "2" }]);
 * ```
 */
export class M3LFileListExporter<TItem> {
  readonly #filePath: string;

  /**
   * Creates a whole-file list exporter.
   *
   * @param options - Construction options.
   */
  constructor(options: M3LFileListExporterOptions) {
    this.#filePath = options.filePath;
  }

  /**
   * Serializes `items` as a JSON array and writes it to the configured
   * `filePath`, overwriting any existing file.
   *
   * @param items - The items to export.
   * @returns A promise that resolves once the write completes.
   * @throws {@link M3LError} chaining the underlying filesystem or
   *   serialization error.
   *
   * @example
   * ```typescript
   * import { M3LError } from "@m3l-automation/m3l-common/core";
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LFileListExporter<{ id: string }>({
   *   filePath: "./data/outputs/list.json",
   * });
   * try {
   *   await exporter.export([{ id: "1" }]);
   * } catch (error) {
   *   if (error instanceof M3LError) console.error(error.code);
   * }
   * ```
   */
  async export(items: readonly TItem[]): Promise<void> {
    try {
      const content = JSON.stringify(items);
      await fsp.writeFile(this.#filePath, content);
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LError(`failed to write file list: ${this.#filePath}`, {
        code: "ERR_FILE_LIST_EXPORT",
        context: { filePath: this.#filePath },
        cause,
      });
    }
  }
}
