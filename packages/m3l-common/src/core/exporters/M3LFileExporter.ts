/**
 * `core/exporters/M3LFileExporter` — whole-file text/binary writer.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { M3LError } from "../errors/index.js";

/** Construction options for {@link M3LFileExporter}. */
export interface M3LFileExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
}

/**
 * Writes a single whole-file output in one call. Unlike the list exporters,
 * `M3LFileExporter` does not extend the event emitter base and has no
 * `exportStream()` — it is a single-shot write.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LFileExporter({
 *   filePath: "./data/outputs/notes.txt",
 * });
 * await exporter.export("hello world");
 * ```
 */
export class M3LFileExporter {
  readonly #filePath: string;

  /**
   * Creates a whole-file exporter.
   *
   * @param options - Construction options.
   */
  constructor(options: M3LFileExporterOptions) {
    this.#filePath = options.filePath;
  }

  /**
   * Writes `content` to the configured `filePath`, overwriting any existing
   * file.
   *
   * @param content - The text or raw bytes to write.
   * @returns A promise that resolves once the write completes.
   * @throws {@link M3LError} chaining the underlying filesystem error.
   *
   * @example
   * ```typescript
   * import { M3LError } from "@m3l-automation/m3l-common/core";
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LFileExporter({
   *   filePath: "./data/outputs/notes.txt",
   * });
   * try {
   *   await exporter.export("hello world");
   * } catch (error) {
   *   if (error instanceof M3LError) console.error(error.code);
   * }
   * ```
   */
  async export(content: string | Buffer): Promise<void> {
    try {
      await fsp.writeFile(this.#filePath, content);
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LError(`failed to write file: ${this.#filePath}`, {
        code: "ERR_FILE_EXPORT",
        context: { filePath: this.#filePath },
        cause,
      });
    }
  }
}
