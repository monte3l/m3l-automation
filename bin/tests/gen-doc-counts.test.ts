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
  // Mirrors gen-doc-counts.mjs's splice-in-place logic without touching disk,
  // so the round-trip is exercised as a pure function of content + counts.
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
  // `pattern.source` — with 8 total-count and 6 implemented-count sites now
  // sharing overlapping shapes ("modules-N%2FM-", "N of M submodules are"),
  // substring guessing stopped being able to tell every site apart.
  const TOTAL_STALE_BY_LABEL: Record<string, string> = {
    "Core barrel comment": "Core namespace barrel (0 submodules surfaced here)",
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
  };

  test("a generate-then-check pass agrees for every total-count site", () => {
    const counts = fixtureCounts();
    for (const site of TOTAL_COUNT_SITES) {
      const stale = TOTAL_STALE_BY_LABEL[site.label];
      expect(stale, `no stale fixture for label "${site.label}"`).toBeDefined();
      const regenerated = applySite(stale, site, counts);
      const checked = locateSite(regenerated, site, counts);
      expect(checked.actual).toBe(checked.expected);
    }
  });

  test("a generate-then-check pass agrees for every implemented-count site", () => {
    const counts = fixtureCounts();
    for (const site of IMPLEMENTED_COUNT_SITES) {
      const stale = IMPLEMENTED_STALE_BY_LABEL[site.label];
      expect(stale, `no stale fixture for label "${site.label}"`).toBeDefined();
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
