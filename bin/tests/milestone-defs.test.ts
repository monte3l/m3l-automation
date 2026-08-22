import { describe, expect, test } from "vitest";
import {
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  PRIORITY_TIERS,
} from "../lib/hub-sync.mjs";
import {
  LABEL_DEFS,
  LABEL_DESCRIPTION_MAX_LENGTH,
} from "../lib/label-defs.mjs";
import { MILESTONE_DEFS } from "../lib/milestone-defs.mjs";

describe("MILESTONE_DEFS", () => {
  const EXPECTED_KEYS = ["p0", "p1", "p2", "p3", "governance", "major"];

  test("declares exactly the six MILESTONE_TITLES-backed milestones, in MILESTONE_TITLES declaration order", () => {
    expect(MILESTONE_DEFS.map((def) => def.key)).toEqual(EXPECTED_KEYS);
  });

  test("every MILESTONE_TITLES key has exactly one MILESTONE_DEFS entry, and its title matches (the module-load exhaustiveness assertion held)", () => {
    // The real module-load `for` loop in bin/lib/milestone-defs.mjs throws if
    // any MILESTONE_TITLES key has zero or more than one MILESTONE_DEFS
    // entry — this file's static import above already proved that for the
    // live tables. There is no seam to inject a bad table through this
    // module (MILESTONE_DEFS is plain data with no exported factory), so
    // this test re-derives the same coverage the module-load assertion
    // enforces, naming the invariant explicitly instead of leaving it
    // implicit in "the import didn't throw".
    const defsByKey = new Map(MILESTONE_DEFS.map((def) => [def.key, def]));
    for (const key of Object.keys(MILESTONE_TITLES)) {
      const def = defsByKey.get(key);
      expect(def).toBeDefined();
      expect(def?.title).toBe(
        MILESTONE_TITLES[key as keyof typeof MILESTONE_TITLES],
      );
    }
  });

  test("has no duplicate keys", () => {
    const keys = MILESTONE_DEFS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("legacyTitles", () => {
    test("p1's legacy title is the ADR-0073 rename source — omitting it would strand every issue on the abandoned 'Next — consumer fleet' milestone (28 open p1 items at the time of the rename)", () => {
      const p1 = MILESTONE_DEFS.find((def) => def.key === "p1");
      expect(p1?.legacyTitles).toEqual(["Next — consumer fleet"]);
    });

    test("p2's legacy title is the ADR-0073 rename source — omitting it would strand every issue on the abandoned 'Later — gated/deferred' milestone (31 open p2 items at the time of the rename)", () => {
      const p2 = MILESTONE_DEFS.find((def) => def.key === "p2");
      expect(p2?.legacyTitles).toEqual(["Later — gated/deferred"]);
    });

    test("major's legacy title is 'Breaking', the pre-existing title that predates '2.0 / breaking'", () => {
      const major = MILESTONE_DEFS.find((def) => def.key === "major");
      expect(major?.legacyTitles).toEqual(["Breaking"]);
    });

    test.each(["p0", "p3", "governance"])(
      "%s carries no legacy title (never renamed)",
      (key) => {
        const def = MILESTONE_DEFS.find((entry) => entry.key === key);
        expect(def?.legacyTitles).toEqual([]);
      },
    );

    test("no title is claimed by two different defs' legacyTitles (the module-load order-independence assertion held)", () => {
      // Mirrors the real module-load `for` loop that throws if a legacy
      // title is claimed by more than one def, which a rename would make
      // order-dependent. This file's static import already proved that for
      // the live table; this test names the invariant explicitly.
      const claimed = new Map<string, string>();
      for (const def of MILESTONE_DEFS) {
        for (const legacy of def.legacyTitles) {
          expect(claimed.has(legacy)).toBe(false);
          claimed.set(legacy, def.key);
        }
      }
    });

    test("no def's own title also appears as another def's legacy title (the module-load title-match-first assertion held)", () => {
      // Mirrors the real module-load `for` loop that throws if a def's
      // current title collides with some def's legacy title, which would
      // make planMilestones' title-match-first rule ambiguous.
      const legacyTitles = new Set(
        MILESTONE_DEFS.flatMap((def) => def.legacyTitles),
      );
      for (const def of MILESTONE_DEFS) {
        expect(legacyTitles.has(def.title)).toBe(false);
      }
    });
  });

  describe("priority-tier description parity", () => {
    test.each(["p0", "p1", "p2", "p3"] as const)(
      "%s's milestone description matches PRIORITY_TIERS and the priority:* LABEL_DEFS entry (one shared description, not three independently-drifting copies)",
      (tier) => {
        const milestoneDef = MILESTONE_DEFS.find((def) => def.key === tier);
        const labelDef = LABEL_DEFS.find(
          (def) => def.name === PRIORITY_LABELS[tier],
        );
        expect(labelDef).toBeDefined();
        expect(labelDef?.description).toBe(PRIORITY_TIERS[tier].description);
        expect(milestoneDef?.description).toBe(
          PRIORITY_TIERS[tier].description,
        );
      },
    );
  });

  test("every description fits within LABEL_DESCRIPTION_MAX_LENGTH — the p0-p3 descriptions are shared with LABEL_DEFS, so a milestone description over the label cap would break gh label create on the label side too", () => {
    for (const def of MILESTONE_DEFS) {
      expect(def.description.length).toBeLessThanOrEqual(
        LABEL_DESCRIPTION_MAX_LENGTH,
      );
    }
  });

  test("every entry has a non-empty key, title, and description", () => {
    for (const def of MILESTONE_DEFS) {
      expect(def.key.length).toBeGreaterThan(0);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});
