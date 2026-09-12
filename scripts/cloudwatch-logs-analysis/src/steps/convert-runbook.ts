import { Core } from "@m3l-automation/m3l-common";

import { AUTHORABLE_VERDICTS, RESERVED_PRIORITY_CEILING } from "./preset.js";
import { writeJsonArtifact } from "./write-artifact.js";

/** The error code a `convert` run fails with. */
export const CONVERT_CODE = "ERR_LOGS_ANALYSIS_CONVERT";

/**
 * The fence tag a runbook author may add to declare, in JSON, the parts of a
 * preset that cannot be read out of operator prose — the correlation rule
 * above all. Its fields are merged over the extracted skeleton, so a runbook
 * carrying one converts to a preset that passes `validate` unattended, and a
 * runbook without one converts to a skeleton with explicit `todos`.
 */
export const OVERRIDE_FENCE = "m3l-preset";

/** The first case row's priority; each subsequent row steps down by {@link PRIORITY_STEP}. */
export const BASE_PRIORITY = 1000;
/** The gap left between generated case priorities, so a reviewer can insert rows. */
export const PRIORITY_STEP = 10;

const LOG_GROUP_RE = /`(\/[A-Za-z0-9._/*-]+)`/gu;
const QUERY_HINT_RE = /\b(?:fields|filter|stats|parse)\b/u;
const SLUG_RE = /[^a-z0-9]+/gu;
/** Longest generated case-id slug, before the uniqueness suffix. */
const MAX_SLUG_LENGTH = 48;
/** First suffix tried when two rows slugify identically. */
const FIRST_SLUG_SUFFIX = 2;
/** A markdown table's header row plus its `|---|` separator, before the data. */
const TABLE_PREAMBLE_ROWS = 2;

/** What one conversion produced. */
export interface ConversionResult {
  /** The emitted preset skeleton, as a plain JSON-serialisable record. */
  readonly preset: Readonly<Record<string, unknown>>;
  /** Everything the converter could not extract. Empty means "ready to use". */
  readonly todos: readonly string[];
  /** Where the skeleton was written, relative to the output directory. */
  readonly output: string;
}

