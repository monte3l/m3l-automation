import { describe, expect, test } from "vitest";
import {
  findKeyCollisions,
  findPriorityVocabularyMismatches,
} from "../check-hub-keys.mjs";
import {
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  ROADMAP_ANCHORS,
} from "../lib/hub-sync.mjs";

// ---------------------------------------------------------------------------
// Fixtures — minimal Item-shaped objects covering each collision kind.
// Tests never call actionableItems; they build inputs directly so the unit
// being tested is findKeyCollisions's own logic, not the whole pipeline.
// ---------------------------------------------------------------------------

interface MinimalItem {
  key: string;
  title: string;
  legacyKeys?: string[];
}

function makeResult(
  items: MinimalItem[],
  duplicateKeys: { key: string; first: string; second: string }[] = [],
) {
  return { items, duplicateKeys };
}

// ---------------------------------------------------------------------------
// findKeyCollisions
// ---------------------------------------------------------------------------

describe("findKeyCollisions", () => {
  test("returns [] when all keys are unique, case-insensitively, and no aliases shadow anything", () => {
    const result = makeResult([
      { key: "impl:friction:f7", title: "F7" },
      { key: "impl:friction:f9", title: "F9", legacyKeys: ["impl:F9"] },
      { key: "roadmap:p0:foo", title: "Foo" },
    ]);
    expect(findKeyCollisions(result)).toEqual([]);
  });

  test("detects a duplicate kind from duplicateKeys (two rows derived the same key)", () => {
    const result = makeResult(
      // After addItem merges the duplicate, items only contains one entry;
      // the collision is recorded in duplicateKeys.
      [{ key: "impl:friction:f7", title: "F7 — First title" }],
      [
        {
          key: "impl:friction:f7",
          first: "F7 — First title",
          second: "F7 — Second title",
        },
      ],
    );
    const findings = findKeyCollisions(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("duplicate");
    expect(findings[0]?.key).toBe("impl:friction:f7");
    expect(findings[0]?.message).toContain("F7 — First title");
    expect(findings[0]?.message).toContain("F7 — Second title");
  });

  test("detects a case-variant kind (two items whose keys differ only by case)", () => {
    // impl:A2 and impl:a2 were the exact near-collision the namespace fix
    // addressed — two items in different sections that happened to share a
    // label. The same pairing can still arise if two items in the SAME
    // namespace land on a mixed-case vs lowercase form.
    const result = makeResult([
      { key: "impl:adr0035:A2", title: "A2 rollout" },
      { key: "impl:adr0035:a2", title: "A2 rollout duplicate" },
    ]);
    const findings = findKeyCollisions(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("case-variant");
    // The key is reported as the lowercased common form.
    expect(findings[0]?.key).toBe("impl:adr0035:a2");
    expect(findings[0]?.message).toContain("impl:adr0035:A2");
    expect(findings[0]?.message).toContain("impl:adr0035:a2");
  });

  test("detects a legacy-shadow kind (an alias that matches another item's current key)", () => {
    // itemA claims "impl:old" as a legacy alias, but itemB's CURRENT key is
    // that same string — the alias is inert and any issue still carrying
    // "impl:old" will resolve to itemB, not itemA.
    const result = makeResult([
      { key: "impl:friction:f7", title: "F7", legacyKeys: ["impl:old"] },
      { key: "impl:old", title: "Old item" },
    ]);
    const findings = findKeyCollisions(result);
    expect(findings.some((f) => f.kind === "legacy-shadow")).toBe(true);
    const shadow = findings.find((f) => f.kind === "legacy-shadow");
    expect(shadow?.key).toBe("impl:old");
    expect(shadow?.message).toContain("F7");
    expect(shadow?.message).toContain("Old item");
  });

  test("an item's OWN legacy key never counts as shadowing itself", () => {
    // "impl:F7" is a legacy alias for impl:friction:f7. indexItemsByKey skips
    // the alias because the current key wins. findKeyCollisions must apply the
    // same rule: shadowed === item → skip, not a finding.
    const result = makeResult([
      { key: "impl:friction:f7", title: "F7", legacyKeys: ["impl:F7"] },
    ]);
    expect(findKeyCollisions(result)).toEqual([]);
  });

  test("a missing duplicateKeys property is treated as empty (backward compat)", () => {
    // Callers that destructure { items, warnings } (not duplicateKeys) from
    // actionableItems pass no duplicateKeys to findKeyCollisions.
    const result = { items: [{ key: "roadmap:p0:x", title: "X" }] };
    expect(findKeyCollisions(result as ReturnType<typeof makeResult>)).toEqual(
      [],
    );
  });

  test("reports all three kinds in one pass when all three collisions are present", () => {
    const result = makeResult(
      [
        // case-variant: impl:adr0035:A2 vs impl:adr0035:a2 (same lowercase)
        {
          key: "impl:adr0035:A2",
          title: "A2 rollout",
          legacyKeys: ["impl:old-shadow"],
        },
        { key: "impl:adr0035:a2", title: "a2 procedure" },
        // legacy-shadow: impl:old-shadow is also a current key of the item below
        { key: "impl:old-shadow", title: "Old shadow item" },
      ],
      // duplicate: two rows derived the same key
      [{ key: "impl:friction:f7", first: "First", second: "Second" }],
    );
    const findings = findKeyCollisions(result);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("duplicate");
    expect(kinds).toContain("case-variant");
    expect(kinds).toContain("legacy-shadow");
  });
});

// ---------------------------------------------------------------------------
// findPriorityVocabularyMismatches
// ---------------------------------------------------------------------------

describe("findPriorityVocabularyMismatches", () => {
  test("returns [] when every priorityLabels/roadmapAnchors key has a milestoneTitles entry", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: { p0: "priority:0-now", p1: "priority:1-next" },
      milestoneTitles: {
        p0: "Now — unblock first",
        p1: "Next — consumer fleet",
      },
      roadmapAnchors: { p0: "#priority-0" },
    });
    expect(findings).toEqual([]);
  });

  test("a priorityLabels key missing from milestoneTitles is reported with its key and value", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: { p2: "priority:2-later" },
      milestoneTitles: {},
      roadmapAnchors: {},
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("PRIORITY_LABELS.p2");
    expect(findings[0]).toContain("priority:2-later");
    expect(findings[0]).toContain("MILESTONE_TITLES.p2");
  });

  test("a roadmapAnchors key missing from milestoneTitles is reported with its key and value", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: {},
      milestoneTitles: {},
      roadmapAnchors: { governance: "#governance-follow-ups" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("ROADMAP_ANCHORS.governance");
    expect(findings[0]).toContain("#governance-follow-ups");
    expect(findings[0]).toContain("MILESTONE_TITLES.governance");
  });

  test("an extra milestoneTitles key with no priorityLabels/roadmapAnchors counterpart is NOT reported (not blanket set equality)", () => {
    // MILESTONE_TITLES legitimately carries a "major" bucket that neither
    // PRIORITY_LABELS nor ROADMAP_ANCHORS ever mirrors — asserting this stays
    // silent locks in that findPriorityVocabularyMismatches only walks
    // priorityLabels/roadmapAnchors -> milestoneTitles, never the reverse.
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: { p0: "priority:0-now" },
      milestoneTitles: {
        p0: "Now — unblock first",
        major: "2.0 / breaking",
      },
      roadmapAnchors: {},
    });
    expect(findings).toEqual([]);
  });

  // Regression lock: passing the REAL current tables through must stay []
  // so a future partial ADR-0051-style rename (one table updated, another
  // left stale) fails this test instead of only surfacing at `gh` call time.
  test("the real PRIORITY_LABELS/MILESTONE_TITLES/ROADMAP_ANCHORS tables from hub-sync.mjs agree", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: PRIORITY_LABELS,
      milestoneTitles: MILESTONE_TITLES,
      roadmapAnchors: ROADMAP_ANCHORS,
    });
    expect(findings).toEqual([]);
  });
});
