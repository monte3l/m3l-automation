import { describe, expect, test } from "vitest";
import {
  ISSUE_TYPE_COLORS,
  ISSUE_TYPES,
  TYPE_LABELS,
} from "../lib/hub-sync.mjs";
import {
  LABEL_DEFS,
  LABEL_DESCRIPTION_MAX_LENGTH,
} from "../lib/label-defs.mjs";
import { ISSUE_TYPE_DEFS } from "../lib/issue-type-defs.mjs";

describe("ISSUE_TYPE_DEFS", () => {
  const EXPECTED_NAMES = [
    "Library capability",
    "CLI capability",
    "Package capability",
    "UI",
    "Infrastructure",
    "Fleet retrofit",
    "Tooling & gates",
    "Consumer script",
    "Friction",
    "Governance",
  ];

  test("declares exactly the ten ISSUE_TYPES-backed kinds, in ISSUE_TYPES declaration order", () => {
    expect(ISSUE_TYPE_DEFS.map((def) => def.name)).toEqual(EXPECTED_NAMES);
  });

  test("every ISSUE_TYPES key has exactly one ISSUE_TYPE_DEFS entry, and its name matches (the module-load exhaustiveness assertion held)", () => {
    // The real module-load loops in bin/lib/hub-sync.mjs and
    // bin/lib/issue-type-defs.mjs already throw if ISSUE_TYPES and
    // TYPE_KINDS disagree on keys, or if a def's color/description is bad —
    // this file's static import above already proved that for the live
    // tables. There is no seam to inject a bad table through this module
    // (ISSUE_TYPE_DEFS is derived data with no exported factory), so this
    // test re-derives the same coverage the module-load assertions enforce,
    // naming the invariant explicitly instead of leaving it implicit in
    // "the import didn't throw".
    const defsByKey = new Map(ISSUE_TYPE_DEFS.map((def) => [def.key, def]));
    for (const key of Object.keys(ISSUE_TYPES)) {
      const def = defsByKey.get(key);
      expect(def).toBeDefined();
      expect(def?.name).toBe(ISSUE_TYPES[key as keyof typeof ISSUE_TYPES]);
    }
  });

  test("has no def for a key ISSUE_TYPES does not declare (both directions of the exhaustiveness assertion)", () => {
    const defKeys = new Set(ISSUE_TYPE_DEFS.map((def) => def.key));
    expect(defKeys.size).toBe(Object.keys(ISSUE_TYPES).length);
    for (const key of defKeys) {
      expect(Object.keys(ISSUE_TYPES)).toContain(key);
    }
  });

  test("has no duplicate names — an Issue Type name is the handle `gh issue edit --type` uses, so it must be unique", () => {
    const names = ISSUE_TYPE_DEFS.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every color is one of GitHub's IssueTypeColor enum values (the module-load color assertion held)", () => {
    for (const def of ISSUE_TYPE_DEFS) {
      expect(ISSUE_TYPE_COLORS).toContain(def.color);
    }
  });

  test("every description is non-empty (the module-load empty-description assertion held)", () => {
    for (const def of ISSUE_TYPE_DEFS) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  test("every description fits within LABEL_DESCRIPTION_MAX_LENGTH — the description is shared with the type:* LABEL_DEFS entry, so a description over the label cap would break gh label create on the label side too", () => {
    for (const def of ISSUE_TYPE_DEFS) {
      expect(def.description.length).toBeLessThanOrEqual(
        LABEL_DESCRIPTION_MAX_LENGTH,
      );
    }
  });

  describe("type-label description parity", () => {
    test.each(Object.keys(ISSUE_TYPES) as (keyof typeof ISSUE_TYPES)[])(
      "%s's Issue Type description matches its type:* LABEL_DEFS entry (one shared description, not two independently-drifting copies)",
      (key) => {
        const typeDef = ISSUE_TYPE_DEFS.find((def) => def.key === key);
        expect(typeDef).toBeDefined();

        // Look the label up by its known name (derived from ISSUE_TYPES via
        // TYPE_LABELS), not by matching description text — matching by
        // description would make the parity assertion circular.
        const labelName = TYPE_LABELS[ISSUE_TYPES[key]];
        const labelDef = LABEL_DEFS.find((def) => def.name === labelName);
        expect(labelDef).toBeDefined();

        expect(labelDef?.description).toBe(typeDef?.description);
      },
    );
  });
});

describe("ISSUE_TYPE_COLORS", () => {
  test("is exactly GitHub's eight IssueTypeColor enum values", () => {
    expect(ISSUE_TYPE_COLORS).toEqual([
      "GRAY",
      "BLUE",
      "GREEN",
      "YELLOW",
      "ORANGE",
      "RED",
      "PINK",
      "PURPLE",
    ]);
  });

  test("is frozen — a mutation here would silently change what every def's load-time color check accepts", () => {
    expect(Object.isFrozen(ISSUE_TYPE_COLORS)).toBe(true);
  });
});
