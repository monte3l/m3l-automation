/**
 * `core/importers/M3LCSVListImporter` — CSV list import with a
 * column-mapping/defaults/validation/transformation row pipeline.
 *
 * @packageDocumentation
 */

import { Parser } from "csv-parse";

import type { CsvError } from "csv-parse";

import { M3LEventEmitterBase } from "../events/index.js";
import { M3LError } from "../errors/index.js";

import {
  ERR_IMPORT_VALIDATION,
  assertRowBudget,
  hasDangerousOwnKey,
  readSourceBytes,
  resolveSource,
  sourceLabel,
  validatePositiveIntegerOption,
} from "../../internal/importers/resolveSource.js";

import { M3LCSVFormatAdapter } from "./M3LCSVFormatAdapter.js";

import type {
  M3LImportStreamSummary,
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

  /**
   * The maximum number of bytes the source may occupy. Checked before any
   * content is buffered (a file-path source is checked via `stat`, never
   * read past the check). Defaults to unbounded when omitted.
   *
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` at construction
   *   when supplied and not a positive integer.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` from `import`/
   *   `importStream` when the source exceeds this bound.
   */
  readonly maxBytes?: number;

  /**
   * The maximum number of rows the import may attempt (every attempt counts,
   * including a row later skipped as invalid). Defaults to unbounded when
   * omitted.
   *
   * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` at construction
   *   when supplied and not a positive integer.
   * @throws {@link M3LError} with code `ERR_IMPORT_VALIDATION` from
   *   `import`/`importStream` when the row count reaches this bound.
   */
  readonly maxRows?: number;
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
  /**
   * The byte size of each chunk fed to the CSV parser's writable side in
   * {@link M3LCSVListImporter.#parseRows}. 64 KiB is small enough that a
   * burst of `on_skip` calls triggered within a single chunk (the
   * pathological all-malformed-source case) is bounded to roughly one
   * chunk's worth of rows before the budget check between writes can react,
   * while still being large enough to keep the per-chunk `.write()`
   * overhead negligible for a well-formed source.
   */
  static readonly #parseChunkBytes = 65_536; // 64 KiB

  readonly #options: M3LCSVListImporterOptions<TItem>;
  readonly #adapter: M3LCSVFormatAdapter;
  readonly #maxBytes: number | undefined;
  readonly #maxRows: number | undefined;

  /**
   * Creates a CSV list importer.
   *
   * @param options - Importer options; see {@link M3LCSVListImporterOptions}.
   */
  constructor(options: M3LCSVListImporterOptions<TItem>) {
    super();
    validatePositiveIntegerOption(options.maxBytes, "maxBytes");
    validatePositiveIntegerOption(options.maxRows, "maxRows");
    this.#maxBytes = options.maxBytes;
    this.#maxRows = options.maxRows;
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
   * @returns An async generator yielding one row at a time and, once
   *   drained, returning an {@link M3LImportStreamSummary}.
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
  async *importStream(
    source?: string | Buffer,
  ): AsyncGenerator<TItem, M3LImportStreamSummary, void> {
    const startedAt = Date.now();
    const resolved = resolveSource(source, this.#options.filePath);
    this.emit("import:started", { source: sourceLabel(resolved) });

    let index = 0;
    let skipped = 0;
    let failed = false;
    try {
      for await (const outcome of this.#parseRows(resolved)) {
        if (outcome.ok) {
          this.emit("import:item", { item: outcome.item, index });
          index += 1;
          this.emit("import:progress", { processed: index });
          yield outcome.item;
        } else {
          this.emit("import:error", { error: outcome.error, index });
          index += 1;
          skipped += 1;
          this.emit("import:progress", { processed: index });
        }
      }
      return { processed: index, skipped, durationMs: Date.now() - startedAt };
    } catch (cause) {
      // A genuine internal failure (unreadable source, parser error) reaches
      // here via a *throw* completion; mark it so the `finally` block below
      // knows to withhold `import:completed` before re-throwing unchanged.
      failed = true;
      throw cause;
    } finally {
      // Runs on both normal completion and early abandonment (a consumer
      // `break`ing its own `for await` or calling `.return()` directly on
      // this generator resumes here via the async-generator-return protocol,
      // skipping the `return` statement above and never entering the `catch`
      // block, since a `.return()` unwind is a *return* completion, not a
      // *throw* one) — either way `import:completed` must fire with the
      // counts as they stood at the point of exit, and is deliberately
      // skipped when the loop throws (see the `catch` above), so a failed
      // run is never misreported as completed.
      if (!failed) {
        this.emit("import:completed", {
          processed: index,
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }

  /**
   * Creates a `csv-parse` `Parser` configured to skip malformed rows,
   * accumulating each skip's wrapped `M3LError` into `skipped` (in encounter
   * order) instead of surfacing it through the parser's own event API.
   *
   * A synchronous no-op `'error'` listener is attached immediately: a parser
   * torn down mid-stream by {@link M3LCSVListImporter.#feedParser} (or by a
   * narrow timing race around it) can otherwise crash the process with an
   * unhandled `'error'` event. This listener is a pure safety net — the
   * `for await` loop in {@link M3LCSVListImporter.#parseRows} still observes
   * the identical failure through the stream's own destroyed/errored state,
   * so attaching it does not change what the consumer sees.
   *
   * @param skipped - The array a malformed row's wrapped error is pushed
   *   onto, shared with the caller.
   * @returns A newly constructed, not-yet-fed `Parser`.
   */
  #createParser(skipped: unknown[]): Parser {
    const parser = new Parser({
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
    parser.on("error", () => {
      /* handled via the for-await loop and the trailing budget check in #parseRows */
    });
    return parser;
  }

  /**
   * Feeds `bytes` to `parser` via separate, bounded-size `.write()` calls
   * (instead of the `parse(bytes, options)` convenience form's single
   * whole-buffer write), checking the running skip count BETWEEN writes so a
   * `maxRows`-exceeding burst of malformed rows is caught after only the
   * chunk that produced it — bounding the work done on a pathological
   * all/mostly-malformed source to that one chunk instead of the whole
   * source. See {@link M3LCSVListImporter.#parseRows} for why a single write
   * cannot be bounded this way at all.
   *
   * `skipped.length` alone (no separate row-index term) is the correct
   * budget signal here: this method always runs before any record has been
   * consumed from `parser`, so the row index the caller tracks is still
   * zero for the whole of this call.
   *
   * @param parser - The parser to feed; assumed freshly created and unfed.
   * @param bytes - The raw CSV bytes to write.
   * @param skipped - The same array {@link M3LCSVListImporter.#createParser}
   *   pushes accumulated skip errors onto, read here (not mutated).
   * @returns `true` when `maxRows` was reached mid-write and `parser` was
   *   torn down via `destroy()` instead of `end()`.
   */
  #feedParser(
    parser: Parser,
    bytes: Buffer,
    skipped: readonly unknown[],
  ): boolean {
    let budgetTripped = false;
    for (
      let offset = 0;
      offset < bytes.length;
      offset += M3LCSVListImporter.#parseChunkBytes
    ) {
      parser.write(
        bytes.subarray(offset, offset + M3LCSVListImporter.#parseChunkBytes),
      );
      if (this.#maxRows !== undefined && skipped.length >= this.#maxRows) {
        budgetTripped = true;
        parser.destroy();
        break;
      }
    }
    if (!budgetTripped) parser.end();
    return budgetTripped;
  }

  /**
   * Runs the raw-row → mapping → defaults → validator → transformer pipeline
   * over every row of `source`, in order, skipping rows that fail parsing,
   * validation, or transformation.
   *
   * `maxRows` is enforced twice for a reason: the per-row `assertRowBudget`
   * calls below are the correctness backstop for the ordinary case
   * (including one where good and bad rows are interleaved), but they cannot
   * by themselves bound the WORK done on a pathological all/mostly-malformed
   * source. Feeding the whole buffer to `csv-parse` as a single write (the
   * `parse(bytes, options)` convenience form) makes its `on_skip` callback
   * fire for every malformed row in one synchronous burst before this
   * generator — where the budget checks live — ever gets a turn to run, so a
   * large malformed source is fully parsed regardless of how low `maxRows`
   * is set. {@link M3LCSVListImporter.#feedParser} feeds the parser via
   * separate, bounded-size writes and checks the running skip count between
   * them instead, so a budget-exceeding burst only costs the one chunk that
   * produced it.
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
    const rawBytes = await readSourceBytes(source, this.#maxBytes);
    // readSourceBytes's real-world contract is "returns a Buffer", but a
    // test double in this file's own test suite mocks the underlying
    // `readFile` with a plain string return, which flows straight through.
    // Coerce defensively so #feedParser's `.subarray()` chunking is robust
    // to that either way.
    const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
    const skipped: unknown[] = [];
    let rowIndex = 0;

    const parser = this.#createParser(skipped);
    const budgetTripped = this.#feedParser(parser, bytes, skipped);

    try {
      for await (const rawRecord of parser) {
        while (skipped.length > 0) {
          assertRowBudget(rowIndex, this.#maxRows);
          yield { ok: false, error: skipped.shift() };
          rowIndex += 1;
        }
        assertRowBudget(rowIndex, this.#maxRows);
        yield this.#runPipeline(rawRecord as Record<string, string>, rowIndex);
        rowIndex += 1;
      }
    } catch (cause) {
      // A stream destroyed mid-write (#feedParser, above) completes its
      // async iterator with a stream-teardown error rather than a clean end;
      // the trailing budget check below is what throws the correctly-coded
      // ERR_IMPORT_VALIDATION for the caller, so that teardown noise is
      // swallowed here — but only when it was self-inflicted. Any other
      // failure (a genuine parser fault) must still propagate.
      if (!budgetTripped) throw cause;
    }
    while (skipped.length > 0) {
      assertRowBudget(rowIndex, this.#maxRows);
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
