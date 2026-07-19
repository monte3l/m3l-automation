import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

/**
 * `transform-records` — maps/filters records between two JSONL files without
 * touching SQS. Streams `input` line by line (per-record parse tolerance:
 * a malformed line is a counted skip, not a throw), applies the optional
 * `fields` projection (via `Core.extractAll`) BEFORE the optional `filters`
 * predicate (so a filter path resolves against the POST-projection record),
 * then streams the survivors to `output`.
 */

/** The finite set of comparison operators a `filters` rule may use. */
type FilterOp = "eq" | "ne" | "contains" | "regex" | "gt" | "lt" | "exists";

/** A single parsed `path op value` filter rule. */
interface FilterRule {
  readonly path: string;
  readonly op: FilterOp;
  readonly value: string;
  /** The `regex` operator's compiled pattern; `undefined` for every other operator. */
  readonly compiledRegex: RegExp | undefined;
}

const FILTER_OPS: readonly FilterOp[] = [
  "eq",
  "ne",
  "contains",
  "regex",
  "gt",
  "lt",
  "exists",
];

/** Narrows an unvalidated operator token to {@link FilterOp}. */
function isFilterOp(op: string): op is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(op);
}

/**
 * Parses a `filters` entry (`"path op value"`) into its path, operator, and
 * value — fully validated up front (including compiling a `regex` pattern
 * once) so a malformed rule throws before any record is read.
 *
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_FILTER_RULE"` when the
 *   rule names an unrecognized operator, a `gt`/`lt` literal is not a
 *   parseable number, or a `regex` pattern fails to compile.
 */
function parseFilterRule(rule: string): FilterRule {
  const [path, op, ...rest] = rule.trim().split(/\s+/);
  if (path === undefined || op === undefined || !isFilterOp(op)) {
    throw new Core.M3LError(`invalid filter rule: '${rule}'`, {
      code: "ERR_SQS_ETL_FILTER_RULE",
      context: { rule },
    });
  }
  const value = rest.join(" ");

  if (op === "gt" || op === "lt") {
    if (Number.isNaN(Core.parseLocaleNumber(value))) {
      throw new Core.M3LError(
        `invalid filter rule: '${rule}' (comparison value is not a number)`,
        { code: "ERR_SQS_ETL_FILTER_RULE", context: { rule } },
      );
    }
    return { path, op, value, compiledRegex: undefined };
  }

  if (op === "regex") {
    try {
      return { path, op, value, compiledRegex: new RegExp(value) };
    } catch (cause) {
      throw new Core.M3LError(
        `invalid filter rule: '${rule}' (pattern failed to compile)`,
        { code: "ERR_SQS_ETL_FILTER_RULE", context: { rule }, cause },
      );
    }
  }

  return { path, op, value, compiledRegex: undefined };
}

/** Renders a resolved field value as text for the string-based operators. */
function stringifyValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Evaluates a `gt`/`lt` comparison via `Core.parseLocaleNumber`. */
function evaluateNumericRule(
  op: "gt" | "lt",
  rawText: string | undefined,
  ruleValue: string,
): boolean {
  if (rawText === undefined) return false;
  const left = Core.parseLocaleNumber(rawText);
  const right = Core.parseLocaleNumber(ruleValue);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return op === "gt" ? left > right : left < right;
}

/** One evaluator per {@link FilterOp}, forced exhaustive via `Record<FilterOp, …>`. */
type FilterEvaluator = (
  rawText: string | undefined,
  raw: unknown,
  rule: FilterRule,
) => boolean;

const FILTER_EVALUATORS: Record<FilterOp, FilterEvaluator> = {
  eq: (rawText, _raw, rule) => rawText === rule.value,
  ne: (rawText, _raw, rule) => rawText !== rule.value,
  contains: (rawText, _raw, rule) =>
    rawText !== undefined && rawText.includes(rule.value),
  regex: (rawText, _raw, rule) =>
    rawText !== undefined &&
    rule.compiledRegex !== undefined &&
    rule.compiledRegex.test(rawText),
  gt: (rawText, _raw, rule) => evaluateNumericRule("gt", rawText, rule.value),
  lt: (rawText, _raw, rule) => evaluateNumericRule("lt", rawText, rule.value),
  exists: (_rawText, raw) => raw !== undefined,
};

