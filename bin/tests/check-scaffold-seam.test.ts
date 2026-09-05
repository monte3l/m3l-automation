import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for implementedModules (node:fs)
// ---------------------------------------------------------------------------
//
// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default — the spread makes them
// plain, writable object properties), following bin/tests/check-test-counts.test.ts.
//
// bin/check-scaffold-seam.mjs now guards its scan-and-report logic behind
// `process.argv[1] === fileURLToPath(import.meta.url)`, matching every
// sibling bin/ checker (e.g. check-test-counts.mjs) — importing the module
// below for its exported helpers has no filesystem side effects and never
// calls process.exit.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  LANDING_PLAN_HEADING,
  STATUS_COL,
  hasSeamTestFile,
  hasStatusRow,
  implementedModules,
  landingPlanVerdict,
  statusEmoji,
} from "../../bin/check-scaffold-seam.mjs";

// Helper to build a well-formed row with 9 columns (8 separators), matching
// the layout documented in check-scaffold-seam.mjs:
//   [0] ""  [1] Submodule  [2] Spec  [3] Planned  [4] Symbols  [5] Status …
function makeRow(mod: string, status: string): string {
  return `| ${mod} | spec | planned | symbols | ${status} | tests | reviewed | notes |`;
}

// ---------------------------------------------------------------------------
// implementedModules
// ---------------------------------------------------------------------------

describe("implementedModules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns directory names that contain an index.ts", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "polling", isDirectory: () => true },
      { name: "retry", isDirectory: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith("polling/index.ts"),
    );

    expect(implementedModules("/fake/src/core")).toEqual(["polling"]);
  });

  test("filters out entries that are not directories", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "polling", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect(implementedModules("/fake/src/core")).toEqual(["polling"]);
  });

  test("filters out directories with no index.ts", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "polling", isDirectory: () => true },
      { name: "scaffolded-only", isDirectory: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith("polling/index.ts"),
    );

    expect(implementedModules("/fake/src/core")).toEqual(["polling"]);
  });

  test("returns an empty array when readdirSync throws (e.g. the namespace dir does not exist)", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("ENOENT: no such directory");
    });

    expect(implementedModules("/does/not/exist")).toEqual([]);
  });

  test("returns an empty array when no directory contains an index.ts", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "empty-dir", isDirectory: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(implementedModules("/fake/src/core")).toEqual([]);
  });

  test("preserves readdirSync's directory order in the returned list", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "zeta", isDirectory: () => true },
      { name: "alpha", isDirectory: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect(implementedModules("/fake/src/core")).toEqual(["zeta", "alpha"]);
  });
});

// ---------------------------------------------------------------------------
// hasSeamTestFile
// ---------------------------------------------------------------------------

