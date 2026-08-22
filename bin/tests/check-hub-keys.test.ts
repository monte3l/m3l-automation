import { describe, expect, test } from "vitest";
import {
  findImplementationSectionMismatches,
  findKeyCollisions,
  findMissingTypes,
  findPriorityVocabularyMismatches,
} from "../check-hub-keys.mjs";
import {
  IMPLEMENTATION_ANCHORS,
  IMPLEMENTATION_NAMESPACES,
  ISSUE_TYPES,
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  PROJECT_PRIORITY_OPTIONS,
  ROADMAP_ANCHORS,
  TYPE_BY_IMPLEMENTATION_SECTION,
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
      projectPriorityOptions: { p0: "0-now", p1: "1-next" },
    });
    expect(findings).toEqual([]);
  });

  test("a priorityLabels key missing from milestoneTitles is reported with its key and value", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: { p2: "priority:2-later" },
      milestoneTitles: {},
      roadmapAnchors: {},
      projectPriorityOptions: { p2: "2-later" },
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
      projectPriorityOptions: {},
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
        major: "Breaking",
      },
      roadmapAnchors: {},
      projectPriorityOptions: { p0: "0-now" },
    });
    expect(findings).toEqual([]);
  });

  test("a priorityLabels entry that spells its tier differently from projectPriorityOptions is reported", () => {
    // "priority:0-now" vs board option "0-later" — same key ("p0"), two
    // different spellings of the tier.
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: { p0: "priority:0-now" },
      milestoneTitles: { p0: "Now — unblock first" },
      roadmapAnchors: {},
      projectPriorityOptions: { p0: "0-later" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("PRIORITY_LABELS.p0");
    expect(findings[0]).toContain("priority:0-now");
    expect(findings[0]).toContain("PROJECT_PRIORITY_OPTIONS.p0");
    expect(findings[0]).toContain("0-later");
  });

  test("a projectPriorityOptions entry that is null (governance) is NOT reported, even though it has no priority: label counterpart", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: {},
      milestoneTitles: {},
      roadmapAnchors: {},
      projectPriorityOptions: { governance: null },
    });
    expect(findings).toEqual([]);
  });

  // Regression lock: passing the REAL current tables through must stay []
  // so a future partial ADR-0051/ADR-0052-style rename (one table updated,
  // another left stale) fails this test instead of only surfacing at `gh`
  // call time.
  test("the real PRIORITY_LABELS/MILESTONE_TITLES/ROADMAP_ANCHORS/PROJECT_PRIORITY_OPTIONS tables from hub-sync.mjs agree", () => {
    const findings = findPriorityVocabularyMismatches({
      priorityLabels: PRIORITY_LABELS,
      milestoneTitles: MILESTONE_TITLES,
      roadmapAnchors: ROADMAP_ANCHORS,
      projectPriorityOptions: PROJECT_PRIORITY_OPTIONS,
    });
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findMissingTypes
// ---------------------------------------------------------------------------

describe("findMissingTypes", () => {
  test("returns [] when every item carries a valid ISSUE_TYPES value", () => {
    const findings = findMissingTypes([
      {
        key: "roadmap:p0:x",
        title: "X",
        type: ISSUE_TYPES.libraryCapability,
      },
      { key: "impl:friction:f7", title: "F7", type: ISSUE_TYPES.friction },
    ]);
    expect(findings).toEqual([]);
  });

  test("an item with type: undefined is reported", () => {
    const findings = findMissingTypes([
      { key: "roadmap:p0:x", title: "X", type: undefined },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("roadmap:p0:x");
    expect(findings[0]).toContain("X");
    expect(findings[0]).toContain("Issue Type");
  });

  test("an item with an off-vocabulary type string is reported", () => {
    const findings = findMissingTypes([
      { key: "roadmap:p0:x", title: "X", type: "Bug" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("roadmap:p0:x");
  });

  test("an item with no type property at all is reported the same as an undefined one", () => {
    const findings = findMissingTypes([{ key: "roadmap:p0:x", title: "X" }]);
    expect(findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findImplementationSectionMismatches
// ---------------------------------------------------------------------------

describe("findImplementationSectionMismatches", () => {
  test("returns [] when all three tables carry identical keys", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction", adr0035Rollout: "#adr0035" },
      { friction: "friction", adr0035Rollout: "adr0035" },
      {
        friction: ISSUE_TYPES.friction,
        adr0035Rollout: ISSUE_TYPES.libraryCapability,
      },
      [],
    );
    expect(findings).toEqual([]);
  });

  test("a key missing from IMPLEMENTATION_ANCHORS only is reported, naming the section key and that table", () => {
    const findings = findImplementationSectionMismatches(
      {},
      { friction: "friction" },
      { friction: ISSUE_TYPES.friction },
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"friction"');
    expect(findings[0]).toContain("IMPLEMENTATION_ANCHORS");
  });

  test("a key missing from IMPLEMENTATION_NAMESPACES only is reported, naming the section key and that table", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction" },
      {},
      { friction: ISSUE_TYPES.friction },
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"friction"');
    expect(findings[0]).toContain("IMPLEMENTATION_NAMESPACES");
  });

  test("a key missing from TYPE_BY_IMPLEMENTATION_SECTION only is reported, naming the section key and that table", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction" },
      { friction: "friction" },
      {},
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"friction"');
    expect(findings[0]).toContain("TYPE_BY_IMPLEMENTATION_SECTION");
  });

  test("a key missing from two tables produces two findings, one per missing table (not one collapsed finding)", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction" },
      {},
      {},
      [],
    );
    expect(findings).toHaveLength(2);
    expect(
      findings.some((finding) => finding.includes("IMPLEMENTATION_NAMESPACES")),
    ).toBe(true);
    expect(
      findings.some((finding) =>
        finding.includes("TYPE_BY_IMPLEMENTATION_SECTION"),
      ),
    ).toBe(true);
  });

  // getterReality is a reference table (one row per AWS provider getter),
  // registered as a tracker heading so check:tracker-coverage accepts its
  // Status column, but it is never converted into backlog items — so it
  // needs no anchor, namespace or default type. sectionsWithoutItems is what
  // tells this function that absence is intentional rather than drift. This
  // test exercises the exemption where it actually has teeth: the key IS
  // present in one table (as it is in real life it could be, if a stray
  // entry were ever added) yet still produces no finding once exempted.
  test("sectionsWithoutItems suppresses a finding even when the exempt key is present in some (but not all) tables", () => {
    const findings = findImplementationSectionMismatches(
      { getterReality: "#getter-reality" },
      {},
      {},
      ["getterReality"],
    );
    expect(findings).toEqual([]);
  });

  test("sectionsWithoutItems exempts a key present in none of the three tables (getterReality's actual case)", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction" },
      { friction: "friction" },
      { friction: ISSUE_TYPES.friction },
      ["getterReality"],
    );
    expect(findings).toEqual([]);
  });

  test("the exemption only suppresses the exempt key — a different, genuinely drifted key still reports", () => {
    const findings = findImplementationSectionMismatches(
      { friction: "#friction" },
      {},
      {},
      ["getterReality"],
    );
    expect(findings).toHaveLength(2);
  });

  test("returns [] when all three tables are empty (no keys, no findings)", () => {
    expect(findImplementationSectionMismatches({}, {}, {}, [])).toEqual([]);
  });

  test("defaults sectionsWithoutItems to [] when the fourth argument is omitted", () => {
    const findings = findImplementationSectionMismatches(
      {},
      { friction: "friction" },
      {},
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  // Regression lock: the real tables in bin/lib/hub-sync.mjs must stay keyed
  // identically. The synthetic cases above prove the function's own logic;
  // this one proves the tables it actually guards are in sync — ADR-0073
  // added three entries to each by hand, which is exactly the kind of
  // hand-edit this function exists to catch if it goes wrong next time.
  test("the real IMPLEMENTATION_ANCHORS/IMPLEMENTATION_NAMESPACES/TYPE_BY_IMPLEMENTATION_SECTION tables from hub-sync.mjs are keyed identically", () => {
    const findings = findImplementationSectionMismatches(
      IMPLEMENTATION_ANCHORS,
      IMPLEMENTATION_NAMESPACES,
      TYPE_BY_IMPLEMENTATION_SECTION,
      ["getterReality"],
    );
    expect(findings).toEqual([]);
  });
});
