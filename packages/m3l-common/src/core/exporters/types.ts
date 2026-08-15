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
export interface M3LListExporterStreamWriter<TItem extends object> {
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

  /**
   * The running total of bytes written to the underlying output so far,
   * counting from the resume offset the writer was opened with (`0` for a
   * fresh export).
   *
   * @remarks
   * Read this after an {@link M3LListExporterStreamWriter.append} call
   * resolves and checkpoint it; to resume a crashed/interrupted export, pass
   * that exact checkpointed value back in as the format-specific
   * `resumeFromByte` construction option, so the new writer picks up exactly
   * where the previous one left off.
   *
   * When this reflects a flushed byte count is format-dependent: CSV and
   * JSON/JSONL flush each row/item as it is appended, so `bytesWritten`
   * grows on every `append()`. HTML buffers every row until `close()` (its
   * `{{count}}` placeholder cannot be resolved until the item count is
   * known), so its `bytesWritten` reads `0` for the entire append phase and
   * only reflects the real total once `close()` resolves.
   */
  readonly bytesWritten: number;
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
export interface M3LListExporter<TItem extends object> {
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
  /**
   * Fired when a write or serialization failure occurs.
   *
   * @remarks
   * Emitted at most once per streaming writer instance: after the first
   * failure surfaces, a later distinct failure on the same writer still
   * rejects its own `append`/`close` call but is not re-emitted here. Consumers
   * relying on this event as a complete failure log should treat the rejected
   * promise, not the event stream, as the authoritative per-call signal.
   */
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
  /**
   * Resumes a streaming export ({@link M3LListExporter.exportStream}) from
   * this byte offset instead of writing from scratch: the file is truncated
   * to this offset and reopened for append. Requires `columns` (there is no
   * on-disk header left to re-derive columns from once truncated to a
   * mid-body offset). Ignored by the batch `export()` method, which always
   * writes a complete file from scratch. Defaults to `0`.
   */
  readonly resumeFromByte?: number;
  /**
   * The exact, ordered column set to use for this file.
   *
   * Required when `resumeFromByte > 0` (must match the header already
   * written). When supplied on a fresh export (`resumeFromByte` unset or
   * `0`), it still pins the column set/order from the very first appended
   * row rather than deriving it from that row's own keys — useful when a
   * caller must commit to a column set before it has seen any row (e.g.
   * deriving it from separate schema metadata).
   */
  readonly columns?: readonly string[];
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
  /**
   * Resumes a streaming export ({@link M3LListExporter.exportStream}) from
   * this byte offset instead of writing from scratch: the file is truncated
   * to this offset and reopened for append. In `'array'` format, the next
   * appended item emits a leading `,` instead of the opening `[` (the
   * on-disk prefix up to `resumeFromByte` is assumed to already hold a valid
   * open array with at least one item). Ignored by the batch `export()`
   * method, which always writes a complete file from scratch. Defaults to
   * `0`.
   */
  readonly resumeFromByte?: number;
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
