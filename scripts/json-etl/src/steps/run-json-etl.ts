import { Core } from "@m3l-automation/m3l-common";

import { exportResults } from "./export-results.js";
import { extractFields } from "./extract-fields.js";
import { filterRecords } from "./filter-records.js";
import { importRecords } from "./import-records.js";

/** The declared literal set of output formats `json-etl` supports, for `Core.M3LConfigAccessor.oneOf`. */
const EXPORT_FORMATS = ["json", "jsonl", "csv", "html"] as const;

/** The finite set of output formats `json-etl` supports. */
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The declared literal set for the `multiValue` parameter, for `Core.M3LConfigAccessor.oneOf`. */
const MULTI_VALUE_MODES = ["join", "explode"] as const;

/** The resolved, guard-checked settings a run needs. */
interface RunSettings {
  readonly input: string;
  readonly fields: readonly string[];
  readonly filters: readonly string[];
  readonly format: ExportFormat;
  readonly output: string;
  readonly limit: number | undefined;
  readonly sort:
    { readonly name: string; readonly direction: "asc" | "desc" } | undefined;
  readonly multiValue: (typeof MULTI_VALUE_MODES)[number];
}

/** Reads and parses the optional `sort` parameter (`"name:asc"`/`"name:desc"`). */
function readSort(
  accessor: Core.M3LConfigAccessor,
): { readonly name: string; readonly direction: "asc" | "desc" } | undefined {
  const value = accessor.optionalString("sort");
  if (value === undefined) return undefined;
  const [name, direction] = value.split(":");
  if (name === undefined || (direction !== "asc" && direction !== "desc")) {
    throw new Core.M3LError(`invalid 'sort' value: '${value}'`, {
      code: "ERR_JSON_ETL_CONFIG",
    });
  }
  return { name, direction };
}

/**
 * Resolves and guard-checks every declared parameter this run needs,
 * throwing before any record is read. `input`/`fields`/`output` presence and
 * non-emptiness are already enforced by the declared config schema
 * (`M3LConfigParameter({ required: true, validate: nonEmpty })`) before this
 * function ever runs; what remains here is the `sort`-requires-`limit`
 * constraint and `sort`'s name having to be one of the output columns
 * declared by `fields` (a typo'd sort name would otherwise silently no-op
 * the sort instead of failing fast).
 *
 * @throws {@link Core.M3LError} On an unbounded `sort` (set without `limit`)
 *   or a `sort` name outside the declared `fields` output columns.
 */
function resolveSettings(config: Core.M3LConfig): RunSettings {
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: "ERR_JSON_ETL_CONFIG",
  });
  const input = accessor.requiredString("input", "run");
  const fields = accessor.requiredStringArray("fields", "run");
  const output = accessor.requiredString("output", "run");
  const sort = readSort(accessor);
  const limit = accessor.optionalNumber("limit");

  if (sort !== undefined && limit === undefined) {
    throw new Core.M3LError("'sort' requires 'limit' to be set", {
      code: "ERR_JSON_ETL_CONFIG",
    });
  }

  if (sort !== undefined) {
    const columns = fields.map(fieldName);
    if (!columns.includes(sort.name)) {
      throw new Core.M3LError(
        `'sort' name '${sort.name}' is not one of the 'fields' output columns`,
        {
          code: "ERR_JSON_ETL_CONFIG",
          context: { sortName: sort.name, columns },
        },
      );
    }
  }

  return {
    input,
    fields,
    filters: accessor.optionalStringArray("filters") ?? [],
    format: accessor.oneOf("format", EXPORT_FORMATS),
    output,
    limit,
    sort,
    multiValue: accessor.oneOf("multiValue", MULTI_VALUE_MODES),
  };
}

/** Extracts the output column name (`"name"` of `"name=path"`) from a field spec. */
function fieldName(spec: string): string {
  const separatorIndex = spec.indexOf("=");
  return separatorIndex < 0 ? spec : spec.slice(0, separatorIndex);
}

/**
 * Compares two extracted field values: numeric when both are numbers,
 * otherwise as text.
 */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const aText = String(a);
  const bText = String(b);
  if (aText < bText) return -1;
  if (aText > bText) return 1;
  return 0;
}

/**
 * Buffers at most `limit` records at a time, keeping only the `limit` best
 * by `sort`'s field/direction, and yields them once the source is
 * exhausted — the sole buffering operation in the pipeline.
 */