/** Evaluates a single filter rule against `record`. */
function evaluateRule(
  record: Record<string, unknown>,
  rule: FilterRule,
): boolean {
  const raw = Core.navigateFieldPath(record, rule.path);
  const rawText = stringifyValue(raw);
  return FILTER_EVALUATORS[rule.op](rawText, raw, rule);
}

/** A single parsed `name=path` extraction spec. */
interface FieldSpec {
  readonly name: string;
  readonly path: string;
}

/** Parses a `fields` entry (`"name=path"`), splitting on the first `=` only. */
function parseFieldSpec(spec: string): FieldSpec {
  const separatorIndex = spec.indexOf("=");
  if (separatorIndex < 0) return { name: spec, path: spec };
  return {
    name: spec.slice(0, separatorIndex),
    path: spec.slice(separatorIndex + 1),
  };
}

/** Collapses `Core.extractAll`'s matches: none becomes `undefined`, one is unwrapped, many stay an array. */
function joinMatches(matches: readonly unknown[]): unknown {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches;
}

/** Projects `record` through every `fields` spec into an ordered flat record. */
function projectFields(
  record: Record<string, unknown>,
  specs: readonly FieldSpec[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const spec of specs) {
    projected[spec.name] = joinMatches(Core.extractAll(record, spec.path));
  }
  return projected;
}

/** Narrows `value` to a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies the `fields` projection (when any specs are declared) then the
 * `filters` predicate to one already-plain-object record.
 *
 * @returns The (possibly projected) record if it survives every filter
 *   rule, `undefined` if a filter excluded it.
 */
function applyProjectionAndFilters(
  record: Record<string, unknown>,
  specs: readonly FieldSpec[],
  rules: readonly FilterRule[],
): Record<string, unknown> | undefined {
  const projected = specs.length > 0 ? projectFields(record, specs) : record;
  return rules.every((rule) => evaluateRule(projected, rule))
    ? projected
    : undefined;
}

/** The resolved, guard-checked settings a run needs. */
interface TransformSettings {
  readonly input: string;
  readonly output: string;
  readonly fields: readonly string[];
  readonly filters: readonly string[];
}

/** Narrows `value` to `string[]` by checking every element's type. */
function isStringArray(value: readonly unknown[]): value is string[] {
  return value.every((item) => typeof item === "string");
}

/**
 * Reads a required string parameter (`input`/`output`), throwing when it is
 * missing (never declared with `required: true` — F1b — so per-command
 * requiredness is guard-checked here) or was stored as a non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'transform'`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads the `fields`/`filters` string-array parameter, defaulting to `[]`. */
function readStringArray(
  config: Core.M3LConfig,
  name: string,
): readonly string[] {
  const value: unknown = config.get(name);
  if (value === undefined) return [];
  if (!Array.isArray(value) || !isStringArray(value)) {
    throw new Core.M3LError(`'${name}' must be a string array`, {
      code: "ERR_SQS_ETL_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Resolves and guard-checks every declared parameter `transformRecords` needs. */
function resolveSettings(config: Core.M3LConfig): TransformSettings {
  return {
    input: readRequiredString(config, "input"),
    output: readRequiredString(config, "output"),
    fields: readStringArray(config, "fields"),
    filters: readStringArray(config, "filters"),
  };
}

/**
 * Streams `filePath` as newline-delimited JSON, JSON-parsing each non-empty
 * line and yielding the parsed value; a line that fails to parse is reported
 * to `onSkip` (index + cause) instead of aborting the stream.
 */
async function* readJsonlRecords(
  filePath: string,
  onSkip: (index: number, cause: unknown) => void,
): AsyncGenerator<unknown> {
  const buffer = await fsp.readFile(filePath);
  const lines = buffer
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let index = 0;
  for (const line of lines) {
    try {
      yield JSON.parse(line) as unknown;
    } catch (cause) {
      onSkip(index, cause);
    }
    index += 1;
  }
}

/** Writes one line to `stream`, resolving once the write callback fires. */
function writeLine(stream: fs.WriteStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Ends `stream`, resolving on `'finish'` and rejecting on `'error'`. */
function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", () => {
      resolve();
    });
    stream.end();
  });
}

