import { describe, expect, test } from "vitest";
import {
  deriveCounts,
  locateSite,
  buildImplementedListBlock,
  beginMarker,
  endMarker,
  locateBlock,
  locateListAssertion,
  IMPLEMENTED_LIST_BEGIN_MARKER,
  IMPLEMENTED_LIST_END_MARKER,
  TOTAL_COUNT_SITES,
  IMPLEMENTED_COUNT_SITES,
  GENERATED_LIST_SITES,
  LIST_ASSERTION_SITES,
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
  "Core barrel comment": "Core namespace barrel (0 documented submodules)",
  "AWS barrel comment": "AWS namespace barrel (0 documented submodules)",
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
  "Core submodule count (implementation-status.md barrels table)":
    "all 0 Core submodules surfaced here",
  "AWS submodule count (implementation-status.md barrels table)":
    "all 0 AWS submodules surfaced here",
  "total submodule count (docs/plans/README.md living-trackers pointer)":
    "library ledger (0/0 submodules, count-enforced)",
  "total submodule count (agent-operating-model.md live-status bullet)":
    "count-enforced 0/0 ledger",
  "total submodule count (root README.md badge alt text)": 'alt="modules: 0/0"',
  "total submodule count (npm-facing README.md badge alt text)":
    'alt="modules: 0/0"',
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
  "docs/plans/README.md living-trackers pointer":
    "library ledger (0/99 submodules, count-enforced)",
  "agent-operating-model.md live-status bullet": "count-enforced 0/99 ledger",
  "root README.md badge alt text": 'alt="modules: 0/99"',
  "npm-facing README.md badge alt text": 'alt="modules: 0/99"',
};

