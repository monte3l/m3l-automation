/**
 * `core/exporters/M3LCSVListExporter` — CSV list export via `csv-stringify`.
 *
 * @packageDocumentation
 */

import { stringify } from "csv-stringify/sync";

import { M3LError } from "../errors/index.js";

import { M3LBaseListExporter } from "./internal/baseListExporter.js";
import { onceErrorEmitter } from "./internal/onceErrorEmitter.js";
import { isValidResumeFromByte } from "./internal/writeStreamLifecycle.js";
import type { M3LWriteStreamLifecycle } from "./internal/writeStreamLifecycle.js";

import type {
  ColumnConflictStrategy,
  M3LCSVListExporterOptions,
  M3LListExporterStreamWriter,
} from "./types.js";

/**
 * Merges the generated column order with a row's own keys per `strategy`:
 * `'keep-generated'` puts the generated (first-seen) order first,
 * `'keep-original'` puts the row's own key order first.
 *
 * @param generatedColumns - Column names derived from the first exported item.
 * @param row - The current row being serialized.
 * @param strategy - How to resolve generated-vs-original column ordering.
 * @returns The row, expressed as a plain record over the resolved columns.
 */
function resolveRow(
  generatedColumns: readonly string[],
  row: Record<string, unknown>,
  strategy: ColumnConflictStrategy,
): Record<string, unknown> {
  const rowColumns = Object.keys(row);
  const columns =
    strategy === "keep-generated"
      ? [...new Set([...generatedColumns, ...rowColumns])]
      : [...new Set([...rowColumns, ...generatedColumns])];

  const resolved: Record<string, unknown> = {};
  for (const column of columns) {
    resolved[column] = row[column];
  }
  return resolved;
}

/**
 * Streaming CSV writer returned by {@link M3LCSVListExporter.exportStream}.
 *
 * @typeParam TItem - The shape of each appended item.
 */
class M3LCSVStreamWriter<
  TItem extends object,
