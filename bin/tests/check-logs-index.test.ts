/**
 * Tests for bin/lib/logs-index.mjs — the pure-function module that
 * cross-references docs/logs/README.md's index tables against the log files
 * actually present in docs/logs/.
 *
 * bin/check-logs-index.mjs (the CLI runner) is NOT imported here: it executes
 * its full CLI body unconditionally at module load with no separately exported
 * functions. This file follows the established convention (see
 * bin/tests/check-script-docs.test.ts) of exercising only the exported,
 * side-effect-free lib functions.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  LOGS_DIR,
  README_PATH,
  checkCoverage,
  checkDangling,
  checkDateMismatch,
  checkDuplicates,
  checkLogsIndex,
  listLogFiles,
  parseIndexLinks,
} from "../lib/logs-index.mjs";

/** A single parsed README row, matching parseIndexLinks's return element. */
interface IndexLink {
  file: string;
  date: string;
  line: number;
}

// ---------------------------------------------------------------------------
// LOGS_DIR / README_PATH
// ---------------------------------------------------------------------------

describe("LOGS_DIR", () => {
  test("is 'docs/logs'", () => {
    expect(LOGS_DIR).toBe("docs/logs");
  });

  test("type is string", () => {
    expectTypeOf(LOGS_DIR).toEqualTypeOf<string>();
  });
});

describe("README_PATH", () => {
  test("is 'docs/logs/README.md'", () => {
    expect(README_PATH).toBe("docs/logs/README.md");
  });

  test("type is string", () => {
    expectTypeOf(README_PATH).toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// parseIndexLinks
// ---------------------------------------------------------------------------

describe("parseIndexLinks", () => {
  // A small multi-section fixture: two H2 sections each with a header row, a
  // separator row, and one conforming data row; a stray date-cell row with no
  // ./*.md link inside section A; and trailing prose with a non-log link that
  // must not be mistaken for an index row.
  const README_FIXTURE = [
    "# Work log index",
    "",
    "## Section A",
    "",
    "| Date | Log |",
    "| --- | --- |",
    "| 2026-07-01 | [Log one](./2026-07-01-log-one.md) |",
    "| 2026-07-03 | placeholder, no link |",
    "",
    "## Section B",
    "",
    "| Date | Log |",
    "| --- | --- |",
    "| 2026-07-02 | [Log two](./2026-07-02-log-two.md) |",
    "",
    "See the [tracker](../ROADMAP.md) for open items.",
  ].join("\n");

  test("extracts {file, date, line} for each conforming row, in document order", () => {
    expect(parseIndexLinks(README_FIXTURE)).toEqual([
      { file: "2026-07-01-log-one.md", date: "2026-07-01", line: 7 },
      { file: "2026-07-02-log-two.md", date: "2026-07-02", line: 14 },
    ] satisfies IndexLink[]);
  });

  test("does not pick up a non-./*.md link outside a data row (e.g. a tracker link)", () => {
    const links = parseIndexLinks(README_FIXTURE);
    expect(links.some((link) => link.file.includes("ROADMAP"))).toBe(false);
    expect(links).toHaveLength(2);
  });

  test("return type is IndexLink[]", () => {
    expectTypeOf(parseIndexLinks(README_FIXTURE)).toEqualTypeOf<IndexLink[]>();
  });

  test("ignores table header and separator rows (no date cell)", () => {
    const text = ["| Date | Log |", "| --- | --- |"].join("\n");
    expect(parseIndexLinks(text)).toEqual([]);
  });

  test("skips a line with a date cell but no ./<file>.md link", () => {
    const text = "| 2026-07-03 | placeholder, no link |";
    expect(parseIndexLinks(text)).toEqual([]);
  });

  test("extracts both links from a single row citing two logs, sharing that row's date and line", () => {
    const text =
      "| 2026-07-15 | close-out — merge outcomes | [a](./2026-07-15-a.md), [b](./2026-07-15-b.md) |";
    expect(parseIndexLinks(text)).toEqual([
      { file: "2026-07-15-a.md", date: "2026-07-15", line: 1 },
      { file: "2026-07-15-b.md", date: "2026-07-15", line: 1 },
    ] satisfies IndexLink[]);
  });
});

// ---------------------------------------------------------------------------
// listLogFiles
// ---------------------------------------------------------------------------

describe("listLogFiles", () => {
  test("excludes README.md and sorts the remainder, given an injected readdir stub", () => {
    const fs = {
      readdir: () => [
        "2026-07-02-b.md",
        "README.md",
        "2026-07-01-a.md",
        "2026-07-03-c.md",
      ],
    };
    expect(listLogFiles(LOGS_DIR, fs)).toEqual([
      "2026-07-01-a.md",
      "2026-07-02-b.md",
      "2026-07-03-c.md",
    ]);
  });

  test("drops non-.md entries", () => {
    const fs = {
      readdir: () => ["2026-07-01-a.md", "notes.txt", ".DS_Store", "sub-dir"],
    };
    expect(listLogFiles(LOGS_DIR, fs)).toEqual(["2026-07-01-a.md"]);
  });

  test("return type is string[]", () => {
    expectTypeOf(listLogFiles(LOGS_DIR, { readdir: () => [] })).toEqualTypeOf<
      string[]
    >();
  });
});

// ---------------------------------------------------------------------------
// checkCoverage
// ---------------------------------------------------------------------------

describe("checkCoverage", () => {
  test("no findings when every on-disk file has a row", () => {
    const files = ["2026-07-01-a.md", "2026-07-02-b.md"];
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 5 },
      { file: "2026-07-02-b.md", date: "2026-07-02", line: 6 },
    ];
    expect(checkCoverage(files, links)).toEqual([]);
  });

  test("reports a file present on disk but absent from the parsed links, by name", () => {
    const files = ["2026-07-01-a.md", "2026-07-02-b.md"];
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 5 },
    ];
    const findings = checkCoverage(files, links);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toContain("2026-07-02-b.md");
    expect(finding).toContain(LOGS_DIR);
    expect(finding).toContain(README_PATH);
  });
});