// `TOTAL_COUNT_SITES.find`/`IMPLEMENTED_COUNT_SITES.find` narrowed the same
// way `requireStale` narrows the map lookups above — real-content fixture
// tests below look a site up by its exact label rather than duplicating its
// regex/expected-fn inline, so they stay wired to the real site definition
// (and fail loudly, not silently, if a label is ever renamed).
function requireSite<T extends { label: string }>(
  sites: readonly T[],
  label: string,
): T {
  const site = sites.find((candidate) => candidate.label === label);
  if (site === undefined) {
    throw new Error(`no site registered with label "${label}"`);
  }
  return site;
}

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

  test("is produced via the same beginMarker/endMarker machine as every other generated block", () => {
    const block = buildImplementedListBlock(fixtureCounts());
    expect(block.startsWith(beginMarker("IMPLEMENTED-LIST"))).toBe(true);
    expect(block.endsWith(endMarker("IMPLEMENTED-LIST"))).toBe(true);
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

describe("implementation-status.md barrels-table + living-trackers sites — real current phrasing", () => {
  // Real repo values as of writing (not the synthetic fixtures used above):
  // docs/reference/core/*.md has 21 pages, docs/reference/aws/*.md has 18,
  // and every one of the 39 is marked ✅ implemented. This locks the exact
  // regex against the exact real-world sentence, independent of whether the
  // generic synthetic-bump loop above happens to exercise it — a future
  // accidental rewording of any of these four sentences breaks this test
  // even though it would never touch a fixture string.
  function realCounts() {
    return deriveCounts({
      countCore: () => 21,
      countAws: () => 18,
      getStatus: () =>
        Object.fromEntries(
          Array.from({ length: 39 }, (_, i) => [`module-${i}`, "✅"]),
        ),
    });
  }

  test("Core barrels-table sentence reports no drift against the real Core count", () => {
    const counts = realCounts();
    const site = requireSite(
      TOTAL_COUNT_SITES,
      "Core submodule count (implementation-status.md barrels table)",
    );
    const content =
      "| `src/core/index.ts`                    | ✅     | wired; all 21 Core submodules surfaced here  |";
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(21);
    expect(result.actual).toBe(result.expected);
  });

  test("AWS barrels-table sentence reports no drift against the real AWS count", () => {
    const counts = realCounts();
    const site = requireSite(
      TOTAL_COUNT_SITES,
      "AWS submodule count (implementation-status.md barrels table)",
    );
    const content =
      "| `src/aws/index.ts`                     | ✅     | wired; all 18 AWS submodules surfaced here   |";
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(18);
    expect(result.actual).toBe(result.expected);
  });

  test("docs/plans/README.md living-trackers pointer reports no drift on its total half", () => {
    const counts = realCounts();
    const site = requireSite(
      TOTAL_COUNT_SITES,
      "total submodule count (docs/plans/README.md living-trackers pointer)",
    );
    const content = "  library ledger (39/39 submodules, count-enforced).";
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(39);
    expect(result.actual).toBe(result.expected);
  });

  test("docs/plans/README.md living-trackers pointer reports no drift on its implemented half", () => {
    const counts = realCounts();
    const site = requireSite(
      IMPLEMENTED_COUNT_SITES,
      "docs/plans/README.md living-trackers pointer",
    );
    const content = "  library ledger (39/39 submodules, count-enforced).";
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(39);
    expect(result.actual).toBe(result.expected);
  });

  test("agent-operating-model.md live-status bullet reports no drift on its total half", () => {
    const counts = realCounts();
    const site = requireSite(
      TOTAL_COUNT_SITES,
      "total submodule count (agent-operating-model.md live-status bullet)",
    );
    const content =
      '  count-enforced 39/39 ledger — `pnpm gen:counts` regenerates every "N of M"';
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(39);
    expect(result.actual).toBe(result.expected);
  });

  test("agent-operating-model.md live-status bullet reports no drift on its implemented half", () => {
    const counts = realCounts();
    const site = requireSite(
      IMPLEMENTED_COUNT_SITES,
      "agent-operating-model.md live-status bullet",
    );
    const content =
      '  count-enforced 39/39 ledger — `pnpm gen:counts` regenerates every "N of M"';
    const result = locateSite(content, site, counts);
    expect(result.found).toBe(true);
    expect(result.actual).toBe(39);
    expect(result.actual).toBe(result.expected);
  });

  test("the Core/AWS barrels-table entries are total-only, with no numerator sibling", () => {
    // Unlike the "N of M" pairs (e.g. the living-trackers pointer above),
    // these two prose sentences carry a single number each — there is
    // deliberately no IMPLEMENTED_COUNT_SITES entry for either label, since
    // "N documented submodules" has no separate implemented/total halves to
    // track independently (same shape as the pre-existing CLAUDE.md barrel
    // comments). This guards against the generic synthetic-bump loop's
    // TOTAL_COUNT_SITES/IMPLEMENTED_COUNT_SITES pairing ever being assumed to
    // be 1:1.
    const totalLabels = TOTAL_COUNT_SITES.map((site) => site.label);
    const implementedLabels = IMPLEMENTED_COUNT_SITES.map((site) => site.label);
    expect(totalLabels).toContain(
      "Core submodule count (implementation-status.md barrels table)",
    );
    expect(totalLabels).toContain(
      "AWS submodule count (implementation-status.md barrels table)",
    );
    expect(implementedLabels).not.toContain(
      "Core submodule count (implementation-status.md barrels table)",
    );
    expect(implementedLabels).not.toContain(
      "AWS submodule count (implementation-status.md barrels table)",
    );
  });
});

describe("deriveCounts — name fields (coreNames/awsNames/qualifiedImplementedNames)", () => {
  test("qualifies an AWS-only implemented name, leaves a Core name and an unlisted name bare", () => {
    const counts = deriveCounts({
      countCore: () => 2,
      countAws: () => 2,
      listCoreNames: () => ["errors", "events"],
      listAwsNames: () => ["sqs", "s3"],
      getStatus: () => ({
        errors: "✅", // present in coreNames -> stays bare
        sqs: "✅", // present only in awsNames -> qualified "aws/sqs"
        orphan: "✅", // present in neither list -> stays bare
        events: "❌",
      }),
    });
    expect(counts.coreNames).toEqual(["errors", "events"]);
    expect(counts.awsNames).toEqual(["sqs", "s3"]);
    expect(counts.implementedNames).toEqual(["errors", "sqs", "orphan"]);
    expect(counts.qualifiedImplementedNames).toEqual([
      "errors",
      "aws/sqs",
      "orphan",
    ]);
  });

  test("a name present in both coreNames and awsNames stays bare — Core wins the hypothetical collision", () => {
    const counts = deriveCounts({
      countCore: () => 1,
      countAws: () => 1,
      listCoreNames: () => ["shared"],
      listAwsNames: () => ["shared"],
      getStatus: () => ({ shared: "✅" }),
    });
    expect(counts.qualifiedImplementedNames).toEqual(["shared"]);
  });
});

describe("beginMarker / endMarker / locateBlock", () => {
  test("beginMarker/endMarker produce the expected HTML-comment text", () => {
    expect(beginMarker("SUBMODULE-LIST")).toBe(
      "<!-- BEGIN GENERATED SUBMODULE-LIST -->",
    );
    expect(endMarker("SUBMODULE-LIST")).toBe(
      "<!-- END GENERATED SUBMODULE-LIST -->",
    );
  });

  test("locateBlock spans from the BEGIN marker's start through the END marker's end, inclusive of both", () => {
    const content =
      "prefix\n<!-- BEGIN GENERATED SUBMODULE-LIST -->\nbody\n<!-- END GENERATED SUBMODULE-LIST -->\nsuffix";
    const loc = locateBlock(content, "SUBMODULE-LIST");
    expect(loc).not.toBeNull();
    if (loc === null) throw new Error("expected a location");
    expect(content.slice(loc.start, loc.end)).toBe(
      "<!-- BEGIN GENERATED SUBMODULE-LIST -->\nbody\n<!-- END GENERATED SUBMODULE-LIST -->",
    );
  });

  test.each([
    [
      "the BEGIN marker is missing",
      "no begin here\n<!-- END GENERATED SUBMODULE-LIST -->",
    ],
    [
      "the END marker is missing",
      "<!-- BEGIN GENERATED SUBMODULE-LIST -->\nno end here",
    ],
    ["both markers are missing", "nothing here at all"],
  ])("returns null when %s", (_label, content) => {
    expect(locateBlock(content, "SUBMODULE-LIST")).toBeNull();
  });
});

// A qualifiedImplementedNames-aware sibling to fixtureCounts() — the plain
// fixture above never overrides listCoreNames/listAwsNames, so reading
// .coreNames/.awsNames/.qualifiedImplementedNames off it would silently fall
// through to a real filesystem read (docs/reference/{core,aws}), which is
// exactly what these tests must stay isolated from.
function fixtureCountsQualified() {
  return deriveCounts({
    countCore: () => 3,
    countAws: () => 1,
    listCoreNames: () => ["errors", "events", "security"],
    listAwsNames: () => ["models"],
    getStatus: () => FIXTURE_STATUS,
  });
}

// Mirrors applySite (above) but for a marker-delimited block rather than a
// single numeric capture — the block-splice counterpart gen-doc-counts.mjs's
// GENERATED_LIST_SITES loop performs.
function applyBlockSite(
  content: string,
  site: (typeof GENERATED_LIST_SITES)[number],
  counts: ReturnType<typeof deriveCounts>,
) {
  const loc = locateBlock(content, site.marker);
  if (loc === null) return content;
  return (
    content.slice(0, loc.start) + site.render(counts) + content.slice(loc.end)
  );
}

describe("GENERATED_LIST_SITES — generator + checker round-trip", () => {
  test.each(GENERATED_LIST_SITES)(
    "$label: a generate-then-check pass agrees",
    (site) => {
      const counts = fixtureCountsQualified();
      const stale = `prefix\n${beginMarker(site.marker)}\nstale placeholder content\n${endMarker(site.marker)}\nsuffix`;
      const regenerated = applyBlockSite(stale, site, counts);
      const loc = locateBlock(regenerated, site.marker);
      expect(loc).not.toBeNull();
      if (loc === null) throw new Error("expected a location");
      const committedBlock = regenerated.slice(loc.start, loc.end);
      expect(committedBlock).toBe(site.render(counts));
    },
  );

  test.each(GENERATED_LIST_SITES)(
    "$label: checker fails on a hand-edited generated block",
    (site) => {
      const counts = fixtureCountsQualified();
      const fresh = site.render(counts);
      const handEdited = fresh.replace("errors", "totally-not-a-real-module");
      expect(handEdited).not.toBe(fresh);

      // byte-comparison, same as check-impl-counts.mjs's extracted-block check
      const loc = locateBlock(handEdited, site.marker);
      expect(loc).not.toBeNull();
      if (loc === null) throw new Error("expected a location");
      const committedBlock = handEdited.slice(loc.start, loc.end);
      expect(committedBlock).not.toBe(site.render(counts));
    },
  );
});

describe("GENERATED_LIST_SITES — synthetic bump tracks a newly landed name", () => {
  // Same shape as the numeric synthetic-bump describe above: two independent
  // deriveCounts() calls simulate a submodule going from undocumented to
  // implemented between generator runs, so a renderer that hardcodes the
  // BEFORE name list (instead of deriving it fresh from `counts`) is caught.
  const BEFORE_STATUS = { alpha: "✅", bravo: "✅", charlie: "❌" };
  const AFTER_STATUS = { ...BEFORE_STATUS, delta: "✅" };

  const beforeCounts = deriveCounts({
    countCore: () => 19,
    countAws: () => 6,
    listCoreNames: () => ["alpha", "bravo", "charlie"],
    listAwsNames: () => [],
    getStatus: () => BEFORE_STATUS,
  });
  const afterCounts = deriveCounts({
    countCore: () => 19,
    countAws: () => 6,
    listCoreNames: () => ["alpha", "bravo", "charlie", "delta"],
    listAwsNames: () => [],
    getStatus: () => AFTER_STATUS,
  });

  test.each(GENERATED_LIST_SITES)(
    "$label output changes to include the newly landed name, not just alpha/bravo",
    (site) => {
      const beforeBlock = site.render(beforeCounts);
      const afterBlock = site.render(afterCounts);
      expect(beforeBlock).not.toContain("delta");
      expect(afterBlock).toContain("delta");
      expect(afterBlock).toContain("alpha");
      expect(afterBlock).toContain("bravo");
    },
  );

  test("qualifiedImplementedNames itself tracks the bump, independent of the underlying implementedNames", () => {
    expect(beforeCounts.qualifiedImplementedNames).toEqual(["alpha", "bravo"]);
    expect(afterCounts.qualifiedImplementedNames).toEqual([
      "alpha",
      "bravo",
      "delta",
    ]);
  });
});

describe("locateListAssertion + LIST_ASSERTION_SITES", () => {
  const CORE_SITE = requireSite(
    LIST_ASSERTION_SITES,
    "Core barrel TSDoc submodule list",
  );
  const AWS_SITE = requireSite(
    LIST_ASSERTION_SITES,
    "AWS barrel TSDoc submodule list",
  );

  // Based on the real TSDoc header comments in
  // packages/m3l-common/src/{core,aws}/index.ts as of writing — a rewording of
  // either anchor phrase ("here as they are implemented:" / "here as they are
  // implemented, in dependency order:") breaks these fixtures even though
  // they never touch the real files.
  const CORE_FIXTURE = [
    " * Public submodules (documented under `docs/reference/core/`) are re-exported",
    " * here as they are implemented: `script`, `checkpoint`, `config`,",
    " * `diagnostics`, `environment`, `errors`, `events`, `logging`, `prompt`,",
    " * `importers`, `exporters`, `files`, `json`, `text`, `storage`, `utils`,",
    " * `network`, `polling`, `analysis`, `messaging`, `security`.",
  ].join("\n");

  const AWS_FIXTURE = [
    " * Public submodules (documented under `docs/reference/aws/`) are re-exported",
    " * here as they are implemented, in dependency order: `models`, `credentials`,",
    " * `clients`, `dynamodb`, `cloudwatch-logs-insights`, `sqs`, `signing`, `s3`,",
    " * `athena`, `eventbridge`, `lambda`, `ecs`, `cloudformation`, `codepipeline`,",
    " * `eks`, `cloudwatch-alarms`, `cloudwatch-metrics`, `secrets-manager`.",
  ].join("\n");

  test("Core barrel fixture: extracts the real submodule name list in source order", () => {
    const result = locateListAssertion(CORE_FIXTURE, CORE_SITE);
    expect(result.found).toBe(true);
    expect(result.actualNames).toEqual([
      "script",
      "checkpoint",
      "config",
      "diagnostics",
      "environment",
      "errors",
      "events",
      "logging",
      "prompt",
      "importers",
      "exporters",
      "files",
      "json",
      "text",
      "storage",
      "utils",
      "network",
      "polling",
      "analysis",
      "messaging",
      "security",
    ]);
  });

  test("AWS barrel fixture: extracts the real submodule name list in dependency order", () => {
    const result = locateListAssertion(AWS_FIXTURE, AWS_SITE);
    expect(result.found).toBe(true);
    expect(result.actualNames).toEqual([
      "models",
      "credentials",
      "clients",
      "dynamodb",
      "cloudwatch-logs-insights",
      "sqs",
      "signing",
      "s3",
      "athena",
      "eventbridge",
      "lambda",
      "ecs",
      "cloudformation",
      "codepipeline",
      "eks",
      "cloudwatch-alarms",
      "cloudwatch-metrics",
      "secrets-manager",
    ]);
  });

  test.each(LIST_ASSERTION_SITES)(
    "$label reports not-found when the anchor phrase is absent",
    (site) => {
      const result = locateListAssertion(
        "no anchor phrase appears anywhere in this string.",
        site,
      );
      expect(result.found).toBe(false);
    },
  );

  test("extraction is a strict span-scan, not pre-filtered against expectedNames — diffing is the caller's job", () => {
    const counts = deriveCounts({
      countCore: () => 1,
      countAws: () => 0,
      listCoreNames: () => ["script"],
      listAwsNames: () => [],
      getStatus: () => ({ script: "✅" }),
    });
    const fixtureWithExtraName = [
      " * here as they are implemented: `script`, `totally-unexpected-name`.",
    ].join("\n");
    const result = locateListAssertion(fixtureWithExtraName, CORE_SITE);
    expect(result.found).toBe(true);
    expect(result.actualNames).toContain("totally-unexpected-name");
    expect(CORE_SITE.expectedNames(counts)).not.toContain(
      "totally-unexpected-name",
    );
  });
});
