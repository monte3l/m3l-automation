/**
 * `core/importers/M3LCSVListImporter` — CSV list import with a
 * column-mapping/defaults/validation/transformation row pipeline.
 *
 * @packageDocumentation
 */

import { parse } from "csv-parse";

import type { CsvError } from "csv-parse";

import { M3LEventEmitterBase } from "../events/index.js";
import { M3LError } from "../errors/index.js";

import {
  ERR_IMPORT_VALIDATION,
  hasDangerousOwnKey,
  readSourceBytes,
  resolveSource,
  sourceLabel,
} from "../../internal/importers/resolveSource.js";

import { M3LCSVFormatAdapter } from "./M3LCSVFormatAdapter.js";

import type {
  M3LListImporter,
  M3LListImporterEvents,
  M3LListImporterResult,
} from "./M3LListImporter.js";

/**
 * Constructor options for {@link M3LCSVListImporter}.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import type { M3LCSVListImporterOptions } from "@m3l-automation/m3l-common/core";
 *
 * const csvPath = "./data/inputs/users.csv";
 * const options: M3LCSVListImporterOptions<{ id: string; name: string }> = {
 *   filePath: csvPath,
 *   columnMapping: { id: "id", name: "name" },
 * };
 * ```
 */
export interface M3LCSVListImporterOptions<TItem> {
  /**
   * The default source used when {@link M3LCSVListImporter.import} or
   * {@link M3LCSVListImporter.importStream} is called without a per-call
   * `source` argument.
   */
  readonly filePath?: string;

  /**
   * A reusable format adapter that maps a raw CSV row to a partial item.
   * When supplied, it runs in place of the plain `columnMapping` mapping
   * step. Mutually usable with `columnMapping`; if both are supplied,
   * `adapter` takes precedence for the mapping step.
   */
  readonly adapter?: M3LCSVFormatAdapter;

  /**
   * Maps a raw CSV column header to the output property name it should be
   * assigned to. Ignored when `adapter` is supplied.
   */
  readonly columnMapping?: Record<string, string>;

  /**
   * Default values merged into every row after column mapping, for any key
   * not already present on the mapped row.
   */
  readonly defaultValues?: Record<string, unknown>;

  /**
   * A boolean predicate run on every mapped-and-defaulted row. A falsy
   * result skips the row (emits `import:error`, does not throw).
   */
  readonly rowValidator?: (row: Record<string, unknown>) => boolean;

  /**
   * Transforms a validated, mapped-and-defaulted row into the final item
   * shape. Runs last in the per-row pipeline.
   */
  readonly rowTransformer?: (row: Record<string, unknown>) => TItem;
}

/**
 * Streams or batch-imports CSV content, running every row through a fixed
 * pipeline in this exact order: column mapping, default values, row
 * validation, row transformation.
 *
 * Backed by `csv-parse`: file-path sources are read and parsed row-by-row via
 * the async-iterator streaming API; `Buffer` sources are parsed in memory via
 * the same API, so both source kinds yield identical items.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import { M3LCSVListImporter } from "@m3l-automation/m3l-common/core";
 *
 * const csvPath = "./data/inputs/users.csv";
 * const importer = new M3LCSVListImporter<{ id: string; name: string }>({
 *   filePath: csvPath,
 * });
 * const result = await importer.import();
 * ```
 */
