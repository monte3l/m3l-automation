/**
 * `core/importers/M3LListImporter` — the shared list-importer contract, its
 * event map, and its batch result type.
 *
 * @packageDocumentation
 */

/**
 * The typed event map every {@link M3LListImporter} implementation emits via
 * its inherited `M3LEventEmitterBase`.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import type { M3LListImporterEvents } from "@m3l-automation/m3l-common/core";
 *
 * function onProgress(
 *   payload: M3LListImporterEvents<{ id: string }>["import:progress"],
 * ): void {
 *   console.log(payload.processed);
 * }
 * ```
 */
export interface M3LListImporterEvents<TItem> {
  /** Emitted once, before any record is processed. */
  "import:started": { readonly source: string };
  /** Emitted once per successfully parsed item. */
  "import:item": { readonly item: TItem; readonly index: number };
  /** Emitted periodically while parsing proceeds (cadence is implementation-defined). */
  "import:progress": { readonly processed: number; readonly total?: number };
  /**
   * Emitted when a single record fails (bad row, failed validator, failed
   * transformer, or unparseable JSONL line). The record is skipped and
   * parsing continues; `index` is present whenever the failure is
   * attributable to a specific record.
   */
  "import:error": { readonly error: unknown; readonly index?: number };
  /** Emitted once, after every record has been processed (or skipped). */
  "import:completed": {
    readonly processed: number;
    readonly durationMs: number;
  };
}

/**
 * The result of a batch {@link M3LListImporter.import} call.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import type { M3LListImporterResult } from "@m3l-automation/m3l-common/core";
 *
 * function summarize(result: M3LListImporterResult<{ id: string }>): string {
 *   return `${String(result.items.length)} items in ${String(result.durationMs)}ms`;
 * }
 * ```
 */
export interface M3LListImporterResult<TItem> {
  /** The successfully parsed items, in source order. */
  readonly items: readonly TItem[];
  /** The record-level failures collected during the run, in source order. */
  readonly errors: readonly {
    readonly index: number;
    readonly error: unknown;
  }[];
  /** Wall-clock duration of the import, in milliseconds. */
  readonly durationMs: number;
}

/**
 * The shared contract implemented by every list importer (`M3LCSVListImporter`,
 * `M3LJSONListImporter`): a batch access pattern and a streaming access
 * pattern over the same underlying source.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import type { M3LListImporter } from "@m3l-automation/m3l-common/core";
 *
 * async function importAll<TItem>(
 *   importer: M3LListImporter<TItem>,
 *   source: string,
 * ): Promise<readonly TItem[]> {
 *   const result = await importer.import(source);
 *   return result.items;
 * }
 * ```
 */
export interface M3LListImporter<TItem> {
  /**
   * Parses `source` (or the importer's default source) and returns every
   * successfully parsed item at once.
   *
   * @param source - A file path (streamed) or an in-memory `Buffer`
   *   (processed in memory). When omitted, the importer's configured default
   *   source is used.
   * @returns A promise resolving to the batch result.
   */
  import(source?: string | Buffer): Promise<M3LListImporterResult<TItem>>;

  /**
   * Parses `source` (or the importer's default source) and yields each
   * successfully parsed item as soon as it is available, keeping memory
   * bounded for file-path sources.
   *
   * @param source - A file path (streamed) or an in-memory `Buffer`
   *   (processed in memory). When omitted, the importer's configured default
   *   source is used.
   * @returns An async generator yielding one item at a time.
   */
  importStream(source?: string | Buffer): AsyncGenerator<TItem>;
}
