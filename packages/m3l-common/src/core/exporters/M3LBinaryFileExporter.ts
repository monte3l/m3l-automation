/**
 * `core/exporters/M3LBinaryFileExporter` — whole-file raw binary writer.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { M3LError } from "../errors/index.js";

/** Construction options for {@link M3LBinaryFileExporter}. */
export interface M3LBinaryFileExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
}

/**
 * Writes raw binary content to a single file in one call. Does not extend
 * the event emitter base and has no `exportStream()`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LBinaryFileExporter({
 *   filePath: "./data/outputs/blob.bin",
 * });
 * await exporter.export(Buffer.from([0x00, 0x01, 0xff]));
 * ```
 */
export class M3LBinaryFileExporter {
  readonly #filePath: string;

  /**
   * Creates a whole-file binary exporter.
   *
   * @param options - Construction options.
   */
  constructor(options: M3LBinaryFileExporterOptions) {
    this.#filePath = options.filePath;
  }

  /**
   * Writes `content` to the configured `filePath`, overwriting any existing
   * file.
   *
   * @param content - The raw bytes to write.
   * @returns A promise that resolves once the write completes.
   * @throws {@link M3LError} chaining the underlying filesystem error.
   *
   * @example
   * ```typescript
   * import { M3LError } from "@m3l-automation/m3l-common/core";
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LBinaryFileExporter({
   *   filePath: "./data/outputs/blob.bin",
   * });
   * try {
   *   await exporter.export(new Uint8Array([1, 2, 3]));
   * } catch (error) {
   *   if (error instanceof M3LError) console.error(error.code);
   * }
   * ```
   */
  async export(content: Buffer | Uint8Array): Promise<void> {
    try {
      await fsp.writeFile(this.#filePath, content);
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LError(`failed to write binary file: ${this.#filePath}`, {
        code: "ERR_BINARY_FILE_EXPORT",
        context: { filePath: this.#filePath },
        cause,
      });
    }
  }
}
