import { describe, expect, test } from "vitest";

// bin/check-landing-plans.mjs guards its scan-and-report logic behind
// `process.argv[1] === fileURLToPath(import.meta.url)`, matching every
// sibling bin/ checker (see bin/tests/check-scaffold-seam.test.ts), so
// importing it would be side-effect-free. But it exports nothing itself —
// its only helper (`listPlanFiles`) is a local, unexported function; all
// its actual logic composes selectDatedPlans/checkLandingPlanDoc from
// bin/lib/landing-plans.mjs, which is what this file exercises directly.
// There is nothing importable from bin/check-landing-plans.mjs worth a
// direct unit test, so no node:fs mock is needed here — every function
// under test is pure.
import {
  DATED_PLAN_RE,
  PLAN_DIR,
  checkLandingPlanDoc,
  findDuplicateSliceIds,
  hasEmptySliceId,
  selectDatedPlans,
} from "../../bin/lib/landing-plans.mjs";

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
  test("null text yields missing-page", () => {
    expect(checkLandingPlanDoc(null)).toEqual({
      verdict: "missing-page",
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("prose with no Landing plan heading yields missing-heading", () => {
    expect(checkLandingPlanDoc("# Some plan\nprose only\n")).toEqual({
      verdict: "missing-heading",
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a numbered list under the heading yields unparseable-table", () => {
    expect(
      checkLandingPlanDoc("## Landing plan\n1. First\n2. Second\n"),
    ).toEqual({
      verdict: "unparseable-table",
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a table with no Status column yields unparseable-table", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Slice | Scope |\n| --- | --- |\n| 1 | x |\n",
      ),
    ).toEqual({
      verdict: "unparseable-table",
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
      emptySliceId: false,
      duplicateSliceIds: [],
    });
  });

  test("a table with no Slice column at all short-circuits both checks regardless of content", () => {
    expect(
      checkLandingPlanDoc(
        "## Landing plan\n| Task | Status |\n| --- | --- |\n| A | Landed |\n| B | To Do |\n",
      ),
    ).toEqual({
      verdict: "ok",
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
      emptySliceId: true,
      duplicateSliceIds: ["A"],
    });
  });
});