export class M3LCSVListImporter<TItem>
  extends M3LEventEmitterBase<M3LListImporterEvents<TItem>>
  implements M3LListImporter<TItem>
{
  readonly #options: M3LCSVListImporterOptions<TItem>;
  readonly #adapter: M3LCSVFormatAdapter;

  /**
   * Creates a CSV list importer.
   *
   * @param options - Importer options; see {@link M3LCSVListImporterOptions}.
   */
  constructor(options: M3LCSVListImporterOptions<TItem>) {
    super();
    this.#options = options;
    this.#adapter =
      options.adapter ??
      new M3LCSVFormatAdapter(
        options.columnMapping === undefined
          ? {}
          : { columnMapping: options.columnMapping },
      );
  }

  /**
   * Parses the CSV source and returns every successfully parsed row at once.
   *
   * @param source - A file path (streamed row-by-row) or an in-memory
   *   `Buffer` (parsed row-by-row in memory). When omitted, `options.filePath`
   *   is used.
   * @returns A promise resolving to the batch result.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when neither
   *   `source` nor `options.filePath` is supplied, or the source cannot be
   *   read.
   *
   * @example
   * ```typescript
   * import { M3LCSVListImporter } from "@m3l-automation/m3l-common/core";
   *
   * const csvPath = "./data/inputs/users.csv";
   * const importer = new M3LCSVListImporter<{ id: string }>({});
   * const result = await importer.import(csvPath);
   * ```
   */
  async import(
    source?: string | Buffer,
  ): Promise<M3LListImporterResult<TItem>> {
    const startedAt = Date.now();
    const resolved = resolveSource(source, this.#options.filePath);
    this.emit("import:started", { source: sourceLabel(resolved) });

    const items: TItem[] = [];
    const errors: { index: number; error: unknown }[] = [];
    let index = 0;

    for await (const outcome of this.#parseRows(resolved)) {
      if (outcome.ok) {
        items.push(outcome.item);
        this.emit("import:item", { item: outcome.item, index });
      } else {
        errors.push({ index, error: outcome.error });
        this.emit("import:error", { error: outcome.error, index });
      }
      index += 1;
      this.emit("import:progress", { processed: index });
    }

    const durationMs = Date.now() - startedAt;
    this.emit("import:completed", { processed: index, durationMs });
    return { items, errors, durationMs };
  }

  /**
   * Parses the CSV source and yields every successfully parsed row as soon
   * as it is available.
   *
   * @param source - A file path (streamed row-by-row) or an in-memory
   *   `Buffer` (parsed row-by-row in memory). When omitted, `options.filePath`
   *   is used.
   * @returns An async generator yielding one row at a time.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when neither
   *   `source` nor `options.filePath` is supplied, or the source cannot be
   *   read.
   *
   * @example
   * ```typescript
   * import { M3LCSVListImporter } from "@m3l-automation/m3l-common/core";
   *
   * const csvPath = "./data/inputs/users.csv";
   * const importer = new M3LCSVListImporter<{ id: string }>({});
   * for await (const row of importer.importStream(csvPath)) {
   *   // ...
   * }
   * ```
   */
  async *importStream(source?: string | Buffer): AsyncGenerator<TItem> {
    const startedAt = Date.now();
    const resolved = resolveSource(source, this.#options.filePath);
    this.emit("import:started", { source: sourceLabel(resolved) });

    let index = 0;
    for await (const outcome of this.#parseRows(resolved)) {
      if (outcome.ok) {
        this.emit("import:item", { item: outcome.item, index });
        index += 1;
        this.emit("import:progress", { processed: index });
        yield outcome.item;
      } else {
        this.emit("import:error", { error: outcome.error, index });
        index += 1;
        this.emit("import:progress", { processed: index });
      }
    }
    this.emit("import:completed", {
      processed: index,
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * Runs the raw-row → mapping → defaults → validator → transformer pipeline
   * over every row of `source`, in order, skipping rows that fail parsing,
   * validation, or transformation.
   *
   * @param source - The resolved source (file path or `Buffer`).
   * @returns An async generator yielding one pipeline outcome per row.
   */
  async *#parseRows(
    source: string | Buffer,
  ): AsyncGenerator<
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown }
  > {
    const bytes = await readSourceBytes(source);
    const skipped: unknown[] = [];
    let rowIndex = 0;

    const parser = parse(bytes, {
      columns: true,
      skip_records_with_error: true,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- `on_skip` is a fixed snake_case option key from the third-party csv-parse API, not a symbol this codebase names
      on_skip: (err: CsvError | undefined) => {
        if (err === undefined) return;
        // Wrap the third-party CsvError (extends plain Error, not M3LError) so
        // every value reaching import:error/errors[] is an M3LError; only
        // err.message is embedded, never raw row content.
        skipped.push(
          new M3LError(`row failed to parse: ${err.message}`, {
            code: ERR_IMPORT_VALIDATION,
            cause: err,
          }),
        );
      },
    });

    for await (const rawRecord of parser) {
      while (skipped.length > 0) {
        yield { ok: false, error: skipped.shift() };
        rowIndex += 1;
      }
      yield this.#runPipeline(rawRecord as Record<string, string>, rowIndex);
      rowIndex += 1;
    }
    while (skipped.length > 0) {
      yield { ok: false, error: skipped.shift() };
      rowIndex += 1;
    }
  }

  /**
   * Runs a single raw row through the column-mapping, default-values,
   * validator, and transformer stages, in that order, at row index `index`.
   *
   * Every stage runs inside a single `try/catch`: a thrown value from
   * `adapter.map`, `rowValidator`, or `rowTransformer` is a bad-RECORD
   * failure (per the importers contract), not a source failure — it is
   * converted into a skip outcome rather than escaping to abort the whole
   * import. As a final backstop, the transformed item itself is screened for
   * a dangerous own key (via {@link hasDangerousOwnKey}) immediately before
   * being reported as a success — this covers the no-`columnMapping`
   * passthrough case (an untouched raw CSV header named `constructor` or
   * `prototype` survives as an own key) without needing every intermediate
   * stage to duplicate the check.
   *
   * @param rawRow - The raw CSV row, keyed by header name.
   * @param index - The zero-based row index, used only in error messages
   *   (the row's own content is never embedded in a message string or
   *   attached as structured context).
   * @returns A pipeline outcome: the transformed item, or the failure that
   *   caused the row to be skipped.
   */
  #runPipeline(
    rawRow: Record<string, string>,
    index: number,
  ):
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown } {
    try {
      const mapped = this.#adapter.map(rawRow);
      const withDefaults: Record<string, unknown> = {
        ...this.#options.defaultValues,
        ...mapped,
      };

      const validator = this.#options.rowValidator;
      if (validator !== undefined && !validator(withDefaults)) {
        return {
          ok: false,
          error: new M3LError(`row ${String(index)} failed validation`, {
            code: ERR_IMPORT_VALIDATION,
            context: { index },
          }),
        };
      }

      const transformer = this.#options.rowTransformer;
      const item = (
        transformer !== undefined ? transformer(withDefaults) : withDefaults
      ) as TItem;

      if (hasDangerousOwnKey(item)) {
        return {
          ok: false,
          error: new M3LError(`row ${String(index)} carries an unsafe key`, {
            code: ERR_IMPORT_VALIDATION,
            context: { index },
          }),
        };
      }

      return { ok: true, item };
    } catch (cause) {
      if (cause instanceof M3LError) return { ok: false, error: cause };
      return {
        ok: false,
        error: new M3LError(`row ${String(index)} failed processing`, {
          code: ERR_IMPORT_VALIDATION,
          cause,
        }),
      };
    }
  }
}
