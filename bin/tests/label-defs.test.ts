import { describe, expect, test } from "vitest";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from "../lib/hub-sync.mjs";
import {
  LABEL_DEFS,
  LABEL_DESCRIPTION_MAX_LENGTH,
} from "../lib/label-defs.mjs";

describe("LABEL_DESCRIPTION_MAX_LENGTH", () => {
  test("is GitHub's 100-char `gh label create --description` cap", () => {
    expect(LABEL_DESCRIPTION_MAX_LENGTH).toBe(100);
  });
});

describe("LABEL_DEFS", () => {
  const EXPECTED_NAMES = [
    "hub-sync",
    "priority:0-now",
    "priority:1-next",
    "priority:2-later",
    "type:capability",
    "type:consumer-script",
    "type:friction",
    "type:governance",
    "status:todo",
    "status:in-progress",
    "status:deferred",
    "status:blocked",
    "status:done",
    "status:rejected",
    "triage",
  ];

  test("declares exactly the 15 ADR-0032/ADR-0052 (2026-08-20 Update) hub-managed labels, in the ADR-0051 semantic vocabulary", () => {
    expect(LABEL_DEFS.map((def) => def.name)).toEqual(EXPECTED_NAMES);
  });

  test("every PRIORITY_LABELS/TYPE_LABELS/STATUS_LABELS value has a matching LABEL_DEFS entry (the module-load exhaustiveness assertion held)", () => {
    // The real module-load `for` loop in bin/lib/label-defs.mjs throws if any
    // managed-label value has no LABEL_DEFS counterpart — this file's static
    // import above already proved that for the live tables. There is no seam
    // to inject a bad table through this module (LABEL_DEFS is plain data
    // with no exported factory), so this test re-derives the same set
    // coverage the module-load assertion enforces, naming the invariant
    // explicitly instead of leaving it implicit in "the import didn't throw".
    const definedNames = new Set(LABEL_DEFS.map((def) => def.name));
    const managedValues = [
      ...Object.values(PRIORITY_LABELS),
      ...Object.values(TYPE_LABELS),
      ...Object.values(STATUS_LABELS),
    ];
    for (const value of managedValues) {
      expect(definedNames.has(value)).toBe(true);
    }
  });

  test("has no duplicate label names", () => {
    const names = LABEL_DEFS.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every entry has a non-empty name, a 6-hex-digit color, and a non-empty description", () => {
    for (const def of LABEL_DEFS) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.color).toMatch(/^[0-9a-fA-F]{6}$/);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  // Documents the module-load-time assertion (the `for` loop right after the
  // LABEL_DEFS export, which throws if a description exceeds
  // LABEL_DESCRIPTION_MAX_LENGTH) on the live export itself, per this task's
  // sanctioned fallback — there is no existing bin/lib/*.mjs precedent in
  // this repo for re-importing a module under a mutated fixture to exercise
  // an import-time throw, and LABEL_DEFS is a plain data export with no seam
  // to inject a bad description through. The fact that this file's static
  // `import` above succeeded already proves the assertion held for every
  // entry; this test names that invariant explicitly instead of leaving it
  // implicit in "the import didn't throw."
  test("every description fits within LABEL_DESCRIPTION_MAX_LENGTH (the module-load assertion held)", () => {
    for (const def of LABEL_DEFS) {
      expect(def.description.length).toBeLessThanOrEqual(
        LABEL_DESCRIPTION_MAX_LENGTH,
      );
    }
  });

  test("the triage label description mentions the failure_report.yml template it is applied by", () => {
    const triage = LABEL_DEFS.find((def) => def.name === "triage");
    expect(triage?.description).toContain("failure_report.yml");
  });
});
