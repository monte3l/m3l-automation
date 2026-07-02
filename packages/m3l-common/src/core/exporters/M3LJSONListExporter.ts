/**
 * `core/exporters/M3LJSONListExporter` — JSON array / JSONL list export.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import { M3LBaseListExporter } from "./internal/baseListExporter.js";
import { onceErrorEmitter } from "./internal/onceErrorEmitter.js";
import type { M3LWriteStreamLifecycle } from "./internal/writeStreamLifecycle.js";

import type {
  M3LJSONListExporterFormat,
  M3LJSONListExporterOptions,
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
export class M3LJSONListExporter<TItem> extends M3LBaseListExporter<TItem> {
  readonly #format: M3LJSONListExporterFormat;

  /**
   * Creates a JSON list exporter.
   *
   * @param options - Construction options. `format` overrides the
   *   extension-based inference (`.jsonl` maps to `'jsonl'`, else `'array'`).
   */
  constructor(options: M3LJSONListExporterOptions) {
    super(options.filePath);
    this.#format = options.format ?? formatFromExtension(options.filePath);
  }

  /**
   * Serializes `items` as a JSON array or newline-delimited JSON (JSONL),
   * per the configured format.
   *
   * @param items - The items to serialize.
   * @returns The JSON/JSONL file content.
   */
  protected renderBatch(items: readonly TItem[]): string {
    return this.#format === "jsonl"
      ? items.map((item) => `${JSON.stringify(item)}\n`).join("")
      : `[${items.map((item) => JSON.stringify(item)).join(",")}]`;
  }

  /**
   * Wraps a failure as a JSON-list-export {@link M3LError}.
   *
   * @param cause - The caught value.
   * @returns An {@link M3LError} chaining `cause`.
   */
  protected wrapError(cause: unknown): M3LError {
    return wrapJSONError(cause, this.filePath);
  }

  /**
   * Builds the incremental JSON/JSONL stream writer.
   *
   * @param lifecycle - The opened write-stream lifecycle.
   * @param onError - Emits `export:error` (guarded to fire at most once).
   * @returns The JSON stream writer.
   */
  protected createStreamWriter(
    lifecycle: M3LWriteStreamLifecycle,
    onError: (error: M3LError) => void,
  ): M3LListExporterStreamWriter<TItem> {
    return new M3LJSONStreamWriter<TItem>(
      lifecycle,
      this.#format,
      this.filePath,
      onError,
    );
  }
}
