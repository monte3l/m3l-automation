/**
 * `core/exporters/types` — shared contracts for list exporters: the
 * `M3LListExporter<TItem>` interface, its streaming writer, its event map,
 * and the per-format option interfaces.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../errors/index.js";

/**
 * Strategy for resolving a column-name collision between a generated column
 * (produced by the exporter itself, e.g. a synthetic row index) and an
 * original column present in the row data.
 *
 * - `'keep-generated'` — the generated column's value wins.
 * - `'keep-original'` — the original row-data value wins.
 *
 * @example
 * ```typescript
 * import type { ColumnConflictStrategy } from "@m3l-automation/m3l-common/core";
 * const strategy: ColumnConflictStrategy = "keep-original";
 * ```
 */
export type ColumnConflictStrategy = "keep-generated" | "keep-original";

/**
 * Incremental writer returned by {@link M3LListExporter.exportStream}.
 *
 * Append items one at a time, then {@link M3LListExporterStreamWriter.close}
 * to flush and finalize the underlying output (e.g. writing a closing `]` for
 * a JSON array, or closing the file handle for CSV/HTML).
 *
 * @typeParam TItem - The shape of each appended item.
 * @example
 * ```typescript
 * import type { M3LListExporterStreamWriter } from "@m3l-automation/m3l-common/core";
 *
 * async function writeAll(
 *   writer: M3LListExporterStreamWriter<{ id: string }>,
 *   items: readonly { id: string }[],
 * ): Promise<void> {
 *   for (const item of items) {
 *     await writer.append(item);
 *   }
 *   await writer.close();
 * }
 * ```
 */
export interface M3LListExporterStreamWriter<TItem> {
  /**
   * Writes a single item to the underlying output.
   *
   * @param item - The item to append.
   * @returns A promise that resolves once the item has been written.
   */
  append(item: TItem): Promise<void>;

  /**
   * Finalizes the output (writes any closing syntax and closes the
   * underlying stream).
   *
   * @returns A promise that resolves once the output has been finalized.
   */
  close(): Promise<void>;
}

/**
 * Shared contract for list exporters: a batch `export` and an incremental
 * `exportStream`. Implementations (CSV, JSON/JSONL, HTML) write through an
 * `fs.WriteStream` and extend `M3LEventEmitterBase` to surface lifecycle
 * events.
 *
 * @typeParam TItem - The shape of each exported item.
 * @example
 * ```typescript
 * import type { M3LListExporter } from "@m3l-automation/m3l-common/core";
 *
 * async function exportAll(
 *   exporter: M3LListExporter<{ id: string }>,
 *   items: readonly { id: string }[],
 * ): Promise<void> {
 *   await exporter.export(items);
 * }
 * ```
 */
export interface M3LListExporter<TItem> {
  /**
   * Writes all `items` to the configured output in a single call.
   *
   * @param items - The items to export.
   * @returns A promise that resolves once every item has been written and
   *   the output has been finalized.
   */
  export(items: readonly TItem[]): Promise<void>;

  /**
   * Opens an incremental writer for the configured output.
   *
   * Synchronous — no I/O is awaited to obtain the writer itself; the
   * underlying resource (e.g. the write stream) is opened eagerly, and any
   * open failure surfaces asynchronously through the writer's `append`/`close`
   * promises and the `export:error` event.
   *
   * @returns A {@link M3LListExporterStreamWriter} for `TItem`.
   */
  exportStream(): M3LListExporterStreamWriter<TItem>;
}

/**
 * Payload carried by the `export:error` event.
 */
export interface M3LListExporterErrorPayload {
  /**
   * The error that caused the export to fail. Every list exporter always
   * emits an already-typed {@link M3LError} here.
   */
  readonly error: M3LError;
}

/**
 * Payload carried by the `export:started` event.
 */
export interface M3LListExporterStartedPayload {
  /** The destination file path the exporter is writing to. */
  readonly filePath: string;
}

/**
 * Payload carried by the `export:completed` event.
 */
export interface M3LListExporterCompletedPayload {
  /** The destination file path that was written. */
  readonly filePath: string;
}

/**
 * Event map shared by every list exporter (CSV, JSON/JSONL, HTML).
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LCSVListExporter<{ id: string }>({
 *   filePath: "./data/outputs/rows.csv",
 * });
 * exporter.on("export:error", (payload) => {
 *   console.error(payload.error);
 * });
 * ```
 */
export interface M3LListExporterEvents {
  /** Fired when writing begins. */
  readonly "export:started": M3LListExporterStartedPayload;
  /** Fired once writing has finished and the stream has been closed. */
  readonly "export:completed": M3LListExporterCompletedPayload;
  /** Fired when a write or serialization failure occurs. */
  readonly "export:error": M3LListExporterErrorPayload;
}

/**
 * Construction options for {@link M3LCSVListExporter}.
 *
 * @example
 * ```typescript
 * import type { M3LCSVListExporterOptions } from "@m3l-automation/m3l-common/core";
 * const options: M3LCSVListExporterOptions = {
 *   filePath: "./data/outputs/users.csv",
 *   conflictStrategy: "keep-original",
 * };
 * ```
 */
export interface M3LCSVListExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
  /**
   * Strategy for resolving a generated-vs-original column name collision.
   * Defaults to `'keep-generated'`.
   */
  readonly conflictStrategy?: ColumnConflictStrategy;
}

/**
 * The JSON output shape: a single top-level array, or newline-delimited
 * JSON (one object per line).
 */
export type M3LJSONListExporterFormat = "array" | "jsonl";

/**
 * Construction options for {@link M3LJSONListExporter}.
 *
 * @example
 * ```typescript
 * import type { M3LJSONListExporterOptions } from "@m3l-automation/m3l-common/core";
 * const options: M3LJSONListExporterOptions = {
 *   filePath: "./data/outputs/records.jsonl",
 *   format: "jsonl",
 * };
 * ```
 */
export interface M3LJSONListExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
  /**
   * Explicit output format, overriding the extension-based inference
   * (`.jsonl` maps to `'jsonl'`, anything else maps to `'array'`).
   */
  readonly format?: M3LJSONListExporterFormat;
}

/**
 * Construction options for {@link M3LHTMLListExporter}.
 *
 * @example
 * ```typescript
 * import type { M3LHTMLListExporterOptions } from "@m3l-automation/m3l-common/core";
 * const options: M3LHTMLListExporterOptions = {
 *   filePath: "./data/outputs/report.html",
 *   columns: ["id", "name"],
 * };
 * ```
 */
export interface M3LHTMLListExporterOptions {
  /** The destination file path. */
  readonly filePath: string;
  /**
   * Restricts and orders which fields are rendered as table columns.
   * Defaults to every key present on the first exported item.
   */
  readonly columns?: readonly string[];
}
