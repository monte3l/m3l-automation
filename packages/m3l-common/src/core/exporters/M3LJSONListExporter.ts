/**
 * `core/exporters/M3LJSONListExporter` — JSON array / JSONL list export.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { M3LEventEmitterBase } from "../events/index.js";

import { onceErrorEmitter } from "./internal/onceErrorEmitter.js";
import { M3LWriteStreamLifecycle } from "./internal/writeStreamLifecycle.js";

import type {
  M3LJSONListExporterFormat,
  M3LJSONListExporterOptions,
  M3LListExporter,
  M3LListExporterEvents,
  M3LListExporterStreamWriter,
} from "./types.js";

/**
 * Infers the JSON list format from `filePath`'s extension: `.jsonl` yields
 * `'jsonl'`, anything else yields `'array'`.
 *
 * @param filePath - The destination file path.
 * @returns The inferred format.
 */
function formatFromExtension(filePath: string): M3LJSONListExporterFormat {
  return filePath.toLowerCase().endsWith(".jsonl") ? "jsonl" : "array";
}

/**
 * Wraps an unknown failure as an {@link M3LError} for JSON list export,
 * unless it is already one.
 *
 * @param cause - The caught value.
 * @param filePath - The destination file path, attached as error context.
 * @returns An {@link M3LError} chaining `cause`.
 */
function wrapJSONError(cause: unknown, filePath: string): M3LError {
  if (cause instanceof M3LError) return cause;
  return new M3LError("JSON list export failed", {
    code: "ERR_JSON_LIST_EXPORT",
    context: { filePath },
    cause,
  });
}

/**
 * Streaming JSON/JSONL writer returned by
 * {@link M3LJSONListExporter.exportStream}.
 *
 * @typeParam TItem - The shape of each appended item.
 */
class M3LJSONStreamWriter<TItem> implements M3LListExporterStreamWriter<TItem> {
  readonly #lifecycle: M3LWriteStreamLifecycle;
  readonly #format: M3LJSONListExporterFormat;
  readonly #filePath: string;
  readonly #onError: (error: M3LError) => void;
  #wroteFirst = false;
  #opened = false;

  constructor(
    lifecycle: M3LWriteStreamLifecycle,
    format: M3LJSONListExporterFormat,
    filePath: string,
    onError: (error: M3LError) => void,
  ) {
    this.#lifecycle = lifecycle;
    this.#format = format;
    this.#filePath = filePath;
    this.#onError = onceErrorEmitter(onError);
  }

  async append(item: TItem): Promise<void> {
    try {
      const serialized = JSON.stringify(item);
      let chunk: string;
      if (this.#format === "jsonl") {
        chunk = `${serialized}\n`;
      } else {
        const prefix = this.#opened ? "" : "[";
        const separator = this.#wroteFirst ? "," : "";
        chunk = `${prefix}${separator}${serialized}`;
      }
      this.#opened = true;
      this.#wroteFirst = true;
      await this.#lifecycle.write(chunk);
    } catch (cause) {
      const error = wrapJSONError(cause, this.#filePath);
      this.#onError(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.#format === "array") {
        const closing = this.#opened ? "]" : "[]";
        await this.#lifecycle.end(closing);
      } else {
        await this.#lifecycle.end();
      }
    } catch (cause) {
      const error = wrapJSONError(cause, this.#filePath);
      this.#onError(error);
      throw error;
    }
  }
}

/**
 * Writes a list of items as either a single JSON array or newline-delimited
 * JSON (JSONL), inferring the format from `filePath`'s extension unless
 * overridden via `options.format`.
 *
 * @typeParam TItem - The shape of each exported item.
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LJSONListExporter<{ id: string }>({
 *   filePath: "./data/outputs/records.jsonl",
 * });
 * await exporter.export([{ id: "1" }, { id: "2" }]);
 * ```
 */
export class M3LJSONListExporter<TItem>
  extends M3LEventEmitterBase<M3LListExporterEvents>
  implements M3LListExporter<TItem>
{
  readonly #filePath: string;
  readonly #format: M3LJSONListExporterFormat;

  /**
   * Creates a JSON list exporter.
   *
   * @param options - Construction options. `format` overrides the
   *   extension-based inference (`.jsonl` maps to `'jsonl'`, else `'array'`).
   */
  constructor(options: M3LJSONListExporterOptions) {
    super();
    this.#filePath = options.filePath;
    this.#format = options.format ?? formatFromExtension(options.filePath);
  }

  /**
   * Writes all `items` in a single call, in the configured format.
   *
   * @param items - The items to export.
   * @returns A promise that resolves once the file has been written.
   * @throws {@link M3LError} chaining the underlying failure; also emitted
   *   via `export:error`.
   *
   * @example
   * ```typescript
   * import { M3LError } from "@m3l-automation/m3l-common/core";
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LJSONListExporter<{ id: string }>({
   *   filePath: "./data/outputs/records.json",
   * });
   * try {
   *   await exporter.export([{ id: "1" }]);
   * } catch (error) {
   *   if (error instanceof M3LError) console.error(error.code);
   * }
   * ```
   */
  async export(items: readonly TItem[]): Promise<void> {
    this.emit("export:started", { filePath: this.#filePath });
    try {
      const lifecycle = new M3LWriteStreamLifecycle(this.#filePath);
      const content =
        this.#format === "jsonl"
          ? items.map((item) => `${JSON.stringify(item)}\n`).join("")
          : `[${items.map((item) => JSON.stringify(item)).join(",")}]`;
      await lifecycle.end(content);
      this.emit("export:completed", { filePath: this.#filePath });
    } catch (cause) {
      const error = wrapJSONError(cause, this.#filePath);
      this.emit("export:error", { error });
      throw error;
    }
  }

  /**
   * Opens an incremental JSON/JSONL writer.
   *
   * @returns A {@link M3LListExporterStreamWriter} for `TItem`.
   *
   * @example
   * ```typescript
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const exporter = new Core.M3LJSONListExporter<{ id: string }>({
   *   filePath: "./data/outputs/records.jsonl",
   * });
   * const writer = exporter.exportStream();
   * await writer.append({ id: "1" });
   * await writer.close();
   * ```
   */
  exportStream(): M3LListExporterStreamWriter<TItem> {
    this.emit("export:started", { filePath: this.#filePath });
    const lifecycle = new M3LWriteStreamLifecycle(this.#filePath);
    const writer = new M3LJSONStreamWriter<TItem>(
      lifecycle,
      this.#format,
      this.#filePath,
      (error) => {
        this.emit("export:error", { error });
      },
    );
    return {
      append: (item) => writer.append(item),
      close: async () => {
        await writer.close();
        this.emit("export:completed", { filePath: this.#filePath });
      },
    };
  }
}
