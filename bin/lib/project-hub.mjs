// Pure builders + renderer for the ADR-0032 visibility hub (dist/index.html).
// No fs/child_process/process imports here — every function is string/model
// in, object/string out, so it is trivially unit-testable and reusable by
// both the runner (gen-project-hub.mjs) and its checks. `node:path`'s posix
// helpers are used for relative-link resolution only; they perform no I/O.
//
// Shared by gen-project-hub.mjs, which supplies the filesystem reads (the
// three tracker docs, the ADR/log/archive/plan corpus, docs/reference/catalog.json)
// and writes the rendered page to dist/index.html on every push to `main`
// (.github/workflows/pages.yml, ADR-0032).
import { posix } from "node:path";

/**
 * The fixed repo blob root every generated hyperlink is rooted at.
 *
 * @example
 * ```js
 * import { REPO_BLOB_BASE } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * `${REPO_BLOB_BASE}docs/ROADMAP.md`;
 * ```
 */
export const REPO_BLOB_BASE =
  "https://github.com/monte3l/m3l-automation/blob/main/";

/**
 * Build a `REPO_BLOB_BASE`-rooted URL for a repo-relative path, percent-encoding
 * each path segment individually (so a literal space in a filename becomes
 * `%20`) while preserving the `/` separators and a trailing `#anchor` verbatim.
 *
 * @param {string} path repo-relative path, optionally with a `#anchor` suffix
 * @returns {string}
 * @example
 * ```js
 * import { blobUrl } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * blobUrl("docs/ROADMAP.md");
 * // "https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md"
 * ```
 */
export function blobUrl(path) {
  const hashIndex = path.indexOf("#");
  const pathPart = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : path.slice(hashIndex);
  const encoded = pathPart.split("/").map(encodeURIComponent).join("/");
  return REPO_BLOB_BASE + encoded + anchor;
}

// A row whose every cell is a markdown table divider ("---", ":--", "--:",
// ":-:", each at least 3 dashes long) — never real data, always skipped.
function isDividerRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

// Split one pipe-table line into trimmed cells, unescaping `\|` to a literal
// `|` and dropping the empty artifacts a leading/trailing `|` produces.
function splitTableRow(line) {
  const raw = line.split(/(?<!\\)\|/);
  if (raw.length > 0 && raw[0].trim() === "") raw.shift();
  if (raw.length > 0 && raw[raw.length - 1].trim() === "") raw.pop();
  return raw.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * Parse the first markdown pipe-table that follows `headingRegex` in `content`.
 * Cells are split on unescaped `|`, trimmed, and unescaped (`\|` -> `|`); the
 * divider row is skipped. While searching for the table's start, blank lines
 * and prose are skipped over; the search (and, once inside the table, row
 * collection) bails out as soon as it hits a `#`-heading or runs out of
 * content, so a heading with prose but no table before the next heading
 * yields `null` and a table's row collection stops at the first blank line
 * or the next heading, whichever comes first.
 *
 * @param {string} content
 * @param {RegExp} headingRegex must match the heading line (a `/m`-flagged
 *   `^...` pattern); only its first match is used
 * @returns {{ header: string[], rows: string[][] } | null}
 * @example
 * ```js
 * import { parseMarkdownTable } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * parseMarkdownTable("## Items\n\n| A | B |\n| - | - |\n| 1 | 2 |\n", /^## Items$/m);
 * // { header: ["A", "B"], rows: [["1", "2"]] }
 * ```
 */
export function parseMarkdownTable(content, headingRegex) {
  const match = headingRegex.exec(content);
  if (!match) return null;

  const lines = content.slice(match.index + match[0].length).split("\n");
  let idx = 0;

  // Scan forward to the first table line, bailing out (null) if a blank line
  // followed by a heading — or a heading directly — arrives first.
  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (trimmed === "") {
      idx++;
      continue;
    }
    if (/^#{1,6}\s/.test(lines[idx])) return null;
    if (trimmed.startsWith("|")) break;
    idx++;
  }
  if (idx >= lines.length) return null;

  const header = splitTableRow(lines[idx]);
  idx++;

  const rows = [];
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (trimmed === "" || /^#{1,6}\s/.test(line) || !trimmed.startsWith("|")) {
      break;
    }
    const cells = splitTableRow(line);
    idx++;
    if (isDividerRow(cells)) continue;
    rows.push(cells);
  }

  return { header, rows };
}

/**
 * Case-insensitive exact-match column lookup.
 *
 * @param {string[]} header
 * @param {string} name
 * @returns {number} column index, or -1 when absent
 * @example
 * ```js
 * import { columnIndex } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * columnIndex(["ID", "Status"], "status"); // 1
 * ```
 */
export function columnIndex(header, name) {
  const target = name.toLowerCase();
  return header.findIndex((cell) => cell.toLowerCase() === target);
}

/**
 * Classify a tracker table's status cell into one of the six badge kinds the
 * hub renders, and report whether the cell was actually recognized. Strips
 * `**bold**`/`` `code` ``/`_italic_` markers first, then matches a leading
 * done/to-do/in-progress/deferred/blocked/rejected keyword or one of the four
 * legacy status emoji (kept for the count-enforced `implementation-status.md`
 * ledger, whose ✅/🧪/🟢/❌ cells are never rewritten to keywords).
 *
 * ADR-0032 introduced this six-value tracker vocabulary distinct from the
 * GitHub Projects board's original three-option Status field
 * (Pending/In review/Done); ADR-0052 widened the board field to the same
 * six values (`PROJECT_STATUS_OPTIONS` in `./hub-sync.mjs`) precisely so
 * there is no longer a separate board-side spelling to leak into a tracker
 * cell. `recognized: false` still catches any cell outside the six-value
 * vocabulary (a typo, stray punctuation, or a since-retired board token like
 * the pre-ADR-0052 `In review`) — surfacing it instead of silently treating
 * it as `kind: "todo"`.
 *
 * @param {string} cell
 * @returns {{ kind: "done" | "todo" | "in-progress" | "deferred" | "blocked" | "rejected", recognized: boolean }}
 * @example
 * ```js
 * import { classifyStatusCell } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * classifyStatusCell("**Done**"); // { kind: "done", recognized: true }
 * classifyStatusCell("In review"); // { kind: "todo", recognized: false }
 * ```
 */
