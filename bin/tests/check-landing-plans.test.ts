import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// bin/check-landing-plans.mjs guards its scan-and-report logic behind
// `process.argv[1] === fileURLToPath(import.meta.url)`, matching every
// sibling bin/ checker (see bin/tests/check-scaffold-seam.test.ts), so
// importing it would be side-effect-free. Most of its logic composes
// selectDatedPlans/checkLandingPlanDoc from bin/lib/landing-plans.mjs, which
// this file exercises directly with no node:fs mock (every function under
// test there is pure). `listPlanFiles` is its one exported, fs-touching
// helper — it needs a node:fs mock, following implementedModules's pattern
// in bin/tests/check-scaffold-seam.test.ts.
//
// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default — the spread makes them
// plain, writable object properties).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  DATED_PLAN_RE,
  PLAN_DIR,
  checkLandingPlanDoc,
  findDuplicateSliceIds,
  hasEmptySliceId,
  selectDatedPlans,
} from "../../bin/lib/landing-plans.mjs";
import { listPlanFiles } from "../../bin/check-landing-plans.mjs";

// ---------------------------------------------------------------------------
// PLAN_DIR / DATED_PLAN_RE
// ---------------------------------------------------------------------------

describe("PLAN_DIR", () => {
  test("is the docs/plans directory constant", () => {
    expect(PLAN_DIR).toBe("docs/plans");
  });
});

