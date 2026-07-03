/**
 * `core/importers/M3LJSONListImporter` — JSON/JSONL list import with format
 * dispatch and dot-notation field-path extraction.
 *
 * @packageDocumentation
 */

import { M3LEventEmitterBase } from "../events/index.js";
import { M3LError } from "../errors/index.js";
import { M3LJSONFieldExtractor } from "../json/M3LJSONFieldExtractor.js";
import { M3LJSONFormatDetector } from "../json/M3LJSONFormatDetector.js";

import type { M3LJSONDetectionDepth, M3LJSONFormat } from "../json/types.js";

import {
  ERR_IMPORT_PARSE,
  ERR_IMPORT_SOURCE,
  ERR_IMPORT_VALIDATION,
  hasDangerousOwnKey,
  readSourceBytes,
  resolveSource,
  sourceLabel,
} from "../../internal/importers/resolveSource.js";

import type {
  M3LListImporter,
  M3LListImporterEvents,
  M3LListImporterResult,
} from "./M3LListImporter.js";

/**
 * Constructor options for {@link M3LJSONListImporter}.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import type { M3LJSONListImporterOptions } from "@m3l-automation/m3l-common/core";
 *
 * const recordsPath = "./data/inputs/records.jsonl";
 * const options: M3LJSONListImporterOptions<{ author: string }> = {
 *   filePath: recordsPath,
 *   fieldPath: "metadata.author",
 * };
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TItem is part of the public generic contract (mirrors M3LCSVListImporterOptions<TItem> and is asserted at M3LJSONListImporterOptions<unknown> in tests); JSON options carry no TItem-typed field because fieldPath extraction is untyped by design (M3LJSONFieldExtractor.extract returns unknown)
export interface M3LJSONListImporterOptions<TItem> {
  /**
   * The default source used when {@link M3LJSONListImporter.import} or
   * {@link M3LJSONListImporter.importStream} is called without a per-call
   * `source` argument.
   */
  readonly filePath?: string;

  /**
   * A dot-notation field path applied to every parsed record to extract a
   * nested value (e.g. `"metadata.author"`). When omitted, the record itself
   * is used as the item.
   */
  readonly fieldPath?: string;

  /**
   * The depth at which JSON-vs-JSONL format is detected. Forwarded to
   * `M3LJSONFormatDetector`. Defaults to `"standard"`.
   */
  readonly detectionDepth?: M3LJSONDetectionDepth;
}

/**
 * Decides {@link M3LJSONFormat} directly from in-memory bytes, mirroring the
 * content-sampling rule `M3LJSONFormatDetector` applies to files: a document
 * starting (after leading whitespace) with `[` is a JSON array; multiple
 * newline-separated, non-empty lines whose first line starts with `{` are
 * JSONL; a single `{`-prefixed document is JSON; anything else is
 * `"unknown"`.
 *
 * Used for `Buffer` sources, which have no file path to hand to
 * `M3LJSONFormatDetector.detect`.
 *
 * @param bytes - The raw bytes to classify.
 * @returns The decided format, or `"unknown"` when the sample is inconclusive.
 */
function detectFormatFromBytes(bytes: Buffer): M3LJSONFormat {
  const trimmed = bytes.toString("utf8").trimStart();
  if (trimmed.startsWith("[")) return "json";

  const nonEmptyLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length > 1 && nonEmptyLines[0]?.startsWith("{")) {
    return "jsonl";
  }
  if (trimmed.startsWith("{")) return "json";

  return "unknown";
}

/**
 * Streams or batch-imports JSON/JSONL content, dispatching between
 * whole-document array parsing and newline-delimited line-by-line parsing
 * based on the detected format, and applying an optional dot-notation
 * `fieldPath` extraction to every record.
 *
 * File-path sources are detected via the reused `M3LJSONFormatDetector`
 * (which opens and inspects the file itself); `Buffer` sources have no path
 * to hand the detector, so their format is decided directly from the bytes
 * using the same content-sampling rule.
 *
 * @typeParam TItem - The type of a single successfully parsed item.
 *
 * @example
 * ```typescript
 * import { M3LJSONListImporter } from "@m3l-automation/m3l-common/core";
 *
 * const recordsPath = "./data/inputs/records.jsonl";
 * const importer = new M3LJSONListImporter<{ author: string }>({
 *   fieldPath: "metadata.author",
 * });
 * for await (const item of importer.importStream(recordsPath)) {
 *   // ...
 * }
 * ```
 */
