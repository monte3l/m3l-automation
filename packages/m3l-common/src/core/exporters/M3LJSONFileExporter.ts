/**
 * `core/exporters/M3LJSONFileExporter` — whole-file JSON document writer.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { M3LError } from "../errors/index.js";

/** Construction options for {@link M3LJSONFileExporter}. */
export interface M3LJSONFileExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
}

/**
 * Writes a single value as a whole-file JSON document in one call. Unlike
 * {@link M3LJSONListExporter}, this exporter serializes any JSON-serializable
 * `value` (not necessarily a list), does not extend the event emitter base,
 * and has no `exportStream()`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LJSONFileExporter({
 *   filePath: "./data/outputs/document.json",
 * });
 * await exporter.export({ id: "1", nested: { flag: true } });
 * ```
 */
export class M3LJSONFileExporter {
  readonly #filePath: string;

  /**
   * Creates a whole-file JSON document exporter.
   *
   * @param options - Construction options.
   */
  constructor(options: M3LJSONFileExporterOptions) {
    this.#filePath = options.filePath;
  }

  /**
   * Serializes `value` with `JSON.stringify` and writes it to the configured
   * `filePath`, overwriting any existing file.
   *
   * @param value - The JSON-serializable value to write.
   * @returns A promise that resolves once the write completes.
   * @throws {@link M3LError} chaining the underlying filesystem or
   *   serialization error.
   *
   * @example
   * ```typescript
   * import { M3LError } from "@m3l-automation/m3l-common/core";
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LJSONFileExporter({
   *   filePath: "./data/outputs/document.json",
   * });
   * try {
   *   await exporter.export({ id: "1" });
   * } catch (error) {
   *   if (error instanceof M3LError) console.error(error.code);
   * }
   * ```
   */
  async export(value: unknown): Promise<void> {
    try {
      const content = JSON.stringify(value);
      await fsp.writeFile(this.#filePath, content);
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LError(`failed to write JSON file: ${this.#filePath}`, {
        code: "ERR_JSON_FILE_EXPORT",
        context: { filePath: this.#filePath },
        cause,
      });
    }
  }
}