export function classifyStatusCell(cell) {
  const stripped = cell.replace(/[`*_]/g, "").trim();
  if (stripped.startsWith("✅")) return { kind: "done", recognized: true };
  if (stripped.startsWith("❌")) return { kind: "todo", recognized: true };
  if (stripped.startsWith("🧪") || stripped.startsWith("🟢"))
    return { kind: "in-progress", recognized: true };
  if (/^done\b/i.test(stripped)) return { kind: "done", recognized: true };
  if (/^to\s?do\b/i.test(stripped)) return { kind: "todo", recognized: true };
  if (/^in[\s-]?progress\b/i.test(stripped))
    return { kind: "in-progress", recognized: true };
  if (/^deferred\b/i.test(stripped))
    return { kind: "deferred", recognized: true };
  if (/^blocked\b/i.test(stripped))
    return { kind: "blocked", recognized: true };
  if (/^rejected\b/i.test(stripped))
    return { kind: "rejected", recognized: true };
  return { kind: "todo", recognized: false };
}

/**
 * Classify a tracker table's status cell into one of the six badge kinds the
 * hub renders, discarding whether the cell was actually recognized. Thin
 * wrapper over {@link classifyStatusCell} kept for callers that only need the
 * badge kind (the dashboard renderer must always produce a badge, even for an
 * off-vocabulary cell) — `./hub-sync.mjs`'s `actionableItems` uses
 * {@link classifyStatusCell} directly so it can warn on `recognized: false`.
 *
 * @param {string} cell
 * @returns {"done" | "todo" | "in-progress" | "deferred" | "blocked" | "rejected"}
 * @example
 * ```js
 * import { classifyStatus } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * classifyStatus("**Done**"); // "done"
 * ```
 */
export function classifyStatus(cell) {
  return classifyStatusCell(cell).kind;
}

/**
 * Classify a tracker table's Priority cell into an {@link
 * ./hub-sync.mjs} `Item` priority, reporting whether the cell was actually
 * in-vocabulary. `Now`/`Next`/`Later` map to their tier (ADR-0051's semantic
 * vocabulary, replacing the original `P0`/`P1`/`P2`); a cell that is nothing
 * but dashes is the trackers' documented **untiered placeholder** — used on
 * capability-deepening / post-comparison wave rows whose change isn't
 * priority-tiered at all — and is recognized as a deliberate authoring
 * choice that resolves to `p2`, not as a mistake.
 *
 * `Gated` maps to `p3` (ADR-0073), the tier for work that *cannot start*
 * until an external gate opens, split out of `Later`'s original
 * "gated/deferred" meaning so `Later` can mean "real work, not yet
 * scheduled". The dash placeholder deliberately still resolves to `p2`, not
 * `p3`: it marks an untiered-but-real row, never a blocked one, so
 * repointing it would misfile every wave sub-table row as gate-blocked.
 *
 * Anything else falls back to `p2` with `recognized: false` so a caller can
 * surface it. That distinction is the point: the placeholder used to warn on
 * every single `pnpm sync:hub` run despite being intentional, which buried
 * the one genuinely off-vocabulary cell (`P3`, on the F12 row) in five lines
 * of expected noise for long enough that nobody acted on it.
 *
 * Lives here rather than in `./hub-sync.mjs` (which is where it is consumed)
 * because `bin/check-tracker-status.mjs` needs the same vocabulary to gate
 * it, and this module imports nothing local while `./hub-sync.mjs` imports
 * *from* it — the reverse direction would be an import cycle. Mirrors
 * {@link classifyStatusCell}'s shape exactly.
 *
 * @param {string} cell
 * @returns {{ priority: "p0" | "p1" | "p2" | "p3", recognized: boolean }}
 * @example
 * ```js
 * import { classifyPriorityCell } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * classifyPriorityCell("**Next**");  // { priority: "p1", recognized: true }
 * classifyPriorityCell("Gated");     // { priority: "p3", recognized: true }
 * classifyPriorityCell("—");         // { priority: "p2", recognized: true }
 * classifyPriorityCell("P3");        // { priority: "p2", recognized: false }
 * ```
 */
export function classifyPriorityCell(cell) {
  const stripped = cell.replace(/[`*_]/g, "").trim();
  if (/^now$/i.test(stripped)) return { priority: "p0", recognized: true };
  if (/^next$/i.test(stripped)) return { priority: "p1", recognized: true };
  if (/^later$/i.test(stripped)) return { priority: "p2", recognized: true };
  if (/^gated$/i.test(stripped)) return { priority: "p3", recognized: true };
  // The untiered placeholder, in any dash the authoring tools produce
  // (em dash, en dash, hyphen, or a run of them). An *empty* cell is
  // deliberately NOT recognized: a missing Priority is an omission, whereas
  // a dash is someone stating "this row has no tier".
  if (/^[—–-]+$/.test(stripped)) return { priority: "p2", recognized: true };
  return { priority: "p2", recognized: false };
}

// Escape a string for literal use inside a RegExp source.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find every level-2 (`## `) heading in `content` whose section contains a
 * pipe table with a "Status" column, then return the heading text of every
 * one **not** matched by any regex in `registeredHeadings` (pass
 * {@link ROADMAP_SECTION_HEADINGS} or {@link IMPLEMENTATION_SECTION_HEADINGS}
 * depending on which tracker `content` is). This is the guard against the
 * failure mode that let the capability-deepening and post-comparison
 * hardening wave tables go completely unparsed for weeks after landing:
 * `extractRoadmap`/`extractImplementation` only report an error for a
 * heading they already know to look for, so a newly added status-bearing
 * table is a silent no-op — this function is the check that notices the new
 * heading exists at all. Level-3 (`### `) subsections are deliberately out
 * of scope: some trackers nest another section's coarse subset under a
 * `### ` heading on purpose (see the "ROADMAP's own nested … subsection is
 * skipped" note on {@link actionableItems} in `./hub-sync.mjs`), and this
 * scan operates at the same `## ` granularity `extractRoadmap`/
 * `extractImplementation` already do.
 *
 * @param {string} content a tracker file's full contents
 * @param {Record<string, { label: string, regex: RegExp }>} registeredHeadings
 * @returns {string[]} heading text (without the `## ` prefix) of every
 *   uncovered status-bearing section, in document order
 * @example
 * ```js
 * import { findUncoveredStatusHeadings, IMPLEMENTATION_SECTION_HEADINGS } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * findUncoveredStatusHeadings(
 *   "## New wave\n\n| Item | Status |\n| - | - |\n| x | Done |\n",
 *   IMPLEMENTATION_SECTION_HEADINGS,
 * );
 * // ["New wave"]
 * ```
 */
export function findUncoveredStatusHeadings(content, registeredHeadings) {
  const registered = Object.values(registeredHeadings);
  const uncovered = [];
  const headingRegex = /^## (.+)$/gm;
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const headingText = match[1].trim();
    const tableRegex = new RegExp(`^## ${escapeRegExp(headingText)}$`, "m");
    const table = parseMarkdownTable(content, tableRegex);
    if (!table) continue;
    if (columnIndex(table.header, "Status") === -1) continue;

    const covered = registered.some(({ regex }) =>
      regex.test(`## ${headingText}`),
    );
    if (!covered) uncovered.push(headingText);
  }
  return uncovered;
}