export class M3LJSONListImporter<TItem>
  extends M3LEventEmitterBase<M3LListImporterEvents<TItem>>
  implements M3LListImporter<TItem>
{
  readonly #options: M3LJSONListImporterOptions<TItem>;
  readonly #detector: M3LJSONFormatDetector;
  readonly #extractor: M3LJSONFieldExtractor | undefined;

  /**
   * Creates a JSON/JSONL list importer.
   *
   * @param options - Importer options; see {@link M3LJSONListImporterOptions}.
   */
  constructor(options: M3LJSONListImporterOptions<TItem>) {
    super();
    this.#options = options;
    this.#detector = new M3LJSONFormatDetector({
      depth: options.detectionDepth ?? "standard",
    });
    this.#extractor =
      options.fieldPath === undefined
        ? undefined
        : new M3LJSONFieldExtractor(options.fieldPath);
  }

  /**
   * Parses the JSON/JSONL source and returns every successfully parsed item
   * at once.
   *
   * @param source - A file path or an in-memory `Buffer`. When omitted,
   *   `options.filePath` is used.
   * @returns A promise resolving to the batch result.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when neither
   *   `source` nor `options.filePath` is supplied, the source cannot be read,
   *   or its format cannot be detected.
   * @throws {@link M3LError} with code `ERR_IMPORT_PARSE` when a whole-document
   *   JSON array is malformed.
   *
   * @example
   * ```typescript
   * import { M3LJSONListImporter } from "@m3l-automation/m3l-common/core";
   *
   * const recordsPath = "./data/inputs/records.json";
   * const importer = new M3LJSONListImporter<{ id: number }>({});
   * const result = await importer.import(recordsPath);
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

    for await (const outcome of this.#parseRecords(resolved)) {
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
   * Parses the JSON/JSONL source and yields every successfully parsed item as
   * soon as it is available.
   *
   * @param source - A file path or an in-memory `Buffer`. When omitted,
   *   `options.filePath` is used.
   * @returns An async generator yielding one item at a time.
   * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when neither
   *   `source` nor `options.filePath` is supplied, the source cannot be read,
   *   or its format cannot be detected.
   * @throws {@link M3LError} with code `ERR_IMPORT_PARSE` when a whole-document
   *   JSON array is malformed.
   *
   * @example
   * ```typescript
   * import { M3LJSONListImporter } from "@m3l-automation/m3l-common/core";
   *
   * const recordsPath = "./data/inputs/records.jsonl";
   * const importer = new M3LJSONListImporter<{ id: number }>({});
   * for await (const item of importer.importStream(recordsPath)) {
   *   // ...
   * }
   * ```
   */
  async *importStream(source?: string | Buffer): AsyncGenerator<TItem> {
    const startedAt = Date.now();
    const resolved = resolveSource(source, this.#options.filePath);
    this.emit("import:started", { source: sourceLabel(resolved) });

    let index = 0;
    for await (const outcome of this.#parseRecords(resolved)) {
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
   * Detects the format of `source` and dispatches to the JSON-array or JSONL
   * record generator accordingly.
   *
   * @param source - The resolved source (file path or `Buffer`).
   * @returns An async generator yielding one pipeline outcome per record.
   */
  async *#parseRecords(
    source: string | Buffer,
  ): AsyncGenerator<
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown }
  > {
    const bytes = await readSourceBytes(source);
    const format = await this.#detectFormat(source, bytes);

    switch (format) {
      case "json":
        yield* this.#parseJsonArray(bytes);
        return;
      case "jsonl":
        yield* this.#parseJsonl(bytes);
        return;
      case "unknown":
        throw new M3LError(
          `unable to detect JSON/JSONL format for source: ${sourceLabel(source)}`,
          { code: ERR_IMPORT_SOURCE },
        );
      default: {
        const exhaustive: never = format;
        throw new M3LError(`unhandled JSON format: ${String(exhaustive)}`, {
          code: ERR_IMPORT_SOURCE,
        });
      }
    }
  }

  /**
   * Detects the JSON-family format of `source`: file paths are detected via
   * `M3LJSONFormatDetector` (which opens and inspects the file itself);
   * `Buffer`s are classified directly from `bytes` using the same
   * content-sampling rule.
   *
   * @param source - The resolved source (file path or `Buffer`).
   * @param bytes - The raw bytes already read from `source`.
   * @returns The detected format.
   */
  async #detectFormat(
    source: string | Buffer,
    bytes: Buffer,
  ): Promise<M3LJSONFormat> {
    if (typeof source === "string") {
      const result = await this.#detector.detect(source);
      return result.format;
    }
    return detectFormatFromBytes(bytes);
  }

  /**
   * Parses `bytes` as a whole-document JSON array and extracts each element
   * (via the configured `fieldPath`, if any) as an item.
   *
   * @param bytes - The raw JSON-array document bytes.
   * @returns A generator yielding one pipeline outcome per element.
   * @throws {@link M3LError} with code `ERR_IMPORT_PARSE` when `bytes` is not
   *   valid JSON.
   */
  *#parseJsonArray(
    bytes: Buffer,
  ): Generator<
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown }
  > {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new M3LError("failed to parse JSON-array document", {
        code: ERR_IMPORT_PARSE,
        cause,
      });
    }

    const records = Array.isArray(parsed) ? parsed : [parsed];
    let index = 0;
    for (const record of records) {
      yield this.#extractOutcome(record, index);
      index += 1;
    }
  }

  /**
   * Parses `bytes` as newline-delimited JSON, yielding one outcome per
   * non-empty line: a successfully parsed line yields its extracted item; a
   * malformed line yields a skip outcome instead of aborting the stream.
   *
   * @param bytes - The raw JSONL document bytes.
   * @returns A generator yielding one pipeline outcome per line.
   */
  *#parseJsonl(
    bytes: Buffer,
  ): Generator<
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown }
  > {
    const lines = bytes
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let index = 0;
    for (const line of lines) {
      try {
        const record: unknown = JSON.parse(line);
        yield this.#extractOutcome(record, index);
      } catch (cause) {
        yield {
          ok: false,
          error: new M3LError(`JSONL line ${String(index)} failed to parse`, {
            code: ERR_IMPORT_PARSE,
            cause,
          }),
        };
      }
      index += 1;
    }
  }

  /**
   * Extracts the final item from a parsed record via the configured
   * `fieldPath`, or returns the record itself when no field path was
   * configured, as a pipeline outcome at record index `index`.
   *
   * The `fieldPath` branch's `navigateFieldPath` (via
   * {@link M3LJSONFieldExtractor}) already refuses to TRAVERSE INTO a
   * prototype-pollution vector, but the value it lands on can itself still be
   * an object carrying a dangerous own key (e.g. `fieldPath` resolves to a
   * nested object one level short of the vector). The no-`fieldPath`
   * passthrough branch forwards the record verbatim and has no traversal
   * guard at all. Both branches therefore route their produced item through
   * the same final {@link hasDangerousOwnKey} screen right before reporting
   * success, so no path can be the one that forgets the check: a hit is
   * treated as a bad record (skip + `import:error`) rather than yielded as-is.
   *
   * @param record - A single parsed JSON/JSONL record.
   * @param index - The zero-based record index, used only in error messages.
   * @returns A pipeline outcome: the extracted item, or the failure that
   *   caused the record to be skipped.
   */
  #extractOutcome(
    record: unknown,
    index: number,
  ):
    | { readonly ok: true; readonly item: TItem }
    | { readonly ok: false; readonly error: unknown } {
    const item = (
      this.#extractor !== undefined ? this.#extractor.extract(record) : record
    ) as TItem;

    if (hasDangerousOwnKey(item)) {
      return {
        ok: false,
        error: new M3LError(`record ${String(index)} carries an unsafe key`, {
          code: ERR_IMPORT_VALIDATION,
          context: { index },
        }),
      };
    }

    return { ok: true, item };
  }
}