describe("DATED_PLAN_RE", () => {
  test("matches a well-formed dated plan filename", () => {
    expect(DATED_PLAN_RE.test("2026-08-20-agent-operator.md")).toBe(true);
  });

  test("does not match an undated tracker filename", () => {
    expect(DATED_PLAN_RE.test("README.md")).toBe(false);
    expect(DATED_PLAN_RE.test("IMPLEMENTATION.md")).toBe(false);
  });

  test("does not match a directory-shaped or non-matching name", () => {
    expect(DATED_PLAN_RE.test("archive")).toBe(false);
    expect(DATED_PLAN_RE.test("notes.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectDatedPlans
// ---------------------------------------------------------------------------

describe("selectDatedPlans", () => {
  test("filters to dated plan filenames, sorted", () => {
    expect(
      selectDatedPlans([
        "README.md",
        "IMPLEMENTATION.md",
        "2026-08-20-agent-operator.md",
        "2026-09-02-u11-retry-resume-cancellation.md",
      ]),
    ).toEqual([
      "2026-08-20-agent-operator.md",
      "2026-09-02-u11-retry-resume-cancellation.md",
    ]);
  });

  test("excludes a directory-shaped or non-matching name", () => {
    expect(selectDatedPlans(["archive", "notes.md"])).toEqual([]);
  });

  test("returns an empty array for an empty input list", () => {
    expect(selectDatedPlans([])).toEqual([]);
  });

  test("sorts out-of-order dated filenames lexicographically", () => {
    expect(
      selectDatedPlans(["2026-09-02-later.md", "2026-08-20-earlier.md"]),
    ).toEqual(["2026-08-20-earlier.md", "2026-09-02-later.md"]);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateSliceIds
// ---------------------------------------------------------------------------

describe("findDuplicateSliceIds", () => {
  test("returns [] when sliceIndex is -1 (no Slice column)", () => {
    expect(findDuplicateSliceIds([["A"], ["A"]], -1)).toEqual([]);
  });

  test("returns [] when nothing repeats", () => {
    expect(findDuplicateSliceIds([["A"], ["B"]], 0)).toEqual([]);
  });

  test("returns a duplicate Slice value in first-seen order", () => {
    expect(findDuplicateSliceIds([["A"], ["A"]], 0)).toEqual(["A"]);
  });

  test("skips empty Slice cells rather than counting them as duplicates", () => {
    expect(findDuplicateSliceIds([[""], [""], ["A"]], 0)).toEqual([]);
  });

  test("reports a duplicate once even with three or more occurrences", () => {
    expect(findDuplicateSliceIds([["A"], ["A"], ["A"]], 0)).toEqual(["A"]);
  });

  test("reports two independent duplicate pairs, in first-seen order", () => {
    expect(findDuplicateSliceIds([["A"], ["A"], ["B"], ["B"]], 0)).toEqual([
      "A",
      "B",
    ]);
  });
});

// ---------------------------------------------------------------------------
// hasEmptySliceId
// ---------------------------------------------------------------------------

describe("hasEmptySliceId", () => {
  test("returns false when sliceIndex is -1 (no Slice column)", () => {
    expect(hasEmptySliceId([[""], [""]], -1)).toBe(false);
  });

  test("returns true when a row's Slice cell is empty", () => {
    expect(hasEmptySliceId([["A"], [""]], 0)).toBe(true);
  });

  test("returns true when a row's Slice cell is whitespace-only", () => {
    expect(hasEmptySliceId([["A"], ["   "]], 0)).toBe(true);
  });

  test("returns false when every Slice cell is non-empty", () => {
    expect(hasEmptySliceId([["A"], ["B"]], 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkLandingPlanDoc
// ---------------------------------------------------------------------------
//
// Fixtures below are verified verbatim against the real implementation
// (see the task's acceptance fixtures) — match them exactly.

describe("checkLandingPlanDoc", () => {
  test("null text yields missing-page, missingSliceColumn false (verdict arm never reaches the Slice-column check)", () => {
    expect(checkLandingPlanDoc(null)).toEqual({
      verdict: "missing-page",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("prose with no Landing plan heading yields missing-heading, missingSliceColumn false (verdict arm never reaches the Slice-column check)", () => {
    expect(checkLandingPlanDoc("prose, no heading")).toEqual({
      verdict: "missing-heading",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a numbered list under the heading yields unparseable-table, missingSliceColumn false (verdict arm never reaches the Slice-column check)", () => {
    expect(checkLandingPlanDoc("## Landing plan\n1. list\n")).toEqual({
      verdict: "unparseable-table",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a table with no Status column yields unparseable-table, missingSliceColumn false", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope |\n| --- | --- |\n| 1 | x |\n",
      ),
    ).toEqual({
      verdict: "unparseable-table",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a well-formed table with a duplicate Slice ID yields ok with the duplicate reported", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n| A | x | Landed |\n| A | y | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: ["A"],
    });
  });

  test("a well-formed table with an empty Slice cell yields ok with emptySliceId true", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n|  | x | Landed |\n| B | y | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: true,
      duplicateSliceIds: [],
    });
  });

  test("a well-formed table with unique, non-empty Slice IDs yields ok clean", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n| A | x | Landed |\n| B | y | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  // Previously asserted a clean pass (duplicateSliceIds: [], emptySliceId:
  // false) -- that WAS the bug this gate's added value exists to catch: a
  // table with no Slice column at all has no way to have a slice ID, so it
  // must fail via missingSliceColumn, not silently read as clean. Confirmed
  // live against the fixed implementation.
  test("a table with no Slice column at all reports missingSliceColumn true, not a clean pass", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Task | Status |\n| --- | --- |\n| A | Landed |\n| B | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: true,
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("three or more rows sharing the same Slice ID report the duplicate once", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n| A | x | Landed |\n| A | y | To Do |\n| A | z | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: ["A"],
    });
  });

  test("two different duplicate pairs both appear in duplicateSliceIds", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n| A | x | Landed |\n| A | y | To Do |\n| B | z | Landed |\n| B | w | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: false,
      duplicateSliceIds: ["A", "B"],
    });
  });

  test("a table with both an empty Slice cell and a duplicate Slice ID reports both", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope | Status |\n| --- | --- | --- |\n|  | x | Landed |\n| A | y | To Do |\n| A | z | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
      missingSliceColumn: false,
      emptySliceId: true,
      duplicateSliceIds: ["A"],
    });
  });
});

// ---------------------------------------------------------------------------
// listPlanFiles
// ---------------------------------------------------------------------------

describe("listPlanFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns file names, filtering out directory entries, with a null error", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      {
        name: "2026-08-20-agent-operator.md",
        isDirectory: () => false,
        isFile: () => true,
      },
      { name: "archive", isDirectory: () => true, isFile: () => false },
      { name: "README.md", isDirectory: () => false, isFile: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(listPlanFiles("/fake/docs/plans")).toEqual({
      files: ["2026-08-20-agent-operator.md", "README.md"],
      error: null,
    });
  });

  test("returns an empty files array and the thrown Error's message when readdirSync throws an Error", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error(
        "ENOENT: no such file or directory, scandir '/fake/docs/plans'",
      );
    });

    expect(listPlanFiles("/fake/docs/plans")).toEqual({
      files: [],
      error: "ENOENT: no such file or directory, scandir '/fake/docs/plans'",
    });
  });

  test("stringifies a non-Error throw from readdirSync as the error", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the `cause instanceof Error ? cause.message : String(cause)` branch
      throw "boom";
    });

    expect(listPlanFiles("/fake/docs/plans")).toEqual({
      files: [],
      error: "boom",
    });
  });
});
