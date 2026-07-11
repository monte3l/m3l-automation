import { Core } from "@m3l-automation/m3l-common";

/** The finite set of output formats `json-etl` supports. */
type ExportFormat = "json" | "jsonl" | "csv" | "html";

/**
 * Builds the format-specific exporter CLASS for `format`: `"json"`/`"jsonl"`
 * both use `M3LJSONListExporter` (differing only in its `format` option),
 * `"csv"` uses `M3LCSVListExporter` (deriving column order from the first
 * appended record's keys), and `"html"` uses `M3LHTMLListExporter` with the
 * injected `columns` selection (not the first record's key order).
 *
 * @param format - The declared output format.
 * @param outputPath - The destination file path.
 * @param columns - The `fields`-ordered column selection, used by `"html"`.
 * @returns The constructed exporter.
 * @throws {@link Core.M3LError} When `format` is not one of the four
 *   recognized values (unreachable through the declared config schema,
 *   guarded here for exhaustiveness).
 */
function createExporter(
  format: ExportFormat,
  outputPath: string,
  columns: readonly string[],
): Core.M3LListExporter<Record<string, unknown>> {
  switch (format) {
    case "json":
      return new Core.M3LJSONListExporter<Record<string, unknown>>({
        filePath: outputPath,
        format: "array",
      });
    case "jsonl":
      return new Core.M3LJSONListExporter<Record<string, unknown>>({
        filePath: outputPath,
        format: "jsonl",
      });
    case "csv":
      return new Core.M3LCSVListExporter<Record<string, unknown>>({
        filePath: outputPath,
      });
    case "html":
      return new Core.M3LHTMLListExporter<Record<string, unknown>>({
        filePath: outputPath,
        columns,
      });
    default: {
      const exhaustive: never = format;
      throw new Core.M3LError(
        `unhandled export format: ${String(exhaustive)}`,
        {
          code: "ERR_JSON_ETL_EXPORT_FORMAT",
        },
      );
    }
  }
}

/**
 * Streams `opts.records` through the `opts.format`-selected exporter class,
 * appending one record at a time and finalizing the output once the source
 * is exhausted.
 *
 * Wraps the whole append/close lifecycle in a single fallible region: a
 * failure mid-stream still attempts a best-effort `close()` (so the
 * underlying file handle is released) without letting that cleanup attempt
 * mask the original failure.
 *
 * @param opts - The source records, the output format, destination path, and
 *   the `fields`-ordered column selection (used by CSV's header order intent
 *   and HTML's rendered columns).
 * @returns A promise that resolves once every record has been written and
 *   the output finalized.
 * @throws {@link Core.M3LError} When appending or finalizing the output
 *   fails; the underlying exporter's error is re-thrown unchanged when
 *   already typed.
 *
 * @example
 * ```typescript
 * import { exportResults } from "./export-results.js";
 *
 * async function* records(): AsyncGenerator<Record<string, unknown>> {
 *   yield { id: "1" };
 * }
 *
 * await exportResults({
 *   records: records(),
 *   format: "jsonl",
 *   outputPath: "./data/outputs/records.jsonl",
 *   columns: ["id"],
 * });
 * ```
 */
export async function exportResults(opts: {
  readonly records: AsyncIterable<Record<string, unknown>>;
  readonly format: ExportFormat;
  readonly outputPath: string;
  readonly columns: readonly string[];
  readonly logger?: Core.M3LLogger;
}): Promise<void> {
  const exporter = createExporter(opts.format, opts.outputPath, opts.columns);
  const writer = exporter.exportStream();
  let closed = false;

  try {
    for await (const record of opts.records) {
      await writer.append(record);
    }
    await writer.close();
    closed = true;
  } catch (cause) {
    // Best-effort cleanup only: a second close() failure here must not mask
    // the primary append/close failure being re-thrown below. Call close()
    // at most once — a successful close() above already released resources.
    if (!closed) {
      try {
        await writer.close();
      } catch (closeError) {
        opts.logger?.warning("export close after failure also failed", {
          cause: closeError,
        });
      }
    }
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError("json-etl export failed", {
      code: "ERR_JSON_ETL_EXPORT",
      cause,
    });
  }
}
