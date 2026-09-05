// Pure functions for cross-referencing docs/logs/README.md's six index
// tables against the log files actually present in docs/logs/. Consumed by
// bin/check-logs-index.mjs and bin/tests/check-logs-index.test.ts.
//
// Why this exists: the README's tables are hand-maintained — a log's section
// can't be derived mechanically, since a log file carries no frontmatter and
// no category field (see docs/logs/README.md's maintenance note) — so a row
// is easy to forget when /writing-work-logs writes a log. That's drifted
// silently at least twice before this gate existed:
// docs/logs/2026-07-22-promotion-audit.md ("tables stopped at 2026-07-16
// while ten…") and docs/logs/2026-09-03-x8-open-items.md (five same-day logs
// never indexed). Nothing mechanical can own the section assignment, but
// coverage — every log has at least one row, somewhere — needs no section
// knowledge at all, which is what this module checks.

/** Where work logs live. */
export const LOGS_DIR = "docs/logs";

/** The index this gate verifies against LOGS_DIR's contents. */
export const README_PATH = "docs/logs/README.md";

/** A README row's leading date cell, e.g. `| 2026-08-27 |`. */
const ROW_DATE_RE = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/;

/**
 * The `[text](./file.md)` link a conforming row carries — global so a row
 * linking more than one log (e.g. a close-out row citing several logs) is
 * fully captured, not just the first.
 */
const ROW_LINK_RE = /\]\(\.\/([A-Za-z0-9._-]+\.md)\)/g;

/** A log filename's `YYYY-MM-DD-` date prefix. */
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})-/;

/**
 * Parse every index row in `docs/logs/README.md`: a table row beginning with
 * a `YYYY-MM-DD` date cell whose row links to a log via `[text](./file.md)`.
 * Regex-based by house convention (`check-cadence-doc.mjs`: "Deliberately
 * regex-based, no YAML dependency") — every row lives on one physical line,
 * so a per-line scan is exact, not an approximation.
 *
 * A line with a date cell but no `./*.md` link (a malformed row) is silently
 * skipped rather than reported — no such row exists today, and inventing a
 * finding for a shape that has never occurred would be speculative. A row
 * linking more than one log (e.g. a close-out row citing several) yields one
 * entry per link, all sharing that row's date and line.
 *
 * @param {string} readmeText docs/logs/README.md's text
 * @returns {{ file: string, date: string, line: number }[]} one entry per
 *   link found, in document order; `line` is 1-indexed for annotations
 */
export function parseIndexLinks(readmeText) {
  /** @type {{ file: string, date: string, line: number }[]} */
  const links = [];

  readmeText.split("\n").forEach((text, index) => {
    const dateMatch = ROW_DATE_RE.exec(text);
    if (!dateMatch) return;
    for (const linkMatch of text.matchAll(ROW_LINK_RE)) {
      links.push({ file: linkMatch[1], date: dateMatch[1], line: index + 1 });
    }
  });

  return links;
}

/**
 * Log filenames on disk, excluding the index itself. Matches
 * `check-retrospective.mjs`'s existing `LOGS_DIR` filter exactly, so the two
 * gates count the same denominator.
 *
 * @param {string} dir absolute path to docs/logs/
 * @param {{ readdir: (dir: string) => string[] }} fs injected seam
 * @returns {string[]} sorted filenames
 */
export function listLogFiles(dir, fs) {
  return fs
    .readdir(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

/**
 * Log files with no README row linking them — written but undiscoverable
 * through the index. The core check; see the module header for the two
 * prior divergences it catches.
 *
 * @param {string[]} files log filenames on disk
 * @param {{ file: string }[]} links parsed README rows
 * @returns {string[]}
 */
export function checkCoverage(files, links) {
  const indexed = new Set(links.map((link) => link.file));
  const missing = files.filter((file) => !indexed.has(file)).sort();

  if (missing.length === 0) return [];

  return [
    `${missing.length} log file(s) exist in ${LOGS_DIR}/ but have no row in ` +
      `${README_PATH}, so they are written but undiscoverable through the ` +
      `index: ${missing.join(", ")}.`,
  ];
}

/**
 * A README row linking to a file that does not exist — a renamed or deleted
 * log the index was never updated for. Currently zero (every link resolves);
 * this is regression protection, not a live finding.
 *
 * @param {string[]} files log filenames on disk
 * @param {{ file: string, line: number }[]} links parsed README rows
 * @returns {string[]}
 */
export function checkDangling(files, links) {
  const onDisk = new Set(files);

  return links
    .filter((link) => !onDisk.has(link.file))
    .map(
      (link) =>
        `${README_PATH}:${link.line} links to ${link.file}, which does not ` +
        `exist in ${LOGS_DIR}/.`,
    );
}

/**
 * A log linked from more than one row — most likely during a backfill that
 * accidentally files one log into two sections.
 *
 * @param {{ file: string, line: number }[]} links parsed README rows
 * @returns {string[]}
 */
export function checkDuplicates(links) {
  /** @type {Map<string, number[]>} */
  const linesByFile = new Map();

  for (const link of links) {
    const lines = linesByFile.get(link.file) ?? [];
    lines.push(link.line);
    linesByFile.set(link.file, lines);
  }

  /** @type {string[]} */
  const findings = [];
  for (const [file, lines] of linesByFile) {
    if (lines.length > 1) {
      findings.push(
        `${file} is linked from ${lines.length} rows in ${README_PATH} ` +
          `(lines ${lines.join(", ")}) — link it exactly once.`,
      );
    }
  }

  return findings.sort();
}

/**
 * A row's date column disagreeing with the `YYYY-MM-DD-` prefix of the log
 * it links — typically a copy-paste error when a row was hand-inserted.
 *
 * @param {{ file: string, date: string, line: number }[]} links parsed
 *   README rows
 * @returns {string[]}
 */
export function checkDateMismatch(links) {
  /** @type {string[]} */
  const findings = [];

  for (const link of links) {
    const match = FILENAME_DATE_RE.exec(link.file);
    if (match && match[1] !== link.date) {
      findings.push(
        `${README_PATH}:${link.line} dates ${link.file} as ${link.date}, ` +
          `but the filename's own date is ${match[1]}.`,
      );
    }
  }

  return findings;
}

/**
 * All four checks composed, over an already-parsed README and file list.
 *
 * @param {{ files: string[], links: { file: string, date: string, line: number }[] }} input
 * @returns {string[]} one finding string per problem found, across all checks
 */
export function checkLogsIndex({ files, links }) {
  return [
    ...checkCoverage(files, links),
    ...checkDangling(files, links),
    ...checkDuplicates(links),
    ...checkDateMismatch(links),
  ];
}