/**
 * Walk `content` line by line and report every cell in the `columnLabel`
 * column, in every pipe table under every `## `/`### ` heading, that
 * `classify` does not recognize. Shared engine behind
 * {@link findOffVocabularyStatusCells} and
 * {@link findOffVocabularyPriorityCells} — the walk itself is subtle enough
 * (see the divider/back-to-back-table rules below) that maintaining two
 * copies of it would be a standing drift risk, so the two exported finders
 * differ only in which column they read and which vocabulary they read it
 * against.
 *
 * Unlike {@link parseMarkdownTable}/{@link findUncoveredStatusHeadings} this
 * is a plain line scan rather than a per-heading regex lookup, for two
 * reasons neither of those helpers can give a caller: `parseMarkdownTable`'s
 * `{ header, rows }` result carries no line numbers, so it cannot report
 * *where* a bad cell is; and it returns only the first table after a
 * heading, whereas `docs/ROADMAP.md` nests status-bearing tables under
 * `### `-level subsections (the ADR-0035 rollout, capability-deepening,
 * and post-comparison hardening waves) that {@link findUncoveredStatusHeadings}
 * deliberately does not descend into (it scans `## ` only). A vocabulary
 * check has to cover every such table, so this function tracks the nearest
 * preceding heading of *either* level and finds every table, not just the
 * first one per `## ` section.
 *
 * A table with no `columnLabel` column at all is skipped, not reported —
 * that is what scopes {@link findOffVocabularyPriorityCells} to
 * `docs/plans/IMPLEMENTATION.md` for free, since no table in
 * `docs/ROADMAP.md` carries a Priority column.
 *
 * The divider row is identified by *content* — {@link isDividerRow}'s
 * all-dashes-cells check, the same one {@link parseMarkdownTable} already
 * relies on — never by position ("the second table line is always the
 * divider"). A positional rule would silently treat a table's genuine first
 * data row as the divider whenever a contributor drops or garbles it,
 * classifying nothing and defeating the whole point of this scan. The same
 * content check also tells two tables placed back-to-back with no blank line
 * between them apart correctly: a `|`-line whose own next line is itself a
 * divider row is a new table's header, even mid-scan — otherwise the second
 * table's header/divider text would be misread as data rows of the first,
 * against its stale column index.
 *
 * @param {string} content a tracker file's full contents
 * @param {string} columnLabel the header cell naming the column to check
 * @param {(cell: string) => { recognized: boolean }} classify the vocabulary
 * @returns {Array<{ line: number, heading: string, cell: string }>} one entry
 *   per off-vocabulary cell, in document order; `line` is 1-indexed
 */
function findOffVocabularyCells(content, columnLabel, classify) {
  const lines = content.split("\n");
  const findings = [];
  let heading = "";
  let cellIndex = -1;
  let inTable = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const headingMatch = /^#{2,3}\s+(.+)$/.exec(line);

    if (headingMatch) {
      heading = headingMatch[1].trim();
      inTable = false;
      cellIndex = -1;
      continue;
    }

    if (!trimmed.startsWith("|")) {
      inTable = false;
      cellIndex = -1;
      continue;
    }

    if (!inTable) {
      // First `|`-prefixed line after a non-table line: the header row.
      inTable = true;
      cellIndex = columnIndex(splitTableRow(line), columnLabel);
      continue;
    }

    const cells = splitTableRow(line);

    // A divider row is identified by *content* (isDividerRow — all-dashes
    // cells), never by position: a positional "the second table line is
    // always the divider" assumption would silently treat a genuine first
    // data row as the divider whenever a contributor drops or garbles it,
    // classifying nothing and defeating this exact gate.
    if (isDividerRow(cells)) continue;

    // A `|`-line whose own next line IS a divider row is itself a NEW
    // table's header, even mid-scan — otherwise two tables placed
    // back-to-back with no blank line between them would have the second
    // table's header/divider text misread as data rows of the first, against
    // the first table's stale column index.
    const nextLine = lines[index + 1];
    if (nextLine !== undefined && isDividerRow(splitTableRow(nextLine))) {
      cellIndex = columnIndex(cells, columnLabel);
      continue;
    }

    if (cellIndex === -1) continue;

    const cell = cells[cellIndex] ?? "";
    const { recognized } = classify(cell);
    if (!recognized) {
      findings.push({ line: index + 1, heading, cell });
    }
  }

  return findings;
}

/**
 * Every Status cell in `content` that {@link classifyStatusCell} does not
 * recognize — a board-side token (`In review`) or a typo that would
 * otherwise classify silently as `todo`. See
 * {@link findOffVocabularyCells} for the scan's semantics.
 *
 * @param {string} content a tracker file's full contents
 * @returns {Array<{ line: number, heading: string, cell: string }>} one entry
 *   per off-vocabulary Status cell, in document order; `line` is 1-indexed
 * @example
 * ```js
 * import { findOffVocabularyStatusCells } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * findOffVocabularyStatusCells(
 *   "## Wave\n\n| Item | Status |\n| --- | --- |\n| x | In review |\n",
 * );
 * // [{ line: 5, heading: "Wave", cell: "In review" }]
 * ```
 */
export function findOffVocabularyStatusCells(content) {
  return findOffVocabularyCells(content, "Status", classifyStatusCell);
}

/**
 * Every Priority cell in `content` that {@link classifyPriorityCell} does not
 * recognize — anything that is neither a `Now`/`Next`/`Later`/`Gated` tier nor
 * the documented untiered dash placeholder. The historical example is the
 * literal `P3` that sat on the F12 row emitting a warning on every
 * `pnpm sync:hub` run; note that ADR-0073 later added a real fourth tier, but
 * it is spelled `Gated`, so `P3` remains off-vocabulary. See {@link
 * findOffVocabularyCells} for the scan's semantics — including why this is
 * scoped to `docs/plans/IMPLEMENTATION.md` without naming it.
 *
 * @param {string} content a tracker file's full contents
 * @returns {Array<{ line: number, heading: string, cell: string }>} one entry
 *   per off-vocabulary Priority cell, in document order; `line` is 1-indexed
 * @example
 * ```js
 * import { findOffVocabularyPriorityCells } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * findOffVocabularyPriorityCells(
 *   "## Wave\n\n| Item | Priority |\n| --- | --- |\n| x | P3 |\n",
 * );
 * // [{ line: 5, heading: "Wave", cell: "P3" }]
 * ```
 */
export function findOffVocabularyPriorityCells(content) {
  return findOffVocabularyCells(content, "Priority", classifyPriorityCell);
}