/** Returns the first `# ` heading's text. */
export function extractTitle(markdown: string): string | undefined {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Returns every fenced code block as `[tag, body]` pairs, in document order. */
export function extractFences(
  markdown: string,
): readonly { readonly tag: string; readonly body: string }[] {
  const fences: { tag: string; body: string }[] = [];
  let tag: string | undefined;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    const opener = /^```(\S*)\s*$/u.exec(line);
    if (opener === null) {
      if (tag !== undefined) body.push(line);
      continue;
    }
    if (tag === undefined) {
      tag = opener[1] ?? "";
      body = [];
      continue;
    }
    fences.push({ tag, body: body.join("\n") });
    tag = undefined;
  }
  return fences;
}

/** Returns the first fenced block that reads like a Logs Insights query. */
export function extractQuery(markdown: string): string | undefined {
  for (const fence of extractFences(markdown)) {
    if (fence.tag === OVERRIDE_FENCE) continue;
    if (QUERY_HINT_RE.test(fence.body)) return fence.body.trim();
  }
  return undefined;
}

/** Returns every distinct log-group-shaped inline code span, in document order. */
export function extractLogGroups(markdown: string): readonly string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(LOG_GROUP_RE)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

/** Splits one `|`-delimited markdown table row into trimmed cells. */
function splitRow(line: string): readonly string[] {
  return line
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Whether `line` is a markdown table's `|---|---|` separator. */
function isSeparator(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/u.test(line);
}

/**
 * Returns the first markdown table's data rows, each keyed by its
 * lower-cased column header.
 *
 * @param markdown - The runbook's markdown source.
 * @returns One record per data row; empty when the document has no table.
 *
 * @example
 * ```typescript
 * import { extractTable } from "./convert-runbook.js";
 *
 * extractTable("| Error | Fix |\n| --- | --- |\n| boom | retry |");
 * // => [{ error: "boom", fix: "retry" }]
 * ```
 */
export function extractTable(
  markdown: string,
): readonly Readonly<Record<string, string>>[] {
  const lines = markdown.split("\n");
  const headerIndex = lines.findIndex(
    (line, index) =>
      line.trimStart().startsWith("|") && isSeparator(lines[index + 1] ?? ""),
  );
  if (headerIndex === -1) return [];
  const headers = splitRow(lines[headerIndex] ?? "").map((cell) =>
    cell.toLowerCase(),
  );
  const rows: Readonly<Record<string, string>>[] = [];
  for (const line of lines.slice(headerIndex + TABLE_PREAMBLE_ROWS)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = splitRow(line);
    rows.push(
      Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""])),
    );
  }
  return rows;
}

/** Returns the first cell whose header matches `pattern`. */
function cell(
  row: Readonly<Record<string, string>>,
  pattern: RegExp,
): string | undefined {
  for (const [header, value] of Object.entries(row)) {
    if (pattern.test(header) && value.length > 0) return value;
  }
  return undefined;
}

/** Turns free text into a stable, unique kebab-case case id. */
function slugify(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(SLUG_RE, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, MAX_SLUG_LENGTH) || "case";
  let id = base;
  let suffix = FIRST_SLUG_SUFFIX;
  while (taken.has(id)) {
    id = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  taken.add(id);
  return id;
}

/** Maps a table cell to an authorable verdict, or `undefined` when it does not. */
function toVerdict(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalised = text.toLowerCase().replace(SLUG_RE, "-");
  return AUTHORABLE_VERDICTS.find((verdict) => verdict === normalised);
}

/** Converts the known-cases table into preset case rows, collecting its gaps. */
function toCases(
  rows: readonly Readonly<Record<string, string>>[],
  todos: string[],
): readonly Readonly<Record<string, unknown>>[] {
  const taken = new Set<string>();
  return rows.flatMap((row, index) => {
    const pattern = cell(row, /pattern|error|signature|message|symptom/u);
    const description = cell(row, /cause|meaning|description|detail/u);
    if (pattern === undefined) {
      todos.push(`cases[${String(index)}]: no error/pattern column found`);
      return [];
    }
    const priority = BASE_PRIORITY - index * PRIORITY_STEP;
    if (priority <= RESERVED_PRIORITY_CEILING) {
      todos.push(
        `cases[${String(index)}]: too many rows to auto-assign a priority`,
      );
      return [];
    }
    const verdict = toVerdict(cell(row, /verdict|status|outcome/u));
    if (verdict === undefined) {
      todos.push(
        `cases[${String(index)}]: verdict not recognised; defaulted to unrecognised`,
      );
    }
    return [
      {
        id: slugify(description ?? pattern, taken),
        description: description ?? pattern,
        prose:
          cell(row, /prose|explanation|analysis|note/u) ??
          description ??
          pattern,
        priority,
        pattern,
        verdict: verdict ?? "unrecognised",
        ...optional("ticket", cell(row, /ticket|issue|reference/u)),
        ...optional(
          "resolution",
          cell(row, /resolution|action|fix|remediation/u),
        ),
      },
    ];
  });
}

/** Emits `{ key: value }` only when `value` is present, so absent stays absent in JSON. */
function optional(
  key: string,
  value: string | undefined,
): Readonly<Record<string, string>> {
  return value === undefined ? {} : { [key]: value };
}

/** Reads and JSON-parses the optional `m3l-preset` override fence. */
export function extractOverrides(
  markdown: string,
): Readonly<Record<string, unknown>> {
  const fence = extractFences(markdown).find(
    (candidate) => candidate.tag === OVERRIDE_FENCE,
  );
  if (fence === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence.body) as unknown;
  } catch (cause) {
    throw new Core.M3LError(`the '${OVERRIDE_FENCE}' block is not valid JSON`, {
      code: CONVERT_CODE,
      cause,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Core.M3LError(
      `the '${OVERRIDE_FENCE}' block must contain a JSON object`,
      { code: CONVERT_CODE },
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Converts one runbook markdown document into a preset **skeleton**.
 *
 * The converter never guesses. What it can read structurally — the title,
 * the entry query, the log groups, the known-cases table — it extracts; what
 * it cannot (the correlation rule above all) it records in `todos`, and a
 * preset with a non-empty `todos` fails `validate`. An author closes the gap
 * either by editing the emitted skeleton or by adding an
 * `{@link OVERRIDE_FENCE}` block to the runbook itself.
 *
 * @param markdown - The runbook's markdown source.
 * @param alarm - The alarm name to key the preset by.
 * @returns The skeleton and everything left for a human.
 *
 * @example
 * ```typescript
 * import { convertMarkdown } from "./convert-runbook.js";
 *
 * const { todos } = convertMarkdown("# Example alarm", "example");
 * console.log(todos.length > 0);
 * ```
 */
export function convertMarkdown(
  markdown: string,
  alarm: string,
): Omit<ConversionResult, "output"> {
  const todos: string[] = [];
  const query = extractQuery(markdown);
  if (query === undefined)
    todos.push("entry.query: no Logs Insights query block found");
  const logGroups = extractLogGroups(markdown);
  if (logGroups.length === 0)
    todos.push("entry.logGroups: no log group names found");
  const table = extractTable(markdown);
  if (table.length === 0) todos.push("cases: no known-cases table found");

  const skeleton: Record<string, unknown> = {
    alarm,
    title: extractTitle(markdown) ?? alarm,
    entry: { logGroups, query: query ?? "" },
    correlation: undefined,
    signature: { field: "@message" },
    cases: toCases(table, todos),
    escalateTo: "",
    ...extractOverrides(markdown),
  };
  if (skeleton["correlation"] === undefined) {
    delete skeleton["correlation"];
    todos.push(
      `correlation: not derivable from prose — add a '${OVERRIDE_FENCE}' block or edit the skeleton`,
    );
  }
  if (skeleton["escalateTo"] === "") {
    todos.push("escalateTo: no owning team declared");
  }
  return { preset: { ...skeleton, todos }, todos };
}

/** What {@link convertRunbook} needs. */
export interface ConvertRunbookDeps {
  readonly reader: Core.M3LInputFileReader;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  /** The runbook markdown, relative to the input directory. */
  readonly source: string;
  /** The alarm name to key the preset by; defaults to the source file stem. */
  readonly alarm: string | undefined;
  /** Where to write the skeleton, relative to the output directory. */
  readonly output: string | undefined;
}

/** Derives an alarm name from a source path when the caller did not supply one. */
function alarmFrom(source: string, alarm: string | undefined): string {
  if (alarm !== undefined && alarm.length > 0) return alarm;
  const stem = source.split("/").at(-1) ?? source;
  return stem.replace(/\.[^.]+$/u, "");
}

/**
 * Reads a runbook markdown file from the input directory, converts it, and
 * writes the skeleton to the output directory.
 *
 * Both directories are `M3LPaths`-managed, so pointing `M3L_INPUT_DIR` and
 * `M3L_OUTPUT_DIR` at an operator's own store is how conversion reads from
 * and writes to paths outside this repository — the corpora a runbook comes
 * from never enter the checkout.
 *
 * @param deps - The reader, paths, logger, source path, alarm and output name.
 * @returns The skeleton, its unresolved markers, and where it was written.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { convertRunbook } from "./convert-runbook.js";
 *
 * const paths = new Core.M3LPaths();
 * const result = await convertRunbook({
 *   reader: new Core.M3LInputFileReader({ paths, code: "ERR_LOGS_ANALYSIS_CONVERT" }),
 *   paths,
 *   logger: new Core.M3LLogger([]),
 *   source: "runbooks/example.md",
 *   alarm: undefined,
 *   output: undefined,
 * });
 * console.log(result.output);
 * ```
 */
export async function convertRunbook(
  deps: ConvertRunbookDeps,
): Promise<ConversionResult> {
  const markdown = await deps.reader.readText(deps.source);
  const alarm = alarmFrom(deps.source, deps.alarm);
  const converted = convertMarkdown(markdown, alarm);
  const output = deps.output ?? `${alarm}.json`;

  await writeJsonArtifact(deps.paths, output, converted.preset);

  for (const todo of converted.todos) deps.logger.warning(`TODO ${todo}`);
  if (converted.todos.length === 0) {
    deps.logger.success(
      `converted '${deps.source}' with nothing left to fill in`,
    );
  } else {
    deps.logger.info(
      `converted '${deps.source}' with ${String(converted.todos.length)} marker(s) left for review`,
    );
  }
  return { ...converted, output };
}
