import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXEMPT_SKILLS,
  MIN_CASES,
  discoverSkillEvalState,
  evaluateSkillEvals,
} from "../../bin/check-skill-evals.mjs";

describe("MIN_CASES", () => {
  test("is the current 3-case minimum", () => {
    expect(MIN_CASES).toBe(3);
  });
});

describe("EXEMPT_SKILLS", () => {
  test("is a Set of skill names", () => {
    expect(EXEMPT_SKILLS).toBeInstanceOf(Set);
    expect(EXEMPT_SKILLS.size).toBeGreaterThan(0);
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
    expect(warnings[0]).toContain("temporarily exempt");
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
    expect(valid).toEqual({
      name: "zzz-valid-skill",
      hasFile: true,
      caseCount: 3,
    });
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
      { name: "empty-evals-skill", hasFile: true, caseCount: 0 },
    ]);
  });
});