// ---------------------------------------------------------------------------
// checkDangling
// ---------------------------------------------------------------------------

describe("checkDangling", () => {
  test("no findings when every link resolves", () => {
    const files = ["2026-07-01-a.md"];
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 5 },
    ];
    expect(checkDangling(files, links)).toEqual([]);
  });

  test("reports a link whose target isn't in the file list, including its line number", () => {
    const files = ["2026-07-01-a.md"];
    const links: IndexLink[] = [
      { file: "2026-07-02-missing.md", date: "2026-07-02", line: 9 },
    ];
    const findings = checkDangling(files, links);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toContain("2026-07-02-missing.md");
    expect(finding).toContain(":9");
    expect(finding).toContain("does not");
  });
});

// ---------------------------------------------------------------------------
// checkDuplicates
// ---------------------------------------------------------------------------

describe("checkDuplicates", () => {
  test("no findings when each file is linked once", () => {
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 3 },
      { file: "2026-07-02-b.md", date: "2026-07-02", line: 4 },
    ];
    expect(checkDuplicates(links)).toEqual([]);
  });

  test("reports a file linked from two rows, with both line numbers in the message", () => {
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 3 },
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 10 },
    ];
    const findings = checkDuplicates(links);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toContain("linked from 2 rows");
    expect(finding).toContain("3");
    expect(finding).toContain("10");
  });
});

// ---------------------------------------------------------------------------
// checkDateMismatch
// ---------------------------------------------------------------------------

describe("checkDateMismatch", () => {
  test("no findings when every row's date matches its filename's date prefix", () => {
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 3 },
    ];
    expect(checkDateMismatch(links)).toEqual([]);
  });

  test("reports a row whose date disagrees with the filename's date, both dates visible", () => {
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-05", line: 3 },
    ];
    const findings = checkDateMismatch(links);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toContain("2026-07-05");
    expect(finding).toContain("2026-07-01");
  });
});

// ---------------------------------------------------------------------------
// checkLogsIndex (composition, integration smoke)
// ---------------------------------------------------------------------------

describe("checkLogsIndex", () => {
  test("returns [] for a clean README against its own listed files", () => {
    const files = ["2026-07-01-a.md", "2026-07-02-b.md"];
    const links: IndexLink[] = [
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 5 },
      { file: "2026-07-02-b.md", date: "2026-07-02", line: 6 },
    ];
    expect(checkLogsIndex({ files, links })).toEqual([]);
  });

  test("returns exactly 4 findings when one violation of each kind is seeded simultaneously", () => {
    // Files on disk: an indexed one, another indexed one, and one that has NO
    // row at all (coverage violation).
    const files = [
      "2026-07-01-a.md",
      "2026-07-02-b.md",
      "2026-07-03-unindexed.md",
    ];
    const links: IndexLink[] = [
      // First occurrence of a.md: correctly dated, fine on its own.
      { file: "2026-07-01-a.md", date: "2026-07-01", line: 5 },
      // Second occurrence of a.md: a duplicate link AND its date column
      // disagrees with the filename's own date.
      { file: "2026-07-01-a.md", date: "2026-07-09", line: 6 },
      // b.md: correctly linked once, correctly dated — no findings from it.
      { file: "2026-07-02-b.md", date: "2026-07-02", line: 7 },
      // A link to a file that doesn't exist on disk (dangling violation).
      { file: "2026-07-04-dangling.md", date: "2026-07-04", line: 8 },
    ];

    const findings = checkLogsIndex({ files, links });
    expect(findings).toHaveLength(4);

    const coverageFinding = findings.find((finding) =>
      finding.includes("undiscoverable through the index"),
    );
    expect(coverageFinding).toBeDefined();
    expect(coverageFinding).toContain("2026-07-03-unindexed.md");

    const danglingFinding = findings.find((finding) =>
      finding.includes("does not exist in"),
    );
    expect(danglingFinding).toBeDefined();
    expect(danglingFinding).toContain("2026-07-04-dangling.md");
    expect(danglingFinding).toContain(":8");

    const duplicateFinding = findings.find((finding) =>
      finding.includes("linked from"),
    );
    expect(duplicateFinding).toBeDefined();
    expect(duplicateFinding).toContain("2026-07-01-a.md");
    expect(duplicateFinding).toContain("linked from 2 rows");

    const dateMismatchFinding = findings.find((finding) =>
      finding.includes("filename's own date is"),
    );
    expect(dateMismatchFinding).toBeDefined();
    expect(dateMismatchFinding).toContain("2026-07-09");
    expect(dateMismatchFinding).toContain("2026-07-01");
  });

  test("return type is string[]", () => {
    expectTypeOf(checkLogsIndex({ files: [], links: [] })).toEqualTypeOf<
      string[]
    >();
  });
});