/** The outcome of processing one record, driving which counter the caller bumps. */
type RecordOutcome = "written" | "skipped" | "filtered-out";

/**
 * Processes one already-parsed record: writes it through unprojected when
 * `specs`/`rules` are both empty, reports a skip for a non-object record
 * when either is declared, otherwise projects/filters it and writes the
 * survivor (or reports a filtered-out exclusion).
 */
async function processRecord(
  record: unknown,
  specs: readonly FieldSpec[],
  rules: readonly FilterRule[],
  stream: fs.WriteStream,
): Promise<RecordOutcome> {
  if (specs.length === 0 && rules.length === 0) {
    await writeLine(stream, `${JSON.stringify(record)}\n`);
    return "written";
  }
  if (!isPlainObject(record)) return "skipped";
  const survivor = applyProjectionAndFilters(record, specs, rules);
  if (survivor === undefined) return "filtered-out";
  await writeLine(stream, `${JSON.stringify(survivor)}\n`);
  return "written";
}

/**
 * Wraps a `transformRecords` run failure: best-effort closes `stream`, then
 * re-throws `cause` unchanged if it is already an {@link Core.M3LError},
 * otherwise wraps it as one.
 */
async function wrapTransformError(
  cause: unknown,
  stream: fs.WriteStream,
  correlationId: string,
): Promise<never> {
  try {
    await endStream(stream);
  } catch {
    // best-effort: a second close failure must not mask the real cause.
  }
  if (cause instanceof Core.M3LError) throw cause;
  throw new Core.M3LError(`sqs-etl transform run ${correlationId} failed`, {
    code: "ERR_SQS_ETL_TRANSFORM",
    cause,
  });
}

/**
 * Runs the `transform` command: streams `input`, projects/filters each
 * record, and streams the survivors to `output`. Performs no SQS calls.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, and the per-run
 *   correlation id to log against.
 * @returns The run summary: records read (successfully JSON-parsed),
 *   written (survived projection/filtering), and skipped (malformed JSONL
 *   lines, plus non-object bodies when `fields`/`filters` is non-empty).
 * @throws {@link Core.M3LError} coded `"ERR_SQS_ETL_CONFIG"` when `input`/
 *   `output` is missing, `"ERR_SQS_ETL_FILTER_RULE"` when a `filters` entry
 *   is malformed, or a wrapped failure when the output cannot be written.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { transformRecords } from "./transform-records.js";
 *
 * const summary = await transformRecords({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "sqs-etl", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 * });
 * console.log(summary.read, summary.written, summary.skipped);
 * ```
 */
export async function transformRecords(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
}): Promise<{ read: number; written: number; skipped: number }> {
  const settings = resolveSettings(deps.config);
  const rules = settings.filters.map(parseFilterRule);
  const specs = settings.fields.map(parseFieldSpec);

  const inputPath = deps.paths.resolveInput(settings.input);
  const outputPath = deps.paths.resolveOutput(settings.output);

  let read = 0;
  let written = 0;
  let skipped = 0;

  const stream = fs.createWriteStream(outputPath);
  try {
    const records = readJsonlRecords(inputPath, (index, cause) => {
      skipped += 1;
      deps.logger.warning(
        `skipped malformed JSONL line at index ${String(index)}`,
        { cause },
      );
    });

    for await (const record of records) {
      read += 1;
      const outcome = await processRecord(record, specs, rules, stream);
      if (outcome === "written") written += 1;
      else if (outcome === "skipped") skipped += 1;
    }
    await endStream(stream);
  } catch (cause) {
    await wrapTransformError(cause, stream, deps.correlationId);
  }

  deps.logger.step(`sqs-etl transform run ${deps.correlationId} complete`, {
    read,
    written,
    skipped,
  });
  return { read, written, skipped };
}