async function* sortedTopK(
  records: AsyncIterable<Record<string, unknown>>,
  sort: { readonly name: string; readonly direction: "asc" | "desc" },
  limit: number,
): AsyncGenerator<Record<string, unknown>> {
  const order = sort.direction === "asc" ? 1 : -1;
  const buffer: Record<string, unknown>[] = [];
  for await (const record of records) {
    buffer.push(record);
    buffer.sort((a, b) => order * compareValues(a[sort.name], b[sort.name]));
    if (buffer.length > limit) buffer.pop();
  }
  yield* buffer;
}

/**
 * Applies `sort`/`limit` between filter and export: `sort` (guaranteed
 * paired with `limit`) buffers the top `limit` records; a bare `limit`
 * truncates the streamed records without buffering; neither set passes every
 * record through untouched.
 */
async function* applySortAndLimit(
  records: AsyncIterable<Record<string, unknown>>,
  sort: RunSettings["sort"],
  limit: number | undefined,
): AsyncGenerator<Record<string, unknown>> {
  if (sort !== undefined && limit !== undefined) {
    yield* sortedTopK(records, sort, limit);
    return;
  }
  if (limit === undefined) {
    yield* records;
    return;
  }
  let count = 0;
  for await (const record of records) {
    if (count >= limit) break;
    yield record;
    count += 1;
  }
}

/** Wraps `source`, invoking `onItem` once per yielded value before re-yielding it. */
async function* countingGenerator<T>(
  source: AsyncIterable<T>,
  onItem: () => void,
): AsyncGenerator<T> {
  for await (const item of source) {
    onItem();
    yield item;
  }
}

/**
 * Streams `inputPath` through `Core.M3LJSONListImporter`, invoking
 * `onRead` once per successfully parsed record and `onSkipped` once per
 * skipped malformed record — logging each skip's index and cause via
 * `logger` so an operator can see WHICH records failed, not just the count.
 */
function buildImportedRecords(
  inputPath: string,
  logger: Core.M3LLogger,
  onRead: () => void,
  onSkipped: () => void,
): AsyncGenerator<unknown> {
  const importer = new Core.M3LJSONListImporter<unknown>({
    filePath: inputPath,
  });
  return countingGenerator(
    importRecords({
      importer,
      onSkip: (error, index) => {
        onSkipped();
        logger.warning(`skipped malformed record at index ${String(index)}`, {
          cause: error,
        });
      },
    }),
    onRead,
  );
}

/**
 * Composes the `json-etl` pipeline end to end — the only module that knows
 * the stage order: import -\> extract -\> filter -\> (sort -\> limit) -\> export.
 * `input`/`fields`/`output` presence and non-emptiness are enforced by the
 * declared config schema before `config` reaches this function; the
 * `sort`-requires-`limit` constraint is guard-checked here, before any
 * record is read.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, and the per-run
 *   correlation id to log against.
 * @returns The run summary: records read (successfully imported, excluding
 *   skips), written (actually exported), and skipped (malformed/unparseable
 *   input records).
 * @throws {@link Core.M3LError} When a required parameter's stored value has
 *   the wrong type, `sort` is set without `limit`, the input cannot be
 *   parsed as a whole-document JSON array, or the output cannot be written.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runJsonEtl } from "./run-json-etl.js";
 *
 * const summary = await runJsonEtl({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "json-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 * });
 * console.log(summary.read, summary.written, summary.skipped);
 * ```
 */
export async function runJsonEtl(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
}): Promise<{ read: number; written: number; skipped: number }> {
  const settings = resolveSettings(deps.config);

  const inputPath = deps.paths.resolveInput(settings.input);
  const outputPath = deps.paths.resolveOutput(settings.output);

  let read = 0;
  let skipped = 0;
  let written = 0;

  const imported = buildImportedRecords(
    inputPath,
    deps.logger,
    () => {
      read += 1;
    },
    () => {
      skipped += 1;
    },
  );

  const extracted = extractFields({
    records: imported,
    fields: settings.fields,
    multiValue: settings.multiValue,
  });
  const filtered = filterRecords({
    records: extracted,
    filters: settings.filters,
  });
  const limited = applySortAndLimit(filtered, settings.sort, settings.limit);
  const counted = countingGenerator(limited, () => {
    written += 1;
  });

  await exportResults({
    records: counted,
    format: settings.format,
    outputPath,
    columns: settings.fields.map(fieldName),
    logger: deps.logger,
  });

  deps.logger.step(`json-etl run ${deps.correlationId} complete`, {
    read,
    written,
    skipped,
  });

  return { read, written, skipped };
}