> implements M3LListExporterStreamWriter<TItem> {
  readonly #lifecycle: M3LWriteStreamLifecycle;
  readonly #strategy: ColumnConflictStrategy;
  readonly #filePath: string;
  readonly #onError: (error: M3LError) => void;
  #columns: readonly string[] | undefined;
  #headerWritten = false;

  constructor(
    lifecycle: M3LWriteStreamLifecycle,
    strategy: ColumnConflictStrategy,
    filePath: string,
    onError: (error: M3LError) => void,
    columns: readonly string[] | undefined,
    resumeFromByte: number,
  ) {
    this.#lifecycle = lifecycle;
    this.#strategy = strategy;
    this.#filePath = filePath;
    this.#onError = onceErrorEmitter(onError);
    // A caller-pinned column set is used verbatim instead of deriving it
    // lazily from the first appended row's own keys (see append() below) —
    // required on resume (there is no on-disk header left to re-derive from
    // past a mid-body truncation offset) and useful on a fresh export when
    // the caller must commit to a column set before seeing any row.
    if (columns !== undefined) {
      this.#columns = columns;
    }
    // Resuming mid-file: the header line was already written before the
    // truncation offset, so this writer must not emit another one.
    if (resumeFromByte > 0) {
      this.#headerWritten = true;
    }
  }

  /**
   * The running total of bytes written so far, delegated straight to the
   * underlying lifecycle (which already accounts for the resume offset).
   */
  get bytesWritten(): number {
    return this.#lifecycle.bytesWritten;
  }

  async append(item: TItem): Promise<void> {
    try {
      // `TItem extends object` bounds the type but doesn't add an index
      // signature; the cast is still required to pass `item` into the
      // `Record<string, unknown>`-typed row helpers below.
      const row = item as Record<string, unknown>;
      this.#columns ??= Object.keys(row);
      const resolved = resolveRow(this.#columns, row, this.#strategy);
      const line = stringify([resolved], {
        header: !this.#headerWritten,
        columns: this.#columns,
      });
      this.#headerWritten = true;
      await this.#lifecycle.write(line);
    } catch (cause) {
      const error = wrapCSVError(cause, this.#filePath);
      this.#onError(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.#lifecycle.end();
    } catch (cause) {
      const error = wrapCSVError(cause, this.#filePath);
      this.#onError(error);
      throw error;
    }
  }
}

/**
 * Wraps an unknown failure as an {@link M3LError} for CSV export, unless it
 * is already one.
 *
 * @param cause - The caught value.
 * @param filePath - The destination file path, attached as error context.
 * @returns An {@link M3LError} chaining `cause`.
 */
function wrapCSVError(cause: unknown, filePath: string): M3LError {
  if (cause instanceof M3LError) return cause;
  return new M3LError("CSV export failed", {
    code: "ERR_CSV_EXPORT",
    context: { filePath },
    cause,
  });
}

/**
 * Writes a list of items as CSV, using `csv-stringify` over an
 * `fs.WriteStream`. Supports both a batch `export()` and an incremental
 * `exportStream()`.
 *
 * @typeParam TItem - The shape of each exported item.
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LCSVListExporter<{ id: string; name: string }>({
 *   filePath: "./data/outputs/users.csv",
 * });
 * await exporter.export([{ id: "1", name: "Ada" }]);
 * ```
 */
export class M3LCSVListExporter<
  TItem extends object,
> extends M3LBaseListExporter<TItem> {
  readonly #strategy: ColumnConflictStrategy;
  readonly #columns: readonly string[] | undefined;

  /**
   * Creates a CSV list exporter.
   *
   * @param options - Construction options; `conflictStrategy` defaults to
   *   `'keep-generated'`.
   * @throws {@link M3LError} with code `ERR_CSV_EXPORT` if `resumeFromByte`
   *   is not a non-negative integer, or if it is greater than `0` and
   *   `columns` is not supplied as a non-empty array — a resumed file has
   *   no on-disk header left to re-derive columns from past the truncation
   *   offset, so the caller must supply the exact header that was already
   *   written.
   */
  constructor(options: M3LCSVListExporterOptions) {
    if (
      options.resumeFromByte !== undefined &&
      !isValidResumeFromByte(options.resumeFromByte)
    ) {
      throw new M3LError("resumeFromByte must be a non-negative integer", {
        code: "ERR_CSV_EXPORT",
        context: {
          filePath: options.filePath,
          resumeFromByte: options.resumeFromByte,
        },
      });
    }
    const resumeFromByte = options.resumeFromByte ?? 0;
    if (
      resumeFromByte > 0 &&
      (options.columns === undefined || options.columns.length === 0)
    ) {
      throw new M3LError(
        "CSV export resume requires non-empty 'columns' (the header already written to the file being resumed)",
        { code: "ERR_CSV_EXPORT", context: { filePath: options.filePath } },
      );
    }
    super(options.filePath, resumeFromByte);
    this.#strategy = options.conflictStrategy ?? "keep-generated";
    this.#columns = options.columns;
  }

  /**
   * Serializes `items` as a complete CSV document (header + rows).
   *
   * @param items - The items to serialize.
   * @returns The CSV file content.
   */
  protected renderBatch(items: readonly TItem[]): string {
    // See the cast rationale in M3LCSVStreamWriter.append above: `object`
    // lacks the index signature `resolveRow` requires.
    const rows = items as readonly Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
    const resolved = rows.map((row) =>
      resolveRow(columns, row, this.#strategy),
    );
    return stringify(resolved, { header: true, columns });
  }

  /**
   * Wraps a CSV-export failure as an {@link M3LError}.
   *
   * @param cause - The caught value.
   * @returns An {@link M3LError} chaining `cause`.
   */
  protected wrapError(cause: unknown): M3LError {
    return wrapCSVError(cause, this.filePath);
  }

  /**
   * Builds the incremental CSV stream writer.
   *
   * @param lifecycle - The opened write-stream lifecycle.
   * @param onError - Emits `export:error` (guarded to fire at most once).
   * @returns The CSV stream writer.
   */
  protected createStreamWriter(
    lifecycle: M3LWriteStreamLifecycle,
    onError: (error: M3LError) => void,
  ): M3LListExporterStreamWriter<TItem> {
    return new M3LCSVStreamWriter<TItem>(
      lifecycle,
      this.#strategy,
      this.filePath,
      onError,
      this.#columns,
      this.resumeFromByte,
    );
  }
}