/**
 * Classify a tracker table's optional `Type` cell into one of `validTypes`,
 * reporting whether the cell was in-vocabulary and whether it was the dash
 * **placeholder** (ADR-0073). Mirrors {@link classifyStatusCell} /
 * {@link classifyPriorityCell}: markdown markers are stripped first, matching
 * is case-insensitive, and a dash is a deliberate authoring choice rather
 * than a mistake.
 *
 * The dash means "use this section's default type"
 * (`TYPE_BY_ROADMAP_SECTION`/`TYPE_BY_IMPLEMENTATION_SECTION` in
 * `./hub-sync.mjs`) — which is what lets one tracker section hold rows of
 * genuinely different layers without hand-typing a Type on all 145 rows. An
 * **empty** cell in a table that has a Type column is deliberately NOT
 * recognized, the same rule Priority uses: a blank is an omission, a dash is
 * a statement.
 *
 * `validTypes` is injected rather than imported because this module is the
 * base of the import graph — `./hub-sync.mjs` (which owns `ISSUE_TYPES`)
 * imports *from* here, so reading it here would be a cycle.
 *
 * @param {string} cell
 * @param {readonly string[]} validTypes the `ISSUE_TYPES` values, in any order
 * @returns {{ type: string | null, recognized: boolean, placeholder: boolean }}
 * @example
 * ```js
 * import { classifyTypeCell } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * classifyTypeCell("**UI**", ["UI"]);
 * // { type: "UI", recognized: true, placeholder: false }
 * classifyTypeCell("—", ["UI"]);
 * // { type: null, recognized: true, placeholder: true }
 * classifyTypeCell("Widget", ["UI"]);
 * // { type: null, recognized: false, placeholder: false }
 * ```
 */
