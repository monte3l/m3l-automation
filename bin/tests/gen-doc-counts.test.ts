import { describe, expect, test } from "vitest";
import {
  deriveCounts,
  locateSite,
  buildImplementedListBlock,
  IMPLEMENTED_LIST_BEGIN_MARKER,
  IMPLEMENTED_LIST_END_MARKER,
  TOTAL_COUNT_SITES,
  IMPLEMENTED_COUNT_SITES,
} from "../lib/count-sites.mjs";

// A small fixture status table standing in for docs/implementation-status.md,
// injected via deriveCounts' getStatus dependency so these tests never touch
// the real filesystem.
const FIXTURE_STATUS = {
  errors: "✅",
  events: "✅",
  security: "❌",
  models: "✅",
};

function fixtureCounts() {
  return deriveCounts({
    countCore: () => 3,
    countAws: () => 1,
    getStatus: () => FIXTURE_STATUS,
  });
}

// Mirrors gen-doc-counts.mjs's splice-in-place logic without touching disk,
// so the round-trip is exercised as a pure function of content + counts.
// Hoisted to module scope so both the round-trip describe below and the
// synthetic-bump describe can share it without duplicating the logic.
function applySite(
  content: string,
  site: (typeof TOTAL_COUNT_SITES)[number],
  counts: ReturnType<typeof deriveCounts>,
) {
  const result = locateSite(content, site, counts);
  if (
    !result.found ||
    result.actual === result.expected ||
    result.capturedIndex === undefined ||
    result.capturedText === undefined
  ) {
    return content;
  }
  return (
    content.slice(0, result.capturedIndex) +
    String(result.expected) +
    content.slice(result.capturedIndex + result.capturedText.length)
  );
}

// Keyed by `site.label` (unique per site) rather than sniffing substrings of
// `pattern.source` — with 11 total-count and 8 implemented-count sites now
// sharing overlapping shapes ("modules-N%2FM-", "N of M submodules are"),
// substring guessing stopped being able to tell every site apart. These use
// placeholder zeros/nines rather than any specific target count, so the same
// fixtures work against any injected counts (the fixture round-trip below and
// the synthetic-bump describe further down both reuse them).
const TOTAL_STALE_BY_LABEL: Record<string, string> = {
  "Core barrel comment": "Core namespace barrel (0 submodules surfaced here)",
  "AWS barrel comment": "AWS namespace barrel (0 submodules surfaced here)",
  "total submodule count (ROADMAP.md intro pointer)":
    "library ledger (0/0 submodules, count-enforced)",
  "total submodule count (ROADMAP.md Status snapshot)":
    "count-enforced library ledger (0/0 submodules, shipped at",
  "total submodule count (development status callout)":
    "0 submodules documented",
  "total submodule count (docs/README.md development-status callout)":
    "implemented (0 of 0)",
  "total submodule count (root README.md badge URL)": "modules-99%2F0-red",
  "total submodule count (root README.md prose)":
    "0 of 0 submodules are implemented",
  "total submodule count (npm-facing README.md badge URL)":
    "modules-99%2F0-red",
  "total submodule count (npm-facing README.md prose)":
    "0 of 0 submodules are implemented",
  "total submodule count (implementation-status.md intro prose)":
    "(0 of 0 submodules)",
};

const IMPLEMENTED_STALE_BY_LABEL: Record<string, string> = {
  "root README.md badge URL": "modules-0%2F99-red",
  "root README.md prose callout": "0 of 99 submodules are implemented",
  "npm-facing README.md badge URL": "modules-0%2F99-red",
  "npm-facing README.md prose callout": "0 of 99 submodules are implemented",
  "docs/README.md development-status callout": "implemented (0 of 99)",
  "implementation-status.md intro prose": "(0 of 99 submodules)",
  "ROADMAP.md intro pointer":
    "library ledger (0/99 submodules, count-enforced)",
  "ROADMAP.md Status snapshot":
    "count-enforced library ledger (0/99 submodules, shipped at",
};

// `Record<string, string>` indexing is `string | undefined` under
// noUncheckedIndexedAccess; `expect(...).toBeDefined()` only narrows at
// runtime, not for TypeScript. Throwing gives real narrowing to `string`.
function requireStale(map: Record<string, string>, label: string): string {
  const stale = map[label];
  if (stale === undefined) {
    throw new Error(`no stale fixture for label "${label}"`);
  }
  return stale;
}

