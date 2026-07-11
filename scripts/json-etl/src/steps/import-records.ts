import type { Core } from "@m3l-automation/m3l-common";

/**
 * Streams records from `opts.importer`, forwarding every `import:error`
 * (a skipped, malformed record — e.g. an unparseable JSONL line) to
 * `opts.onSkip` so the caller can count and report it, then yields every
 * successfully parsed record in source order.
 *
 * A malformed **whole-document** JSON array is not a per-record skip: the
 * underlying `importStream()` throws (e.g. `ERR_IMPORT_PARSE`) and this
 * generator lets that rejection propagate rather than swallowing it.
 *
 * @param opts - The importer to stream from and the skip-reporting callback.
 * @returns An async generator yielding one successfully parsed record at a
 *   time.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { importRecords } from "./import-records.js";
 *
 * const importer = new Core.M3LJSONListImporter<unknown>({
 *   filePath: "./data/inputs/records.jsonl",
 * });
 * for await (const record of importRecords({
 *   importer,
 *   onSkip: (error, index) => console.warn("skipped", index, error),
 * })) {
 *   // ...
 * }
 * ```
 */
export async function* importRecords(opts: {
  readonly importer: Core.M3LJSONListImporter<unknown>;
  readonly onSkip: (error: unknown, index?: number) => void;
}): AsyncGenerator<unknown> {
  opts.importer.on("import:error", (event) => {
    opts.onSkip(event.error, event.index);
  });
  yield* opts.importer.importStream();
}
