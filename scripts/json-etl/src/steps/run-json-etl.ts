import { join, resolve, sep } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { exportResults } from "./export-results.js";
import { extractFields } from "./extract-fields.js";
import { filterRecords } from "./filter-records.js";
import { importRecords } from "./import-records.js";

/** The finite set of output formats `json-etl` supports. */
type ExportFormat = "json" | "jsonl" | "csv" | "html";

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
  readonly multiValue: "join" | "explode";
}

/** Narrows `value` to `string[]` by checking every element's type. */
function isStringArray(value: readonly unknown[]): value is string[] {
  return value.every((item) => typeof item === "string");
}

/**
 * Reads a required non-empty string parameter from `config`.
 *
 * @throws {@link Core.M3LError} When `name` is missing, empty, or not a
 *   string — a bad caller/config input, checked before any file is read.
 */
function requireString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required`, {
      code: "ERR_JSON_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/**
 * Reads a required non-empty string-array parameter from `config`.
 *
 * @throws {@link Core.M3LError} When `name` is missing, empty, or not a
 *   string array — checked before any file is read.
 */
function requireStringArray(
  config: Core.M3LConfig,
  name: string,
): readonly string[] {
  const value: unknown = config.get(name);
  if (!Array.isArray(value) || value.length === 0 || !isStringArray(value)) {
    throw new Core.M3LError(`'${name}' is required`, {
      code: "ERR_JSON_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads the optional `filters` string array, defaulting to `[]`. */
function readFilters(config: Core.M3LConfig): readonly string[] {
  const value: unknown = config.get("filters");
  if (value === undefined) return [];
  if (!Array.isArray(value) || !isStringArray(value)) {
    throw new Core.M3LError("'filters' must be a string array", {
      code: "ERR_JSON_ETL_CONFIG",
    });
  }
  return value;
}

/** Reads the `format` parameter, validating it against the declared set. */
function readFormat(config: Core.M3LConfig): ExportFormat {
  const value: unknown = config.get("format");
  if (
    value === "json" ||
    value === "jsonl" ||
    value === "csv" ||
    value === "html"
  ) {
    return value;
  }
  throw new Core.M3LError("'format' must be one of json, jsonl, csv, html", {
    code: "ERR_JSON_ETL_CONFIG",
  });
}

/** Reads the `multiValue` parameter, validating it against the declared set. */
function readMultiValue(config: Core.M3LConfig): "join" | "explode" {
  const value: unknown = config.get("multiValue");
  if (value === "join" || value === "explode") return value;
  throw new Core.M3LError("'multiValue' must be 'join' or 'explode'", {
    code: "ERR_JSON_ETL_CONFIG",
  });
}

/** Reads the optional `limit` parameter. */
function readLimit(config: Core.M3LConfig): number | undefined {
  const value: unknown = config.get("limit");
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Core.M3LError("'limit' must be a number", {
      code: "ERR_JSON_ETL_CONFIG",
    });
  }
  return value;
}

/** Reads and parses the optional `sort` parameter (`"name:asc"`/`"name:desc"`). */
function readSort(
  config: Core.M3LConfig,
): { readonly name: string; readonly direction: "asc" | "desc" } | undefined {
  const value: unknown = config.get("sort");
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Core.M3LError("'sort' must be a string", {
      code: "ERR_JSON_ETL_CONFIG",
    });
  }
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
 * throwing before any record is read: required `input`/`fields`/`output`
 * must be present, `sort` requires `limit`, and `sort`'s name must be one of
 * the output columns declared by `fields` (a typo'd sort name would
 * otherwise silently no-op the sort instead of failing fast).
 *
 * @throws {@link Core.M3LError} On any missing/invalid required parameter, an
 *   unbounded `sort` (set without `limit`), or a `sort` name outside the
 *   declared `fields` output columns.
 */
function resolveSettings(config: Core.M3LConfig): RunSettings {
  const input = requireString(config, "input");
  const fields = requireStringArray(config, "fields");
  const output = requireString(config, "output");
  const sort = readSort(config);
  const limit = readLimit(config);

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
    filters: readFilters(config),
    format: readFormat(config),
    output,
    limit,
    sort,
    multiValue: readMultiValue(config),
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

/**
 * Joins `relative` onto `baseDir` and asserts the resolved path stays within
 * `baseDir` — guarding against a config value (e.g. `input: "../../etc/passwd"`)
 * escaping `M3L_INPUT_DIR`/`M3L_OUTPUT_DIR` via `..` segments or an absolute
 * path. Checked before any file is read or written.
 *
 * @param baseDir - The directory `relative` must resolve inside of.
 * @param relative - The config-supplied path, relative to `baseDir`.
 * @param kind - Which parameter this path came from, for the error context.
 * @returns The resolved, contained absolute path.
 * @throws {@link Core.M3LError} When the resolved path is `baseDir` itself or
 *   falls outside it.
 */
function resolveContainedPath(
  baseDir: string,
  relative: string,
  kind: "input" | "output",
): string {
  const base = resolve(baseDir);
  const candidate = resolve(join(base, relative));
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw new Core.M3LError(`'${kind}' path escapes its base directory`, {
      code: "ERR_JSON_ETL_PATH",
      context: { kind, relative, baseDir: base },
    });
  }
  return candidate;
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
 * Required parameters and the `sort`-requires-`limit` constraint are
 * guard-checked before any record is read.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, and the per-run
 *   correlation id to log against.
 * @returns The run summary: records read (successfully imported, excluding
 *   skips), written (actually exported), and skipped (malformed/unparseable
 *   input records).
 * @throws {@link Core.M3LError} When a required parameter is missing, `sort`
 *   is set without `limit`, the input cannot be parsed as a whole-document
 *   JSON array, or the output cannot be written.
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

  const inputPath = resolveContainedPath(
    deps.paths.getInputDir(),
    settings.input,
    "input",
  );
  const outputPath = resolveContainedPath(
    deps.paths.getOutputDir(),
    settings.output,
    "output",
  );

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