describe("deriveCounts", () => {
  test("derives numerator/denominator/name-list from a fixture status table", () => {
    const counts = fixtureCounts();
    expect(counts.coreCount).toBe(3);
    expect(counts.awsCount).toBe(1);
    expect(counts.total).toBe(4);
    expect(counts.implemented).toBe(3);
    expect(counts.implementedNames).toEqual(["errors", "events", "models"]);
  });

  test("total and implemented are always internally consistent with their parts", () => {
    const counts = deriveCounts({
      countCore: () => 5,
      countAws: () => 2,
      getStatus: () => ({ a: "✅", b: "❌", c: "✅", d: "✅" }),
    });
    expect(counts.total).toBe(counts.coreCount + counts.awsCount);
    expect(counts.implemented).toBe(counts.implementedNames.length);
  });
});

describe("buildImplementedListBlock", () => {
  test("renders an Oxford-comma sentence wrapped in its markers", () => {
    const block = buildImplementedListBlock(fixtureCounts());
    expect(block).toContain(IMPLEMENTED_LIST_BEGIN_MARKER);
    expect(block).toContain(IMPLEMENTED_LIST_END_MARKER);
    expect(block).toContain(
      "`errors`, `events`, and `models` are implemented and reviewed (3 of 4 submodules)",
    );
  });

  test("handles a single implemented name without a comma", () => {
    const counts = deriveCounts({
      countCore: () => 1,
      countAws: () => 0,
      getStatus: () => ({ errors: "✅", events: "❌" }),
    });
    const block = buildImplementedListBlock(counts);
    expect(block).toContain(
      "`errors` are implemented and reviewed (1 of 1 submodules)",
    );
  });

  test("handles zero implemented names", () => {
    const counts = deriveCounts({
      countCore: () => 1,
      countAws: () => 0,
      getStatus: () => ({ errors: "❌" }),
    });
    const block = buildImplementedListBlock(counts);
    expect(block).toContain(
      " are implemented and reviewed (0 of 1 submodules)",
    );
  });

  test("shows a denominator different from the numerator (total ≠ implemented)", () => {
    const counts = deriveCounts({
      countCore: () => 2,
      countAws: () => 1,
      getStatus: () => ({ errors: "✅", events: "🧪", models: "❌" }),
    });
    const block = buildImplementedListBlock(counts);
    expect(block).toContain(
      "`errors` are implemented and reviewed (1 of 3 submodules)",
    );
  });
});

describe("locateSite", () => {
  const counts = fixtureCounts();

  test("finds the capture group and compares against the expected value", () => {
    const site = {
      pattern: /modules-(\d+)%2F22/,
      expected: (c: ReturnType<typeof deriveCounts>) => c.implemented,
    };
    const result = locateSite(
      "![badge](https://img.shields.io/badge/modules-2%2F22-red)",
      site,
      counts,
    );
    expect(result.found).toBe(true);
    expect(result.actual).toBe(2);
    expect(result.expected).toBe(3);
    expect(result.capturedText).toBe("2");
  });

  test("reports not found when the pattern doesn't match", () => {
    const site = {
      pattern: /modules-(\d+)%2F22/,
      expected: () => 3,
    };
    expect(locateSite("no badge here", site, counts).found).toBe(false);
  });

  test("computes the absolute offset of the captured digits", () => {
    const site = {
      pattern: /(\d+) of 22 submodules are/,
      expected: (c: ReturnType<typeof deriveCounts>) => c.implemented,
    };
    const content = "prefix text 2 of 22 submodules are implemented";
    const result = locateSite(content, site, counts);
    expect(result.capturedIndex).toBe(content.indexOf("2"));
  });
});

describe("generator + checker round-trip", () => {
  // applySite and the two *_STALE_BY_LABEL maps are hoisted to module scope
  // (above) so the synthetic-bump describe further down can reuse them
  // without duplicating the fixture logic.

  test("a generate-then-check pass agrees for every total-count site", () => {
    const counts = fixtureCounts();
    for (const site of TOTAL_COUNT_SITES) {
      const stale = requireStale(TOTAL_STALE_BY_LABEL, site.label);
      const regenerated = applySite(stale, site, counts);
      const checked = locateSite(regenerated, site, counts);
      expect(checked.actual).toBe(checked.expected);
    }
  });

  test("a generate-then-check pass agrees for every implemented-count site", () => {
    const counts = fixtureCounts();
    for (const site of IMPLEMENTED_COUNT_SITES) {
      const stale = requireStale(IMPLEMENTED_STALE_BY_LABEL, site.label);
      const regenerated = applySite(stale, site, counts);
      const checked = locateSite(regenerated, site, counts);
      expect(checked.actual).toBe(checked.expected);
    }
  });

  test("checker fails on a hand-edited generated block", () => {
    const counts = fixtureCounts();
    const fresh = buildImplementedListBlock(counts);
    const handEdited = fresh.replace("errors", "totally-not-a-real-module");
    expect(handEdited).not.toBe(fresh);

    // byte-comparison, same as check-impl-counts.mjs's extracted-block check
    const start = handEdited.indexOf(IMPLEMENTED_LIST_BEGIN_MARKER);
    const end = handEdited.indexOf(IMPLEMENTED_LIST_END_MARKER);
    const committedBlock = handEdited.slice(
      start,
      end + IMPLEMENTED_LIST_END_MARKER.length,
    );
    expect(committedBlock).not.toBe(buildImplementedListBlock(counts));
  });

  test("checker passes when the block matches a fresh render exactly", () => {
    const counts = fixtureCounts();
    const fresh = buildImplementedListBlock(counts);
    expect(fresh).toBe(buildImplementedListBlock(counts));
  });
});

