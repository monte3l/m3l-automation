import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import {
  AUTHORABLE_VERDICTS,
  HANDLING_MODES,
  RESERVED_PRIORITY_CEILING,
} from "./preset.js";

/** What one conversion produced. */
export interface ConversionResult {
  /** The emitted preset skeleton, as a plain JSON-serialisable record. */
  readonly preset: Readonly<Record<string, unknown>>;
  /** Everything the converter could not extract. Empty means "ready to use". */
  readonly todos: readonly string[];
  /** Where the skeleton was written, relative to the output directory. */
  readonly output: string;
}

/** The first case row's priority; each subsequent row steps down by {@link PRIORITY_STEP}. */
const BASE_PRIORITY = 1000;
/** The gap left between generated case priorities, so a reviewer can insert rows. */
const PRIORITY_STEP = 10;

const SLUG_RE = /[^a-z0-9]+/gu;
/** Longest generated case-id slug, before the uniqueness suffix. */
const MAX_SLUG_LENGTH = 48;
/** First suffix tried when two rows slugify identically. */
const FIRST_SLUG_SUFFIX = 2;
/** A markdown table's header row plus its `|---|` separator, before the data. */
const TABLE_PREAMBLE_ROWS = 2;

/** Returns the first `# ` heading's text. */
function extractTitle(markdown: string): string | undefined {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/**
 * Finds the first {@link HANDLING_MODES} member the prose actually declares
 * for this queue. The caller defaults to `"under-analysis"` when nothing is
 * found — this function never itself guesses `"runbook"`, the one mode that
 * makes the script act on a queue.
 *
 * Deliberately requires the mode word to share a line with "handling" (e.g.
 * `Handling: runbook`, `handling mode: redrive`) rather than matching a bare
 * occurrence of a mode word anywhere in the document — a runbook markdown
 * document routinely mentions "runbook" in its own title or boilerplate
 * prose without ever declaring that as the queue's handling mode, and a
 * looser match would silently mistake that mention for a declaration.
 */
function extractHandling(
  markdown: string,
): (typeof HANDLING_MODES)[number] | undefined {
  for (const line of markdown.split("\n")) {
    const lowered = line.toLowerCase();
    if (!lowered.includes("handling")) continue;
    for (const mode of HANDLING_MODES) {
      if (new RegExp(`\\b${mode}\\b`, "u").test(lowered)) return mode;
    }
  }
  return undefined;
}

/** Splits one `|`-delimited markdown table row into trimmed cells. */
function splitRow(line: string): readonly string[] {
  return line
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((raw) => raw.trim());
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
 */
function extractTable(
  markdown: string,
): readonly Readonly<Record<string, string>>[] {
  const lines = markdown.split("\n");
  const headerIndex = lines.findIndex(
    (line, index) =>
      line.trimStart().startsWith("|") && isSeparator(lines[index + 1] ?? ""),
  );
  if (headerIndex === -1) return [];
  const headers = splitRow(lines[headerIndex] ?? "").map((raw) =>
    raw.toLowerCase(),
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

/** Emits `{ key: value }` only when `value` is present, so absent stays absent in JSON. */
function optional(
  key: string,
  value: string | undefined,
): Readonly<Record<string, string>> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Converts the known-cases table into preset case rows, collecting its
 * gaps. Never guesses: a row missing a recognisable state column or an
 * authorable verdict is skipped and named in `todos`, rather than emitted
 * with a guessed value.
 */
function toCases(
  rows: readonly Readonly<Record<string, string>>[],
  todos: string[],
): readonly Readonly<Record<string, unknown>>[] {
  const taken = new Set<string>();
  return rows.flatMap((row, index) => {
    const fromState = cell(row, /from[\s-]?state|prior[\s-]?state|before/u);
    const nextState = cell(row, /next[\s-]?state|to[\s-]?state|after/u);
    if (fromState === undefined && nextState === undefined) {
      todos.push(`cases[${String(index)}]: no from/next state column found`);
      return [];
    }
    const priority = BASE_PRIORITY - index * PRIORITY_STEP;
    if (priority <= RESERVED_PRIORITY_CEILING) {
      todos.push(
        `cases[${String(index)}]: too many rows to auto-assign a priority`,
      );
      return [];
    }
    const verdict = toVerdict(cell(row, /verdict|outcome|status|action/u));
    if (verdict === undefined) {
      todos.push(
        `cases[${String(index)}]: verdict not recognised; row skipped`,
      );
      return [];
    }
    const description =
      cell(row, /description|meaning|detail|cause/u) ??
      fromState ??
      nextState ??
      verdict;
    return [
      {
        id: slugify(description, taken),
        description,
        prose: cell(row, /prose|explanation|analysis|note/u) ?? description,
        priority,
        ...optional("fromState", fromState),
        ...optional("nextState", nextState),
        verdict,
        ...optional("ticket", cell(row, /ticket|issue|reference/u)),
        ...optional(
          "resolution",
          cell(row, /resolution|action|fix|remediation/u),
        ),
      },
    ];
  });
}

/**
 * Converts one runbook markdown document into a preset **skeleton**.
 *
 * The converter never guesses. What it can read structurally — the title,
 * the handling mode, the known-cases table — it extracts; what it cannot
 * (the routing and lookup shape above all) it records in `todos`, and a
 * preset with a non-empty `todos` fails `validate`. A missing handling mode
 * defaults to `"under-analysis"` — never to `"runbook"`, the one mode that
 * makes the script act on a queue — plus a todo saying it was not
 * derivable.
 *
 * @param markdown - The runbook's markdown source.
 * @param queue - The dead-letter queue to key the preset by.
 * @returns The skeleton and everything left for a human.
 *
 * @example
 * ```typescript
 * import { convertMarkdown } from "./convert-runbook.js";
 *
 * const { todos } = convertMarkdown("# Example queue", "example-dlq");
 * console.log(todos.length > 0);
 * ```
 */
export function convertMarkdown(
  markdown: string,
  queue: string,
): Omit<ConversionResult, "output"> {
  const todos: string[] = [];

  const title = extractTitle(markdown);
  if (title === undefined) {
    todos.push("title: no '# ' heading found");
  }

  const handling = extractHandling(markdown);
  if (handling === undefined) {
    todos.push(
      "handling: not derivable from prose — defaulted to 'under-analysis'",
    );
  }

  const table = extractTable(markdown);
  if (table.length === 0) todos.push("arms: no known-cases table found");
  const cases = toCases(table, todos);

  todos.push(
    "routeOn: not derivable from prose — set the envelope path holding the event-type discriminator",
  );
  todos.push("escalateTo: not derivable from prose — set the owning team");
  todos.push(
    "arms[0].key: not derivable from prose — set the payload path used to extract the lookup key",
  );
  todos.push(
    "arms[0].lookup: not derivable from prose — add at least one lookup tier",
  );
  todos.push(
    "arms[0].state: not derivable from prose — set the fromState/nextState payload paths",
  );

  const preset: Record<string, unknown> = {
    queue,
    title: title ?? queue,
    handling: handling ?? "under-analysis",
    prohibitions: [],
    fifo: false,
    envelope: { bodyIsJson: false },
    routeOn: "",
    arms: [
      {
        label: "default",
        key: { path: "" },
        lookup: [],
        onMissing: "escalate",
        state: { fromState: "", nextState: "" },
        cases,
      },
    ],
    escalateTo: "",
    followUps: [],
    todos,
  };
  return { preset, todos };
}

/** What {@link convertRunbook} needs. */
export interface ConvertRunbookDeps {
  readonly reader: Core.M3LInputFileReader;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  /** The runbook markdown, relative to the input directory. */
  readonly source: string;
  /** The queue name to key the preset by; defaults to the source file stem. */
  readonly queue: string | undefined;
  /** Where to write the skeleton, relative to the output directory. */
  readonly output: string | undefined;
}

/** Derives a queue name from a source path when the caller did not supply one. */
function queueFrom(source: string, queue: string | undefined): string {
  if (queue !== undefined && queue.length > 0) return queue;
  const stem = source.split("/").at(-1) ?? source;
  return stem.replace(/\.[^.]+$/u, "");
}

/**
 * Writes one JSON artifact under `M3L_OUTPUT_DIR`, creating the destination
 * directory first.
 *
 * `Core.M3LJSONFileExporter` writes the file but does not create its
 * parent, and `convert`'s documented workflow points `M3L_OUTPUT_DIR` at an
 * operator's own preset store, which may not exist yet.
 */
async function writeSkeleton(
  paths: Core.M3LPaths,
  name: string,
  value: unknown,
): Promise<void> {
  const filePath = paths.resolveOutput(name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await new Core.M3LJSONFileExporter({ filePath }).export(value);
}

/**
 * Reads a runbook markdown file from the input directory, converts it, and
 * writes the skeleton to the output directory.
 *
 * @param deps - The reader, paths, logger, source path, queue and output name.
 * @returns The skeleton, its unresolved markers, and where it was written.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { convertRunbook } from "./convert-runbook.js";
 *
 * const paths = new Core.M3LPaths();
 * const result = await convertRunbook({
 *   reader: new Core.M3LInputFileReader({ paths, code: "ERR_DLQ_TRIAGE_CONVERT" }),
 *   paths,
 *   logger: new Core.M3LLogger([]),
 *   source: "runbooks/orders-dlq.md",
 *   queue: undefined,
 *   output: undefined,
 * });
 * console.log(result.output);
 * ```
 */
export async function convertRunbook(
  deps: ConvertRunbookDeps,
): Promise<ConversionResult> {
  const markdown = await deps.reader.readText(deps.source);
  const queue = queueFrom(deps.source, deps.queue);
  const converted = convertMarkdown(markdown, queue);
  const output = deps.output ?? `${queue}.json`;

  await writeSkeleton(deps.paths, output, converted.preset);

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