export function classifyTypeCell(cell, validTypes) {
  const stripped = cell.replace(/[`*_]/g, "").trim();
  if (/^[—–-]+$/.test(stripped)) {
    return { type: null, recognized: true, placeholder: true };
  }
  const match = validTypes.find(
    (candidate) => candidate.toLowerCase() === stripped.toLowerCase(),
  );
  if (match !== undefined) {
    return { type: match, recognized: true, placeholder: false };
  }
  return { type: null, recognized: false, placeholder: false };
}

/**
 * Every `Type` cell in `content` that {@link classifyTypeCell} does not
 * recognize against `validTypes`. Because {@link findOffVocabularyCells}
 * skips any table lacking the named column outright, the `Type` column stays
 * **optional** for free: a tracker table that never grows one is never
 * reported.
 *
 * @param {string} content a tracker file's full contents
 * @param {readonly string[]} validTypes the `ISSUE_TYPES` values
 * @returns {Array<{ line: number, heading: string, cell: string }>} one entry
 *   per off-vocabulary Type cell, in document order; `line` is 1-indexed
 * @example
 * ```js
 * import { findOffVocabularyTypeCells } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * findOffVocabularyTypeCells(
 *   "## Wave\n\n| Item | Type |\n| --- | --- |\n| x | Widget |\n",
 *   ["UI"],
 * );
 * // [{ line: 5, heading: "Wave", cell: "Widget" }]
 * ```
 */
export function findOffVocabularyTypeCells(content, validTypes) {
  return findOffVocabularyCells(content, "Type", (cell) =>
    classifyTypeCell(cell, validTypes),
  );
}

function classifyAdrStatusKind(statusText) {
  if (statusText.startsWith("Accepted")) return "Accepted";
  if (statusText.startsWith("Proposed")) return "Proposed";
  if (statusText.startsWith("Superseded")) return "Superseded";
  return "Unknown";
}

/**
 * Parse one `docs/adr/NNNN-slug.md` file into its structured fields. Returns
 * `null` for a filename that doesn't match the ADR naming convention (e.g.
 * `README.md`, `template.md`) so callers can filter the directory listing
 * without a separate allow-list. Every other field degrades gracefully
 * (missing Status line -> `statusKind: "Unknown"`) rather than throwing.
 *
 * @param {string} filename basename only, e.g. "0032-project-management-visibility-hub.md"
 * @param {string} content file contents
 * @returns {{ number: number, title: string, statusText: string, statusKind: "Accepted" | "Proposed" | "Superseded" | "Unknown", date: string | undefined } | null}
 * @example
 * ```js
 * import { parseAdr } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * parseAdr("0020-drop-release-automation.md", "# 0020. Drop release automation\n\n- **Status:** Accepted\n- **Date:** 2026-07-06\n");
 * // { number: 20, title: "Drop release automation", statusText: "Accepted", statusKind: "Accepted", date: "2026-07-06" }
 * ```
 */
export function parseAdr(filename, content) {
  const nameMatch = /^(\d{4})-(.+)\.md$/.exec(filename);
  if (!nameMatch) return null;

  const number = parseInt(nameMatch[1], 10);
  const headingMatch = /^#\s+(.+)$/m.exec(content);
  const rawTitle = headingMatch ? headingMatch[1].trim() : nameMatch[2];
  const title = rawTitle.replace(/^\d{4}\.\s+/, "");

  const statusMatch = /^-\s*\*\*Status:\*\*\s*(.+)$/m.exec(content);
  const statusText = statusMatch ? statusMatch[1].trim() : "";
  const statusKind = classifyAdrStatusKind(statusText);

  const dateMatch = /-\s*\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(content);
  const date = dateMatch ? dateMatch[1] : undefined;

  return { number, title, statusText, statusKind, date };
}

/**
 * Parse a dated-or-undated corpus doc (work log, archived plan) into its date,
 * slug, and title. A filename not matching `YYYY-MM-DD-slug.md` yields
 * `date: undefined` and uses the whole basename (minus `.md`) as the slug; a
 * missing top-level `# ` heading falls the title back to the slug.
 *
 * @param {string} filename basename only
 * @param {string} content file contents
 * @returns {{ date: string | undefined, slug: string, title: string }}
 * @example
 * ```js
 * import { parseDatedDoc } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * parseDatedDoc("2026-07-15-fleet-governance-reconciliation.md", "# Fleet governance reconciliation\n");
 * // { date: "2026-07-15", slug: "fleet-governance-reconciliation", title: "Fleet governance reconciliation" }
 * ```
 */
export function parseDatedDoc(filename, content) {
  const nameMatch = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(filename);
  const date = nameMatch ? nameMatch[1] : undefined;
  const slug = nameMatch ? nameMatch[2] : filename.replace(/\.md$/, "");
  const headingMatch = /^#\s+(.+)$/m.exec(content);
  const title = headingMatch ? headingMatch[1].trim() : slug;
  return { date, slug, title };
}

/**
 * The `docs/ROADMAP.md` level-2 (`## `) sections {@link extractRoadmap}
 * knows how to find, keyed by the same names its return object uses.
 * Exported (alongside {@link IMPLEMENTATION_SECTION_HEADINGS}) so
 * `check-tracker-coverage.mjs` can tell "a status-bearing table exists" from
 * "a status-bearing table is actually registered here" without duplicating
 * this map.
 *
 * @example
 * ```js
 * import { ROADMAP_SECTION_HEADINGS } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * ROADMAP_SECTION_HEADINGS.priority0.label; // "Priority 0"
 * ```
 */
export const ROADMAP_SECTION_HEADINGS = {
  priority0: { label: "Priority 0", regex: /^## Priority 0(?=[\s(]|$)/m },
  priority1: { label: "Priority 1", regex: /^## Priority 1(?=[\s(]|$)/m },
  priority2: { label: "Priority 2", regex: /^## Priority 2(?=[\s(]|$)/m },
  governance: {
    label: "Governance follow-ups",
    regex: /^## Governance follow-ups(?=[\s(]|$)/m,
  },
};

/**
 * Extract the four `docs/ROADMAP.md` sections (Priority 0/1/2 and Governance
 * follow-ups) as parsed tables. A section whose heading or table is missing
 * is left `null` and produces a descriptive entry in `errors`; this function
 * never throws.
 *
 * @param {string} content `docs/ROADMAP.md` contents
 * @returns {{ priority0: ReturnType<typeof parseMarkdownTable>, priority1: ReturnType<typeof parseMarkdownTable>, priority2: ReturnType<typeof parseMarkdownTable>, governance: ReturnType<typeof parseMarkdownTable>, errors: string[] }}
 * @example
 * ```js
 * import { extractRoadmap } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * const { priority0, errors } = extractRoadmap(roadmapMarkdown);
 * ```
 */
export function extractRoadmap(content) {
  const errors = [];
  const sections = {};
  for (const [key, { label, regex }] of Object.entries(
    ROADMAP_SECTION_HEADINGS,
  )) {
    const table = parseMarkdownTable(content, regex);
    sections[key] = table;
    if (!table) {
      errors.push(`Roadmap: "${label}" section table not found.`);
    }
  }
  return { ...sections, errors };
}

/**
 * The `docs/plans/IMPLEMENTATION.md` level-2 (`## `) sections
 * {@link extractImplementation} knows how to find. See
 * {@link ROADMAP_SECTION_HEADINGS} for why this is exported.
 *
 * @example
 * ```js
 * import { IMPLEMENTATION_SECTION_HEADINGS } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * IMPLEMENTATION_SECTION_HEADINGS.gated.label; // "Gated library modules & deferred decisions (Later)"
 * ```
 */
export const IMPLEMENTATION_SECTION_HEADINGS = {
  friction: {
    label: "Library friction (F-series)",
    regex: /^## Library friction \(F-series\)(?=[\s(]|$)/m,
  },
  adr0035Rollout: {
    label: "ADR-0035 rollout — failure reporting & diagnostics",
    regex: /^## ADR-0035 rollout(?=[\s(]|$)/m,
  },
  capabilityDeepeningWave: {
    label: "Capability-deepening wave — ADR-0037/0038/0039",
    regex: /^## Capability-deepening wave(?=[\s(]|$)/m,
  },
  postComparisonHardeningWave: {
    label: "Post-comparison hardening wave — ADR-0040/0041/0042/0043",
    regex: /^## Post-comparison hardening wave(?=[\s(]|$)/m,
  },
  m3lCliBuildOut: {
    label: "m3l-cli build-out — ADR-0042 activation (issue #333)",
    regex: /^## m3l-cli build-out(?=[\s(]|$)/m,
  },
  // The three programme waves ADR-0073 split out of m3lCliBuildOut, which had
  // accumulated all three and so forced one section-derived Issue Type onto
  // 42 rows. m3lCliBuildOut stays, holding its own shipped 8b-8g history.
  //
  // These headings deliberately carry no ADR-list suffix: the GitHub anchor
  // slug then follows straight from the heading text, which is what the
  // ROADMAP_ANCHORS `#priority-0` incident (see hub-sync.mjs) got wrong by
  // hand-writing a truncated anchor that never matched.
  cliEvolutionWave: {
    label: "CLI evolution wave (U-series)",
    regex: /^## CLI evolution wave(?=[\s(]|$)/m,
  },
  agentOperatorWave: {
    label: "Agent-operator wave (V-series)",
    regex: /^## Agent-operator wave(?=[\s(]|$)/m,
  },
  consoleWave: {
    label: "m3l console wave (X-series)",
    regex: /^## m3l console wave(?=[\s(]|$)/m,
  },
  codifiedProcedureWave: {
    label: "Codified-procedure engine wave — ADR-0046/0047/0048/0049",
    regex: /^## Codified-procedure engine wave(?=[\s(]|$)/m,
  },
  getterReality: {
    label: "AWS getter reality",
    regex: /^## AWS getter reality(?=[\s(]|$)/m,
  },
  gated: {
    label: "Gated library modules & deferred decisions (Later)",
    regex:
      /^## Gated library modules & deferred decisions \(Later\)(?=[\s(]|$)/m,
  },
};

/**
 * Extract the eleven `docs/plans/IMPLEMENTATION.md` sections (library
 * friction, ADR-0035 rollout, capability-deepening wave, post-comparison
 * hardening wave, m3l-cli build-out, CLI evolution wave, agent-operator wave,
 * m3l console wave, codified-procedure engine wave, AWS getter reality,
 * gated/deferred) as parsed
 * tables. Same missing-section -> `errors` contract as {@link extractRoadmap};
 * never throws.
 *
 * @param {string} content `docs/plans/IMPLEMENTATION.md` contents
 * @returns {{ friction: ReturnType<typeof parseMarkdownTable>, adr0035Rollout: ReturnType<typeof parseMarkdownTable>, capabilityDeepeningWave: ReturnType<typeof parseMarkdownTable>, postComparisonHardeningWave: ReturnType<typeof parseMarkdownTable>, m3lCliBuildOut: ReturnType<typeof parseMarkdownTable>, cliEvolutionWave: ReturnType<typeof parseMarkdownTable>, agentOperatorWave: ReturnType<typeof parseMarkdownTable>, consoleWave: ReturnType<typeof parseMarkdownTable>, codifiedProcedureWave: ReturnType<typeof parseMarkdownTable>, getterReality: ReturnType<typeof parseMarkdownTable>, gated: ReturnType<typeof parseMarkdownTable>, errors: string[] }}
 * @example
 * ```js
 * import { extractImplementation } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * const { friction, errors } = extractImplementation(implementationMarkdown);
 * ```
 */
export function extractImplementation(content) {
  const errors = [];
  const sections = {};
  for (const [key, { label, regex }] of Object.entries(
    IMPLEMENTATION_SECTION_HEADINGS,
  )) {
    const table = parseMarkdownTable(content, regex);
    sections[key] = table;
    if (!table) {
      errors.push(`Implementation: "${label}" section table not found.`);
    }
  }
  return { ...sections, errors };
}

const IMPLEMENTATION_STATUS_SECTION_HEADINGS = {
  barrels: {
    label: "Barrels & infrastructure",
    regex: /^## Barrels & infrastructure(?=[\s(]|$)/m,
  },
  core: { label: "Core submodules", regex: /^## Core submodules(?=[\s(]|$)/m },
  aws: { label: "AWS submodules", regex: /^## AWS submodules(?=[\s(]|$)/m },
};

/**
 * Extract `docs/implementation-status.md`'s implemented/total submodule
 * counts (from the generated "(N of M submodules)" sentence) plus its three
 * per-category tables (barrels/infrastructure, Core submodules, AWS
 * submodules). Same missing-section -> `errors` contract as
 * {@link extractRoadmap}; never throws.
 *
 * @param {string} content `docs/implementation-status.md` contents
 * @returns {{ implemented: number | undefined, total: number | undefined, barrels: ReturnType<typeof parseMarkdownTable>, core: ReturnType<typeof parseMarkdownTable>, aws: ReturnType<typeof parseMarkdownTable>, errors: string[] }}
 * @example
 * ```js
 * import { extractImplementationStatus } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * const { implemented, total } = extractImplementationStatus(implementationStatusMarkdown);
 * ```
 */
export function extractImplementationStatus(content) {
  const errors = [];
  const countMatch = /\((\d+) of (\d+) submodules\)/.exec(content);
  if (!countMatch) {
    errors.push(
      'Implementation status: "(N of M submodules)" count sentence not found.',
    );
  }
  const implemented = countMatch ? parseInt(countMatch[1], 10) : undefined;
  const total = countMatch ? parseInt(countMatch[2], 10) : undefined;

  const sections = {};
  for (const [key, { label, regex }] of Object.entries(
    IMPLEMENTATION_STATUS_SECTION_HEADINGS,
  )) {
    const table = parseMarkdownTable(content, regex);
    sections[key] = table;
    if (!table) {
      errors.push(`Implementation status: "${label}" section table not found.`);
    }
  }

  return { implemented, total, ...sections, errors };
}

function basenameNoExt(path) {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

// Sort dated corpus entries newest-first; entries without a date (an
// undated work log, or a plan link like IMPLEMENTATION.md) sort last.
function sortByDateDesc(entries) {
  return [...entries].sort((a, b) => {
    if (a.date === undefined && b.date === undefined) return 0;
    if (a.date === undefined) return 1;
    if (b.date === undefined) return -1;
    return b.date.localeCompare(a.date);
  });
}

function buildDatedSection(files, dirPrefix) {
  return sortByDateDesc(
    files.map(({ name, content }) => ({
      ...parseDatedDoc(name, content),
      name,
      href: blobUrl(`${dirPrefix}/${name}`),
    })),
  );
}

/**
 * Assemble every corpus section the hub's "Documentation corpus" tab lists —
 * ADRs, work logs, archived plans, active plans, the Core/AWS/scripts
 * reference catalog, and top-level READMEs — from pre-read file contents and
 * the reference catalog. Every entry carries an `href` built through
 * {@link blobUrl}. ADRs sort number-descending; logs/archive/plans sort
 * date-descending with undated entries last; reference entries group by
 * `catalog` namespace.
 *
 * @param {{
 *   adrFiles: { name: string, content: string }[],
 *   logFiles: { name: string, content: string }[],
 *   archiveFiles: { name: string, content: string }[],
 *   planFiles: { name: string, content: string }[],
 *   catalog: { namespace: string, name: string, status: string, docPath: string, symbols: string[] }[],
 *   scriptPages: string[],
 *   readmePaths: string[],
 * }} sources
 * @returns {{
 *   adrs: ReturnType<typeof parseAdr>[],
 *   logs: ReturnType<typeof parseDatedDoc>[],
 *   archive: ReturnType<typeof parseDatedDoc>[],
 *   plans: ReturnType<typeof parseDatedDoc>[],
 *   reference: { core: unknown[], aws: unknown[], scripts: unknown[] },
 *   readmes: { path: string, href: string }[],
 * }}
 * @example
 * ```js
 * import { buildCorpusSections } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * const corpus = buildCorpusSections({
 *   adrFiles: [], logFiles: [], archiveFiles: [], planFiles: [],
 *   catalog: [], scriptPages: [], readmePaths: ["README.md"],
 * });
 * ```
 */
export function buildCorpusSections({
  adrFiles = [],
  logFiles = [],
  archiveFiles = [],
  planFiles = [],
  catalog = [],
  scriptPages = [],
  readmePaths = [],
} = {}) {
  const adrs = adrFiles
    .map(({ name, content }) => {
      const parsed = parseAdr(name, content);
      return parsed
        ? { ...parsed, name, href: blobUrl(`docs/adr/${name}`) }
        : null;
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.number - a.number);

  const logs = buildDatedSection(logFiles, "docs/logs");
  const archive = buildDatedSection(archiveFiles, "docs/plans/archive");
  const plans = buildDatedSection(planFiles, "docs/plans");

  const referenceEntries = catalog.map((entry) => ({
    ...entry,
    href: blobUrl(entry.docPath),
  }));
  const core = referenceEntries.filter((entry) => entry.namespace === "core");
  const aws = referenceEntries.filter((entry) => entry.namespace === "aws");
  const scripts = scriptPages.map((docPath) => ({
    name: basenameNoExt(docPath),
    docPath,
    href: blobUrl(docPath),
  }));

  const readmes = readmePaths.map((path) => ({ path, href: blobUrl(path) }));

  return {
    adrs,
    logs,
    archive,
    plans,
    reference: { core, aws, scripts },
    readmes,
  };
}

/**
 * Escape the five HTML-significant characters. Every dynamic string rendered
 * by this module flows through here (directly, or via {@link renderCellMarkdown})
 * before it reaches the page — the boundary that keeps arbitrary tracker-doc
 * text (including a literal `<script>` cell) from becoming live markup.
 *
 * @param {string} text
 * @returns {string}
 * @example
 * ```js
 * import { escapeHtml } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * escapeHtml("<script>"); // "&lt;script&gt;"
 * ```
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveLinkTarget(target, sourceDir) {
  if (/^https?:\/\//.test(target)) return target;
  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);
  const resolved = posix.normalize(posix.join(sourceDir, pathPart));
  return blobUrl(resolved) + anchor;
}

/**
 * Render one tracker-table cell's markdown into HTML: escapes raw text first
 * (so an embedded `<script>` or other tag stays inert), then converts
 * `**bold**`, `` `code` ``, and `[label](target)` link syntax. A relative
 * `.md` link target is resolved against `sourceDir` (posix-joined, keeping any
 * `#anchor`) into a {@link blobUrl}; an absolute `http(s)` target passes
 * through unchanged.
 *
 * @param {string} text raw markdown cell text
 * @param {string} sourceDir the tracker doc's directory, repo-relative
 *   (e.g. "docs/plans"), used to resolve relative link targets
 * @returns {string} HTML-safe string
 * @example
 * ```js
 * import { renderCellMarkdown } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * renderCellMarkdown("[roadmap](../ROADMAP.md)", "docs/plans");
 * // '<a href="https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md">roadmap</a>'
 * ```
 */
export function renderCellMarkdown(text, sourceDir) {
  let html = escapeHtml(text);
  html = html.replace(
    /\[([^[\]]+)\]\(([^()]+)\)/g,
    (_match, label, target) =>
      `<a href="${resolveLinkTarget(target, sourceDir)}">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}

const STATUS_BADGE_LABELS = {
  done: "Done",
  todo: "To Do",
  "in-progress": "In Progress",
  deferred: "Deferred",
  blocked: "Blocked",
  rejected: "Rejected",
};

/**
 * Render a status kind (as returned by {@link classifyStatus}) as a `<span>`
 * badge with a `badge badge-<kind>` class pair the hub's stylesheet colors.
 *
 * @param {string} kind
 * @returns {string}
 * @example
 * ```js
 * import { renderStatusBadge } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * renderStatusBadge("done"); // '<span class="badge badge-done">Done</span>'
 * ```
 */
export function renderStatusBadge(kind) {
  const label = STATUS_BADGE_LABELS[kind] ?? kind;
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

/**
 * Render one tracker table (a header + rows, as returned by
 * {@link parseMarkdownTable}) as a captioned, id'd `<table>` wrapped in an
 * `overflow-x: auto` div. `statusColumn` (pass -1, or omit, when the table has
 * no Status column — see {@link columnIndex}) renders that column as ONLY a
 * {@link renderStatusBadge} badge — the raw cell text is dropped, since every
 * source Status cell is a single authored keyword and any supporting detail
 * (a merging PR reference, an unblock condition) belongs in another column;
 * every other cell goes through {@link renderCellMarkdown}.
 *
 * @param {{ id: string, caption: string, header: string[], rows: string[][], statusColumn?: number, sourceDir: string }} table
 * @returns {string}
 * @example
 * ```js
 * import { renderTrackerTable } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * renderTrackerTable({
 *   id: "priority0",
 *   caption: "Priority 0",
 *   header: ["Item", "Status"],
 *   rows: [["F8", "Done"]],
 *   statusColumn: 1,
 *   sourceDir: "docs",
 * });
 * ```
 */
export function renderTrackerTable({
  id,
  caption,
  header,
  rows,
  statusColumn = -1,
  sourceDir,
}) {
  const headerHtml = header
    .map((cell) => `<th>${escapeHtml(cell)}</th>`)
    .join("");
  const bodyHtml = rows
    .map((row) => {
      const cellsHtml = row
        .map((cell, index) => {
          if (index === statusColumn) {
            const kind = classifyStatus(cell);
            return `<td>${renderStatusBadge(kind)}</td>`;
          }
          return `<td>${renderCellMarkdown(cell, sourceDir)}</td>`;
        })
        .join("");
      return `<tr>${cellsHtml}</tr>`;
    })
    .join("");

  return [
    '<div class="table-wrapper">',
    `<table id="${escapeHtml(id)}">`,
    `<caption>${escapeHtml(caption)}</caption>`,
    `<thead><tr>${headerHtml}</tr></thead>`,
    `<tbody>${bodyHtml}</tbody>`,
    "</table>",
    "</div>",
  ].join("\n");
}

function renderOptionalTable(id, caption, table, sourceDir) {
  if (!table || table.header.length === 0) {
    return `<p class="empty">${escapeHtml(caption)}: no rows.</p>`;
  }
  return renderTrackerTable({
    id,
    caption,
    header: table.header,
    rows: table.rows,
    statusColumn: columnIndex(table.header, "Status"),
    sourceDir,
  });
}

function renderCorpusList(entries, labelFn) {
  if (entries.length === 0) return '<p class="empty">None.</p>';
  const items = entries
    .map(
      // entry.href is not escapeHtml()'d: every href in this module comes
      // from blobUrl(), which percent-encodes each path segment, so it can
      // never contain a raw '"' that would break out of the attribute.
      (entry) =>
        `<li><a href="${entry.href}">${escapeHtml(labelFn(entry))}</a></li>`,
    )
    .join("");
  return `<ul>${items}</ul>`;
}

const HUB_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1b1f23;
  --muted: #57606a;
  --border: #d0d7de;
  --badge-done: #1a7f37;
  --badge-todo: #0969da;
  --badge-in-progress: #9a6700;
  --badge-deferred: #8250df;
  --badge-blocked: #cf222e;
  --badge-rejected: #6e7781;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #c9d1d9;
    --muted: #8b949e;
    --border: #30363d;
    --badge-done: #3fb950;
    --badge-todo: #58a6ff;
    --badge-in-progress: #d29922;
    --badge-deferred: #a371f7;
    --badge-blocked: #f85149;
    --badge-rejected: #8b949e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 72rem;
  padding: 2rem 1.5rem 4rem;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  line-height: 1.5;
}
header p { color: var(--muted); }
.tiles { display: flex; gap: 1rem; margin: 1rem 0; }
.tile {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 1.25rem;
  display: flex;
  flex-direction: column;
}
.tile-value { font-size: 1.5rem; font-weight: 600; }
.tile-label { color: var(--muted); font-size: 0.85rem; }
.table-wrapper { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; width: 100%; }
caption { text-align: left; font-weight: 600; margin-bottom: 0.5rem; }
th, td {
  border: 1px solid var(--border);
  padding: 0.4rem 0.6rem;
  text-align: left;
  vertical-align: top;
}
tbody tr:nth-child(even) { background: color-mix(in srgb, var(--fg) 4%, transparent); }
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 0.1rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #ffffff;
}
.badge-done { background: var(--badge-done); }
.badge-todo { background: var(--badge-todo); }
.badge-in-progress { background: var(--badge-in-progress); }
.badge-deferred { background: var(--badge-deferred); }
.badge-blocked { background: var(--badge-blocked); }
.badge-rejected { background: var(--badge-rejected); }
.errors { color: #cf222e; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; }
`;

/**
 * Render the complete, self-contained hub HTML document from a fully-built
 * model (roadmap/backlog/ledger/corpus, each already extracted via this
 * module's other exports). Deterministic: the same `model` always produces
 * byte-identical output — there is no clock or randomness inside this
 * function. Every dynamic string is routed through {@link escapeHtml} or
 * {@link renderCellMarkdown}, so no tracker-doc content can inject markup.
 *
 * @param {{
 *   generatedAt: string,
 *   commitSha: string,
 *   summary: { implemented: number, total: number },
 *   roadmap: { priority0: unknown, priority1: unknown, priority2: unknown, governance: unknown, errors: string[] },
 *   backlog: { friction: unknown, adr0035Rollout: unknown, capabilityDeepeningWave: unknown, postComparisonHardeningWave: unknown, getterReality: unknown, gated: unknown, errors: string[] },
 *   ledger: { implemented: number, total: number, barrels: unknown, core: unknown, aws: unknown, errors: string[] },
 *   corpus: ReturnType<typeof buildCorpusSections>,
 * }} model
 * @returns {string} a full `<!doctype html>` document
 * @example
 * ```js
 * import { renderHubPage } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 *
 * const html = renderHubPage({
 *   generatedAt: new Date().toISOString(),
 *   commitSha: "abc1234",
 *   summary: { implemented: 30, total: 31 },
 *   roadmap: { priority0: null, priority1: null, priority2: null, governance: null, errors: [] },
 *   backlog: { friction: null, adr0035Rollout: null, capabilityDeepeningWave: null, postComparisonHardeningWave: null, getterReality: null, gated: null, errors: [] },
 *   ledger: { implemented: 30, total: 31, barrels: null, core: null, aws: null, errors: [] },
 *   corpus: { adrs: [], logs: [], archive: [], plans: [], reference: { core: [], aws: [], scripts: [] }, readmes: [] },
 * });
 * ```
 */
export function renderHubPage(model) {
  const { generatedAt, commitSha, summary, roadmap, backlog, ledger, corpus } =
    model;

  const roadmapSection = [
    renderOptionalTable(
      "roadmap-priority0",
      "Priority 0 — Library hardening",
      roadmap.priority0,
      "docs",
    ),
    renderOptionalTable(
      "roadmap-priority1",
      "Priority 1 — Consumer fleet",
      roadmap.priority1,
      "docs",
    ),
    renderOptionalTable(
      "roadmap-priority2",
      "Priority 2 — Gated / deferred",
      roadmap.priority2,
      "docs",
    ),
    renderOptionalTable(
      "roadmap-governance",
      "Governance follow-ups",
      roadmap.governance,
      "docs",
    ),
  ].join("\n");

  const backlogSection = [
    renderOptionalTable(
      "backlog-friction",
      "Library friction (F-series)",
      backlog.friction,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-adr-0035-rollout",
      "ADR-0035 rollout — failure reporting & diagnostics",
      backlog.adr0035Rollout,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-capability-deepening-wave",
      "Capability-deepening wave — ADR-0037/0038/0039",
      backlog.capabilityDeepeningWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-post-comparison-hardening-wave",
      "Post-comparison hardening wave — ADR-0040/0041/0042/0043",
      backlog.postComparisonHardeningWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-m3l-cli-build-out",
      "m3l-cli build-out — ADR-0042 activation (issue #333)",
      backlog.m3lCliBuildOut,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-cli-evolution-wave",
      "CLI evolution wave (U-series)",
      backlog.cliEvolutionWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-agent-operator-wave",
      "Agent-operator wave (V-series)",
      backlog.agentOperatorWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-console-wave",
      "m3l console wave (X-series)",
      backlog.consoleWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-codified-procedure-wave",
      "Codified-procedure engine wave — ADR-0046/0047/0048/0049",
      backlog.codifiedProcedureWave,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-getter-reality",
      "AWS getter reality",
      backlog.getterReality,
      "docs/plans",
    ),
    renderOptionalTable(
      "backlog-gated",
      "Gated library modules & deferred decisions (Later)",
      backlog.gated,
      "docs/plans",
    ),
  ].join("\n");

  const ledgerSection = [
    `<p>${ledger.implemented} of ${ledger.total} submodules implemented.</p>`,
    renderOptionalTable(
      "ledger-barrels",
      "Barrels & infrastructure",
      ledger.barrels,
      "docs",
    ),
    renderOptionalTable("ledger-core", "Core submodules", ledger.core, "docs"),
    renderOptionalTable("ledger-aws", "AWS submodules", ledger.aws, "docs"),
  ].join("\n");

  const corpusSection = [
    `<h3>ADRs</h3>${renderCorpusList(
      corpus.adrs,
      (entry) =>
        `ADR-${String(entry.number).padStart(4, "0")} — ${entry.title} (${entry.statusKind})`,
    )}`,
    `<h3>Work logs</h3>${renderCorpusList(
      corpus.logs,
      (entry) => `${entry.date ?? "undated"} — ${entry.title}`,
    )}`,
    `<h3>Archived plans</h3>${renderCorpusList(
      corpus.archive,
      (entry) => `${entry.date ?? "undated"} — ${entry.title}`,
    )}`,
    `<h3>Active plans</h3>${renderCorpusList(
      corpus.plans,
      (entry) => `${entry.date ?? "undated"} — ${entry.title}`,
    )}`,
    `<h3>Core reference</h3>${renderCorpusList(
      corpus.reference.core,
      (entry) => `${entry.name} (${entry.status})`,
    )}`,
    `<h3>AWS reference</h3>${renderCorpusList(
      corpus.reference.aws,
      (entry) => `${entry.name} (${entry.status})`,
    )}`,
    `<h3>Script contracts</h3>${renderCorpusList(
      corpus.reference.scripts,
      (entry) => entry.name,
    )}`,
    `<h3>READMEs</h3>${renderCorpusList(corpus.readmes, (entry) => entry.path)}`,
  ].join("\n");

  const allErrors = [...roadmap.errors, ...backlog.errors, ...ledger.errors];
  const errorsHtml = allErrors.length
    ? `<ul class="errors">${allErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>m3l-automation project hub</title>
<style>${HUB_STYLE}</style>
</head>
<body>
<header>
<h1>m3l-automation project hub</h1>
<p>Generated ${escapeHtml(generatedAt)} at commit <code>${escapeHtml(commitSha)}</code></p>
<div class="tiles">
<div class="tile"><span class="tile-value">${summary.implemented}</span><span class="tile-label">implemented</span></div>
<div class="tile"><span class="tile-value">${summary.total}</span><span class="tile-label">total submodules</span></div>
</div>
${errorsHtml}
</header>
<main>
<section id="roadmap">
<h2>Roadmap</h2>
${roadmapSection}
</section>
<section id="backlog">
<h2>Implementation backlog</h2>
${backlogSection}
</section>
<section id="ledger">
<h2>Implementation status ledger</h2>
${ledgerSection}
</section>
<section id="corpus">
<h2>Documentation corpus</h2>
${corpusSection}
</section>
</main>
<footer>
<p>Source trackers:
<a href="${blobUrl("docs/ROADMAP.md")}">ROADMAP.md</a>,
<a href="${blobUrl("docs/plans/IMPLEMENTATION.md")}">IMPLEMENTATION.md</a>,
<a href="${blobUrl("docs/implementation-status.md")}">implementation-status.md</a>.
Badges: <a href="commit-stats/aggregate.json">commit-stats/aggregate.json</a>.
</p>
</footer>
</body>
</html>
`;
}
