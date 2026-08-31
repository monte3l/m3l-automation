import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXEMPT_SKILLS,
  MIN_CASES,
  MIN_CHECKLIST_ENTRIES,
  discoverSkillEvalState,
  evaluateSkillEvals,
  findCaseShapeViolations,
} from "../../bin/check-skill-evals.mjs";

describe("MIN_CASES", () => {
  test("is the current 3-case minimum", () => {
    expect(MIN_CASES).toBe(3);
  });
});

describe("EXEMPT_SKILLS", () => {
  test("is an empty Set — the #775 backfill is complete and all 21 skills are compliant", () => {
    expect(EXEMPT_SKILLS).toBeInstanceOf(Set);
    // Pin the backfill completion: this must be 0. If it grows, a new entry
    // was added that has not yet been removed after its skill became compliant.
    expect(EXEMPT_SKILLS.size).toBe(0);
  });
});

describe("evaluateSkillEvals", () => {
  test("a non-exempt skill with no evals file produces an error", () => {
    const { errors, warnings, compliant, exempt } = evaluateSkillEvals(
      [{ name: "some-skill", hasFile: false, caseCount: null }],
      new Set(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("has no evals/evals.json");
    expect(warnings).toHaveLength(0);
    expect(compliant).toBe(0);
    expect(exempt).toBe(0);
  });

  test("an exempt skill with no evals file produces a warning, not an error", () => {
    const { errors, warnings, compliant, exempt } = evaluateSkillEvals(
      [{ name: "exempt-skill", hasFile: false, caseCount: null }],
      new Set(["exempt-skill"]),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exempt via EXEMPT_SKILLS");
    expect(compliant).toBe(0);
    expect(exempt).toBe(1);
  });

  test("a skill whose evals.json failed to parse produces an error mentioning the parse error, regardless of exemption", () => {
    const parseError = "Unexpected token } in JSON at position 12";
    const { errors, compliant, exempt } = evaluateSkillEvals(
      [
        {
          name: "broken-skill",
          hasFile: true,
          caseCount: null,
          parseError,
        },
      ],
      new Set(["broken-skill"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(parseError);
    expect(compliant).toBe(0);
    expect(exempt).toBe(0);
  });

  test("a skill below MIN_CASES produces an error mentioning the case count, regardless of exemption", () => {
    const { errors, compliant, exempt } = evaluateSkillEvals(
      [{ name: "thin-skill", hasFile: true, caseCount: 2 }],
      new Set(["thin-skill"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2");
    expect(compliant).toBe(0);
    expect(exempt).toBe(0);
  });

  test("a compliant, non-exempt skill increments compliant with no error or warning", () => {
    const { errors, warnings, compliant, exempt } = evaluateSkillEvals(
      [{ name: "good-skill", hasFile: true, caseCount: MIN_CASES }],
      new Set(),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(compliant).toBe(1);
    expect(exempt).toBe(0);
  });

  test("a redundantly-exempt compliant skill produces an error and is NOT counted compliant", () => {
    const { errors, compliant, exempt } = evaluateSkillEvals(
      [{ name: "over-exempt", hasFile: true, caseCount: MIN_CASES + 1 }],
      new Set(["over-exempt"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("remove it from the exemption list");
    expect(compliant).toBe(0);
    expect(exempt).toBe(0);
  });

  test("aggregates counts correctly across a mixed set of skills", () => {
    const skills = [
      { name: "no-file-not-exempt", hasFile: false, caseCount: null },
      { name: "no-file-exempt", hasFile: false, caseCount: null },
      {
        name: "parse-error",
        hasFile: true,
        caseCount: null,
        parseError: "bad json",
      },
      { name: "too-few-cases", hasFile: true, caseCount: 1 },
      { name: "compliant-one", hasFile: true, caseCount: MIN_CASES },
      { name: "compliant-two", hasFile: true, caseCount: MIN_CASES + 5 },
      { name: "redundant-exempt", hasFile: true, caseCount: MIN_CASES },
    ];
    const exemptSkills = new Set(["no-file-exempt", "redundant-exempt"]);
    const { errors, warnings, compliant, exempt } = evaluateSkillEvals(
      skills,
      exemptSkills,
    );
    // errors: no-file-not-exempt, parse-error, too-few-cases, redundant-exempt
    expect(errors).toHaveLength(4);
    // warnings: no-file-exempt
    expect(warnings).toHaveLength(1);
    // compliant: compliant-one, compliant-two
    expect(compliant).toBe(2);
    // exempt: no-file-exempt
    expect(exempt).toBe(1);
  });
});

describe("discoverSkillEvalState", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("returns [] when skillsDir does not exist", () => {
    const missing = join(tmpdir(), "m3l-skill-evals-does-not-exist-xyz");
    expect(discoverSkillEvalState(missing)).toEqual([]);
  });

  test("discovers valid, missing, and unparseable evals.json across skill directories, excluding non-skill dirs, sorted by name", () => {
    dir = mkdtempSync(join(tmpdir(), "m3l-skill-evals-"));

    // A compliant skill with a valid 3-case evals.json.
    const validDir = join(dir, "zzz-valid-skill");
    mkdirSync(join(validDir, "evals"), { recursive: true });
    writeFileSync(join(validDir, "SKILL.md"), "# zzz-valid-skill", "utf8");
    writeFileSync(
      join(validDir, "evals", "evals.json"),
      JSON.stringify({
        evals: [{ id: 1 }, { id: 2 }, { id: 3 }],
      }),
      "utf8",
    );

    // A skill with no evals directory at all.
    const noEvalsDir = join(dir, "aaa-no-evals-skill");
    mkdirSync(noEvalsDir, { recursive: true });
    writeFileSync(join(noEvalsDir, "SKILL.md"), "# aaa-no-evals-skill", "utf8");

    // A skill whose evals.json is not valid JSON.
    const brokenDir = join(dir, "mmm-broken-skill");
    mkdirSync(join(brokenDir, "evals"), { recursive: true });
    writeFileSync(join(brokenDir, "SKILL.md"), "# mmm-broken-skill", "utf8");
    writeFileSync(
      join(brokenDir, "evals", "evals.json"),
      "{ not valid json",
      "utf8",
    );

    // A non-skill directory (no SKILL.md) that must be excluded.
    const notASkillDir = join(dir, "not-a-skill");
    mkdirSync(join(notASkillDir, "evals"), { recursive: true });
    writeFileSync(
      join(notASkillDir, "evals", "evals.json"),
      JSON.stringify({ evals: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      "utf8",
    );

    const result = discoverSkillEvalState(dir);

    expect(result.map((s) => s.name)).toEqual([
      "aaa-no-evals-skill",
      "mmm-broken-skill",
      "zzz-valid-skill",
    ]);

    const noEvals = result.find((s) => s.name === "aaa-no-evals-skill");
    expect(noEvals).toEqual({
      name: "aaa-no-evals-skill",
      hasFile: false,
      caseCount: null,
    });

    const broken = result.find((s) => s.name === "mmm-broken-skill");
    expect(broken?.hasFile).toBe(true);
    expect(broken?.caseCount).toBeNull();
    expect(typeof broken?.parseError).toBe("string");
    expect(broken?.parseError?.length).toBeGreaterThan(0);

    const valid = result.find((s) => s.name === "zzz-valid-skill");
    expect(valid?.name).toBe("zzz-valid-skill");
    expect(valid?.hasFile).toBe(true);
    expect(valid?.caseCount).toBe(3);
    // Each fixture case is `{ id }` only, so every shape field reads as
    // absent — which is what lets findCaseShapeViolations reject it.
    expect(valid?.cases).toEqual([
      {
        id: 1,
        hasPrompt: false,
        hasExpectedOutput: false,
        checklistKey: null,
        entryCount: 0,
        unrenderableCount: 0,
      },
      {
        id: 2,
        hasPrompt: false,
        hasExpectedOutput: false,
        checklistKey: null,
        entryCount: 0,
        unrenderableCount: 0,
      },
      {
        id: 3,
        hasPrompt: false,
        hasExpectedOutput: false,
        checklistKey: null,
        entryCount: 0,
        unrenderableCount: 0,
      },
    ]);
  });

  test("treats a missing or non-array evals field as zero cases", () => {
    dir = mkdtempSync(join(tmpdir(), "m3l-skill-evals-"));
    const skillDir = join(dir, "empty-evals-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# empty-evals-skill", "utf8");
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({ skill_name: "empty-evals-skill" }),
      "utf8",
    );

    const result = discoverSkillEvalState(dir);
    expect(result).toEqual([
      { name: "empty-evals-skill", hasFile: true, caseCount: 0, cases: [] },
    ]);
  });
});

/** The per-case shape discoverSkillEvalState yields. */
type CaseState = {
  id: string | number | undefined;
  hasPrompt: boolean;
  hasExpectedOutput: boolean;
  checklistKey: string | null;
  entryCount: number;
  unrenderableCount: number;
};

/** A case shape with every field valid; spread and override to make one bad. */
const goodCase: CaseState = {
  id: 1,
  hasPrompt: true,
  hasExpectedOutput: true,
  checklistKey: "expectations",
  entryCount: 3,
  unrenderableCount: 0,
};

describe("MIN_CHECKLIST_ENTRIES", () => {
  test("is ratcheted to 3 — one criterion cannot distinguish a passing skill from a lucky response", () => {
    expect(MIN_CHECKLIST_ENTRIES).toBe(3);
  });
});

describe("findCaseShapeViolations", () => {
  test("accepts a fully-formed case", () => {
    expect(findCaseShapeViolations("some-skill", [goodCase])).toEqual([]);
  });

  test("rejects a case with no checklist key at all (syncing-docs)", () => {
    const errors = findCaseShapeViolations("syncing-docs", [
      { ...goodCase, checklistKey: null, entryCount: 0 },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no usable checklist");
    expect(errors[0]).toContain('no "expectations"/"assertions" key');
    expect(errors[0]).toContain("not a verdict");
  });

  test("rejects a case whose checklist key exists but yields zero entries", () => {
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, entryCount: 0 },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"expectations" yields 0 renderable entries');
  });

  test("rejects a case with an entry the runner cannot render (unrenderable error AND below-floor error both fire)", () => {
    // entryCount:3, unrenderableCount:1 → 2 usable entries < MIN_CHECKLIST_ENTRIES(3).
    // With MIN ratcheted to 3, the below-floor rule fires alongside the
    // unrenderable rule, producing two distinct errors.
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, entryCount: 3, unrenderableCount: 1 },
    ]);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("1 checklist entry the runner cannot render");
    expect(errors[0]).toContain("identifier-only entry grades against nothing");
    expect(errors[1]).toContain('"expectations" yields 0 renderable entries');
  });

  test("rejects a case where every entry is unrenderable, on both counts", () => {
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, entryCount: 2, unrenderableCount: 2 },
    ]);

    // Both the "cannot render" rule and the "nothing usable left" rule fire.
    expect(errors).toHaveLength(2);
  });

  test.each([
    { field: "hasPrompt", needle: 'no non-empty "prompt"' },
    { field: "hasExpectedOutput", needle: 'no non-empty "expected_output"' },
  ])("rejects a case missing $field", ({ field, needle }) => {
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, [field]: false },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(needle);
  });

  test("names a case by index when it declares no id", () => {
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, id: undefined, entryCount: 0 },
    ]);

    expect(errors[0]).toContain("case #0 (no id)");
  });

  // Boundary pair for the MIN_CHECKLIST_ENTRIES ratchet (was 1, now 3).
  // These two cases sit on either side of the new floor and are the
  // regression guard for future changes to the constant.
  test("rejects a case with exactly 2 usable checklist entries (one below the floor of 3)", () => {
    const errors = findCaseShapeViolations("some-skill", [
      { ...goodCase, entryCount: 2, unrenderableCount: 0 },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"expectations" yields 0 renderable entries');
    expect(errors[0]).toContain("no usable checklist");
  });

  test("accepts a case with exactly 3 usable checklist entries (at the floor of 3)", () => {
    expect(
      findCaseShapeViolations("some-skill", [
        { ...goodCase, entryCount: 3, unrenderableCount: 0 },
      ]),
    ).toEqual([]);
  });
});

describe("evaluateSkillEvals case-shape integration", () => {
  const withCases = (name: string, cases: (typeof goodCase)[]) => [
    { name, hasFile: true, caseCount: cases.length, cases },
  ];

  test("a non-exempt skill with a shape violation errors", () => {
    const { errors, compliant } = evaluateSkillEvals(
      withCases("bad-skill", [
        goodCase,
        goodCase,
        { ...goodCase, checklistKey: null, entryCount: 0 },
      ]),
      new Set(),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no usable checklist");
    expect(compliant).toBe(0);
  });

  test("an exempt skill's shape violations warn rather than error", () => {
    // Otherwise landing these rules would break pre-push for every push
    // until the corpus rewrite shipped.
    const { errors, warnings, exempt } = evaluateSkillEvals(
      withCases("syncing-docs", [
        { ...goodCase, checklistKey: null, entryCount: 0 },
        { ...goodCase, checklistKey: null, entryCount: 0 },
        { ...goodCase, checklistKey: null, entryCount: 0 },
      ]),
      new Set(["syncing-docs"]),
    );

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unresolved case-shape violation");
    expect(exempt).toBe(1);
  });

  test("an exemption that is no longer needed becomes an error", () => {
    // The exemption cannot silently outlive its purpose: the moment the
    // shape violations are fixed, the grandfather entry must be removed.
    const { errors } = evaluateSkillEvals(
      withCases("syncing-docs", [goodCase, goodCase, goodCase]),
      new Set(["syncing-docs"]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("remove it from the exemption list");
  });

  test("a well-shaped non-exempt skill is compliant", () => {
    const { errors, warnings, compliant } = evaluateSkillEvals(
      withCases("good-skill", [goodCase, goodCase, goodCase]),
      new Set(),
    );

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(compliant).toBe(1);
  });
});

describe("discoverSkillEvalState against the real corpus", () => {
  // Reads the committed artifact unmocked. A fixture cannot catch a FIFTH
  // checklist shape being introduced later; this can, and its absence is
  // exactly why 123 "[object Object]" entries reached CI ungated.
  const skillsDir = fileURLToPath(
    new URL("../../.claude/skills", import.meta.url),
  );
  const skills = discoverSkillEvalState(skillsDir);

  test("discovers every skill and populates per-case shape", () => {
    expect(skills.length).toBeGreaterThan(0);
    const withFile = skills.filter((s) => s.hasFile);
    expect(withFile.length).toBeGreaterThan(0);
    for (const skill of withFile) {
      expect(skill.cases).toBeDefined();
      expect(skill.cases).toHaveLength(skill.caseCount as number);
    }
  });

  test("every case in the real corpus declares a prompt and expected_output", () => {
    for (const skill of skills.filter((s) => s.hasFile)) {
      for (const kase of skill.cases ?? []) {
        expect(kase.hasPrompt, `${skill.name}#${kase.id} prompt`).toBe(true);
        expect(
          kase.hasExpectedOutput,
          `${skill.name}#${kase.id} expected_output`,
        ).toBe(true);
      }
    }
  });

  test("no case in the real corpus carries an unrenderable checklist entry", () => {
    for (const skill of skills.filter((s) => s.hasFile)) {
      for (const kase of skill.cases ?? []) {
        expect(
          kase.unrenderableCount,
          `${skill.name}#${kase.id} has unrenderable entries — a new ` +
            `checklist shape was introduced without teaching ` +
            `renderChecklistEntry about it`,
        ).toBe(0);
      }
    }
  });

  test("the committed corpus and exemption list together pass the gate", () => {
    const { errors } = evaluateSkillEvals(skills, EXEMPT_SKILLS);
    expect(errors).toEqual([]);
  });
});
