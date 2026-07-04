/**
 * `core/exporters/M3LCSVListExporter` — CSV list export via `csv-stringify`.
 *
 * @packageDocumentation
 */

import { stringify } from "csv-stringify/sync";

import { M3LError } from "../errors/index.js";

import { M3LBaseListExporter } from "./internal/baseListExporter.js";
import { onceErrorEmitter } from "./internal/onceErrorEmitter.js";
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
  ) {
    this.#lifecycle = lifecycle;
    this.#strategy = strategy;
    this.#filePath = filePath;
    this.#onError = onceErrorEmitter(onError);
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

  /**
   * Creates a CSV list exporter.
   *
   * @param options - Construction options; `conflictStrategy` defaults to
   *   `'keep-generated'`.
   */
  constructor(options: M3LCSVListExporterOptions) {
    super(options.filePath);
    this.#strategy = options.conflictStrategy ?? "keep-generated";
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
    );
  }
}