describe("hasSeamTestFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns true when the exact <module>.test.ts file exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith("polling.test.ts"),
    );
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockReturnValue([]);

    expect(hasSeamTestFile("/fake/tests", "polling")).toBe(true);
    // the exact-file check short-circuits before readdirSync is consulted
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  test("returns true when only a hyphenated sibling exists (no exact file)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "procedure-conditions.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "procedure")).toBe(true);
  });

  test("returns true when multiple hyphenated siblings exist and none is the exact file", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "procedure-conditions.test.ts",
      "procedure-transitions.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "procedure")).toBe(true);
  });

  test("returns false when neither the exact file nor any hyphenated sibling exists, even in a non-empty directory", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "polling.test.ts",
      "retry.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "procedure")).toBe(false);
  });

  test("returns false when readdirSync throws (tests dir does not exist) and no exact file exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("ENOENT: no such directory");
    });

    expect(hasSeamTestFile("/does/not/exist", "procedure")).toBe(false);
  });

  test("does not match a sibling-shaped filename missing the hyphen boundary (s3extra.test.ts)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "s3extra.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "s3")).toBe(false);
  });

  test("does not match a filename where the module name is not anchored at the start (xs3-thing.test.ts)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "xs3-thing.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "s3")).toBe(false);
  });

  test("matches a genuine hyphenated sibling sharing the module's prefix (s3-objects.test.ts)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "s3-objects.test.ts",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(hasSeamTestFile("/fake/tests", "s3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasStatusRow
// ---------------------------------------------------------------------------

describe("hasStatusRow", () => {
  test("matches a row whose first pipe-cell is exactly the module name", () => {
    const text = makeRow("polling", "✅");
    expect(hasStatusRow(text, "polling")).toBe(true);
  });

  test("returns false when no row matches the module", () => {
    const text = makeRow("retry", "✅");
    expect(hasStatusRow(text, "polling")).toBe(false);
  });

  test("does not match a row for a similarly-named-but-different module (s3 row, s3-extra lookup)", () => {
    const text = makeRow("s3", "✅");
    expect(hasStatusRow(text, "s3-extra")).toBe(false);
  });

  test("does not match the reverse case either (s3-extra row, s3 lookup)", () => {
    const text = makeRow("s3-extra", "✅");
    expect(hasStatusRow(text, "s3")).toBe(false);
  });

  test("matches regardless of surrounding whitespace inside the cell", () => {
    const text = `|   polling   | spec | planned | symbols | ✅ | tests | reviewed | notes |`;
    expect(hasStatusRow(text, "polling")).toBe(true);
  });

  test("finds a matching row anywhere in a multi-line table", () => {
    const text = [
      "| Submodule | Spec | Planned | Symbols | Status | Tests | Reviewed | Notes |",
      "| --------- | ---- | ------- | ------- | ------ | ----- | -------- | ----- |",
      makeRow("retry", "✅"),
      makeRow("polling", "🧪"),
    ].join("\n");
    expect(hasStatusRow(text, "polling")).toBe(true);
  });

  test("returns false for an empty string", () => {
    expect(hasStatusRow("", "polling")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statusEmoji
// ---------------------------------------------------------------------------

describe("statusEmoji", () => {
  test("returns the status cell's content for a matching row", () => {
    const text = makeRow("polling", "✅");
    expect(statusEmoji(text, "polling")).toBe("✅");
  });

  test("returns null when no row matches the module", () => {
    const text = makeRow("retry", "✅");
    expect(statusEmoji(text, "polling")).toBe(null);
  });

  test("does not match a similarly-named-but-different module (s3 row, s3-extra lookup)", () => {
    const text = makeRow("s3", "✅");
    expect(statusEmoji(text, "s3-extra")).toBe(null);
  });

  test("does not match the reverse case either (s3-extra row, s3 lookup)", () => {
    const text = makeRow("s3-extra", "✅");
    expect(statusEmoji(text, "s3")).toBe(null);
  });

  test("ignores a row with fewer than 9 columns (e.g. the barrels table)", () => {
    const text = "| barrels | ✅ | 7 tests |";
    expect(statusEmoji(text, "barrels")).toBe(null);
  });

  test("returns only the first code point of a multi-character status cell", () => {
    const text = makeRow("polling", "🧪 in progress");
    expect(statusEmoji(text, "polling")).toBe("🧪");
  });

  test("returns null when the status cell is empty", () => {
    const text =
      "| polling | spec | planned | symbols |  | tests | reviewed | notes |";
    expect(statusEmoji(text, "polling")).toBe(null);
  });

  test("finds the correct row in a multi-line table, skipping non-pipe lines", () => {
    const text = [
      "## Some heading",
      makeRow("retry", "✅"),
      makeRow("polling", "🟢"),
      "plain text line, not a table row",
    ].join("\n");
    expect(statusEmoji(text, "polling")).toBe("🟢");
  });

  test("returns null for an empty string", () => {
    expect(statusEmoji("", "polling")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// STATUS_COL
// ---------------------------------------------------------------------------

describe("STATUS_COL", () => {
  test("is column index 5 in the split('|') layout documented alongside it", () => {
    expect(STATUS_COL).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// LANDING_PLAN_HEADING
// ---------------------------------------------------------------------------

describe("LANDING_PLAN_HEADING", () => {
  test("matches a bare '## Landing plan' heading line", () => {
    expect(LANDING_PLAN_HEADING.test("## Landing plan")).toBe(true);
  });

  test("matches with trailing whitespace after the heading text", () => {
    expect(LANDING_PLAN_HEADING.test("## Landing plan   ")).toBe(true);
  });

  test("matches when embedded among other headings in a larger document", () => {
    const doc = [
      "# Module X",
      "",
      "## Overview",
      "some text",
      "",
      "## Landing plan",
      "",
      "- step one",
    ].join("\n");
    expect(LANDING_PLAN_HEADING.test(doc)).toBe(true);
  });

  test("does not match a level-3 heading ('### Landing plan')", () => {
    expect(LANDING_PLAN_HEADING.test("### Landing plan")).toBe(false);
  });

  test("does not match a level-1 heading ('# Landing plan')", () => {
    expect(LANDING_PLAN_HEADING.test("# Landing plan")).toBe(false);
  });

  test("does not match the wrong case ('## landing plan')", () => {
    expect(LANDING_PLAN_HEADING.test("## landing plan")).toBe(false);
  });

  test("does not match when the phrase appears mid-line rather than starting a heading", () => {
    expect(
      LANDING_PLAN_HEADING.test("See the ## Landing plan section below"),
    ).toBe(false);
  });

  test("does not match when trailing text follows the phrase on the same line", () => {
    expect(LANDING_PLAN_HEADING.test("## Landing plan for module X")).toBe(
      false,
    );
  });

  test("is a naive line-based regex: matches a heading-shaped line inside a fenced code block the same as a real heading", () => {
    // The regex has no Markdown-fence awareness; this documents that as
    // expected behavior of a plain regex, not a bug under test.
    const doc = ["```markdown", "## Landing plan", "```"].join("\n");
    expect(LANDING_PLAN_HEADING.test(doc)).toBe(true);
  });

  test("returns false for a document with no Landing plan heading at all", () => {
    expect(LANDING_PLAN_HEADING.test("## Overview\n\nsome text")).toBe(false);
  });

  test("returns false for an empty string", () => {
    expect(LANDING_PLAN_HEADING.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// landingPlanVerdict
// ---------------------------------------------------------------------------

describe("landingPlanVerdict", () => {
  test('returns "missing-page" when refText is null (reference page could not be read)', () => {
    expect(landingPlanVerdict(null)).toBe("missing-page");
  });

  test('returns "missing-heading" for a reference page without the Landing plan heading', () => {
    const refText = "# newmod\n\n## Overview\n\nsome prose\n";
    expect(landingPlanVerdict(refText)).toBe("missing-heading");
  });

  test('returns "ok" for a reference page containing the "## Landing plan" heading', () => {
    const refText = [
      "# newmod",
      "",
      "## Landing plan",
      "",
      "| Slice | Scope | Status |",
      "| ----- | ----- | ------ |",
      "| Slice 1 | first thing | In progress |",
    ].join("\n");
    expect(landingPlanVerdict(refText)).toBe("ok");
  });

  test('returns "missing-heading" for a wrong-level heading ("### Landing plan"), reusing a LANDING_PLAN_HEADING fixture', () => {
    expect(landingPlanVerdict("### Landing plan")).toBe("missing-heading");
  });

  test('returns "missing-heading" for wrong-case text ("## landing plan"), reusing a LANDING_PLAN_HEADING fixture', () => {
    expect(landingPlanVerdict("## landing plan")).toBe("missing-heading");
  });

  test('returns "ok" when the heading is embedded mid-document among other headings, reusing a LANDING_PLAN_HEADING fixture', () => {
    const doc = [
      "# Module X",
      "",
      "## Overview",
      "some text",
      "",
      "## Landing plan",
      "",
      "| Slice | Scope | Status |",
      "| ----- | ----- | ------ |",
      "| Slice 1 | first thing | In progress |",
    ].join("\n");
    expect(landingPlanVerdict(doc)).toBe("ok");
  });

  test('returns "missing-heading" for an empty string (page exists but is blank)', () => {
    expect(landingPlanVerdict("")).toBe("missing-heading");
  });

  test('returns "unparseable-table" for a heading followed by a numbered list, not a pipe table (docs/reference/aws/bedrock-runtime.md shape)', () => {
    const refText = [
      "# bedrock-runtime",
      "",
      "## Landing plan",
      "",
      "Two independently-landable PRs (ADR-0072):",
      "",
      "1. **Slice 1 — core wrapper.** `invoke()` single-shot Converse call, the",
      "   model registry/fallback state machine, token usage capture, the three",
      "   error classes. **Shipped** — PR #725, merged into `main`.",
      "2. **Slice 2 — streaming.** `invokeStream()` over `ConverseStreamCommand`.",
      "   **Shipped** — PR #728, merged into `main`.",
    ].join("\n");
    expect(landingPlanVerdict(refText)).toBe("unparseable-table");
  });

  test('returns "unparseable-table" for a pipe table with a header and separator row but no "Status" header cell', () => {
    const refText = [
      "# newmod",
      "",
      "## Landing plan",
      "",
      "| Slice | Scope | Notes |",
      "| ----- | ----- | ----- |",
      "| Slice 1 | first thing | some note |",
    ].join("\n");
    expect(landingPlanVerdict(refText)).toBe("unparseable-table");
  });

  test('returns "unparseable-table" for a pipe table with a header and separator row but zero data rows', () => {
    const refText = [
      "# newmod",
      "",
      "## Landing plan",
      "",
      "| Slice | Scope | Status |",
      "| ----- | ----- | ------ |",
    ].join("\n");
    expect(landingPlanVerdict(refText)).toBe("unparseable-table");
  });

  test('returns "ok" for a fully well-formed table with a header, separator, and at least one data row (positive control)', () => {
    const refText = [
      "# newmod",
      "",
      "## Landing plan",
      "",
      "| Slice | Scope | Status |",
      "| ----- | ----- | ------ |",
      "| Slice 1 | first thing | In progress |",
    ].join("\n");
    expect(landingPlanVerdict(refText)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// ADR-0072 landing-plan gate — composed from exported primitives
// ---------------------------------------------------------------------------
//
// The "is a module in-flight" half of the decision (status !== null &&
// status !== "✅") still lives inline in the CLI block at the bottom of
// bin/check-scaffold-seam.mjs, not extracted into a function — see the final
// report. The other half — "is-missing" vs "missing a heading" vs "ok" for
// the reference page — is now the exported, directly-tested
// `landingPlanVerdict` above. These tests exercise `statusEmoji` (the
// in-flight half's input) against synthetic status-table text, to prove it
// yields the values ADR-0072's in-flight check depends on. They do not
// execute the module's own if/else branch or its exact error-message text.

describe("ADR-0072 landing-plan gate inputs, composed from exported primitives", () => {
  test("a ✅ module resolves to the exemption sentinel status", () => {
    const text = makeRow("polling", "✅");
    expect(statusEmoji(text, "polling")).toBe("✅");
    // module logic: `status !== null && status !== "✅"` is false here, so
    // the module would skip the landing-plan check for this row.
  });

  test("a non-✅ module (e.g. 🧪, in flight) resolves to a status that is neither null nor the exemption sentinel", () => {
    const text = makeRow("newmod", "🧪");
    const status = statusEmoji(text, "newmod");
    expect(status).not.toBe(null);
    expect(status).not.toBe("✅");
    // module logic: this combination makes the landing-plan check run.
  });

  test("a module with no status row resolves to null, which the module's own null-check excludes from the landing-plan gate", () => {
    const text = makeRow("other", "✅");
    expect(statusEmoji(text, "newmod")).toBe(null);
    // module logic: `status !== null` is false for null, so the
    // landing-plan check does not re-run here — the missing-row case is
    // already reported separately by the hasStatusRow branch.
  });
});