describe("synthetic count bump — no site hardcodes a stale total", () => {
  // docs/logs/2026-07-13-aws-sqs.md §3: IMPLEMENTED_COUNT_SITES' patterns and
  // buildImplementedListBlock's sentence template used to hardcode the
  // literal 22 as the denominator, which only worked by coincidence while
  // `total` happened to stay exactly 22. The happy-path round-trip above
  // reuses one fixed fixture count end-to-end, so it can't catch that class
  // of bug: a hardcoded literal that matches the fixture's total would still
  // pass. This describe computes deriveCounts twice — a "before" count and an
  // "after" count simulating a newly landed submodule — and asserts every
  // site's regenerated value tracks the SECOND call's counts, not the first.
  const BEFORE_STATUS = {
    alpha: "✅",
    bravo: "✅",
    charlie: "❌",
  };
  // One new name appended, simulating a submodule going from undocumented to
  // implemented between the two deriveCounts calls.
  const AFTER_STATUS = { ...BEFORE_STATUS, delta: "✅" };

  const beforeCounts = deriveCounts({
    countCore: () => 19,
    countAws: () => 6,
    getStatus: () => BEFORE_STATUS,
  });
  const afterCounts = deriveCounts({
    countCore: () => 19,
    countAws: () => 7,
    getStatus: () => AFTER_STATUS,
  });

  test("the fixture itself actually bumps total and implemented", () => {
    expect(beforeCounts.total).toBe(25);
    expect(afterCounts.total).toBe(26);
    expect(beforeCounts.implemented).toBe(2);
    expect(afterCounts.implemented).toBe(3);
    expect(afterCounts.implementedNames).toEqual(["alpha", "bravo", "delta"]);
  });

  test.each(TOTAL_COUNT_SITES)(
    "total-count site $label tracks the bumped total instead of a stale or hardcoded one",
    (site) => {
      const stale = requireStale(TOTAL_STALE_BY_LABEL, site.label);
      // Regenerate once against the "before" counts (as if this were the
      // last commit's generator run), then again against the "after"
      // counts (simulating the next run after a submodule landed).
      const generatedBefore = applySite(stale, site, beforeCounts);
      const generatedAfter = applySite(generatedBefore, site, afterCounts);
      const checked = locateSite(generatedAfter, site, afterCounts);
      expect(checked.actual).toBe(site.expected(afterCounts));
    },
  );

  test.each(IMPLEMENTED_COUNT_SITES)(
    "implemented-count site $label tracks the bumped implemented count instead of a stale or hardcoded one",
    (site) => {
      const stale = requireStale(IMPLEMENTED_STALE_BY_LABEL, site.label);
      const generatedBefore = applySite(stale, site, beforeCounts);
      const generatedAfter = applySite(generatedBefore, site, afterCounts);
      const checked = locateSite(generatedAfter, site, afterCounts);
      expect(checked.actual).toBe(site.expected(afterCounts));
    },
  );

  test("buildImplementedListBlock renders the bumped numerator and denominator, not the stale ones", () => {
    const beforeBlock = buildImplementedListBlock(beforeCounts);
    expect(beforeBlock).toContain(
      "`alpha`, and `bravo` are implemented and reviewed (2 of 25 submodules)",
    );

    const afterBlock = buildImplementedListBlock(afterCounts);
    expect(afterBlock).toContain(
      "`alpha`, `bravo`, and `delta` are implemented and reviewed (3 of 26 submodules)",
    );
    // Guards against a template that hardcodes the BEFORE numbers instead of
    // deriving them from whichever `counts` it's called with.
    expect(afterBlock).not.toContain("(2 of 25 submodules)");
  });
});
