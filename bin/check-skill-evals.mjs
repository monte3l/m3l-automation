#!/usr/bin/env node
// Static gate (Anthropic AI-native SDLC harness-alignment plan, Section 4):
// every `.claude/skills/<name>/SKILL.md` must have a sibling
// `evals/evals.json` with >= MIN_CASES cases, matching the shape documented
// in `.claude/skills/writing-commits/evals/evals.json` (skill_name, evals[]
// of { id, prompt, expected_output, files, expectations[] }).
//
// EXEMPT_SKILLS is a temporary, named grandfather list for the skills that
// had zero evals when this gate was introduced — landing the gate as a hard
// requirement immediately would have failed the pre-push `checks` lane for
// every future push until the backfill finished. Backfill is tracked at
// https://github.com/monte3l/m3l-automation/issues/775, 2-3 skills per PR.
// A skill must be removed from EXEMPT_SKILLS in the SAME PR that adds its
// evals/evals.json — this script rejects a redundant exemption (an exempt
// skill that already has a qualifying file) so the list cannot silently
// outlive its purpose.
//
// Usage:
//   node bin/check-skill-evals.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

export const MIN_CASES = 3;

export const EXEMPT_SKILLS = new Set([
  "eslint-flat-config",
  "implementing-scripts",
  "resolving-merge-conflicts",
  "reviewing-dependabot-prs",
  "starting-work",
  "triaging-scan-alerts",
  "tsconfig-strict-esm",
  "vitest-coverage-types-mocks",
]);

/**
 * @typedef {object} SkillEvalState
 * @property {string} name
 * @property {boolean} hasFile
 * @property {number | null} caseCount null when the file exists but is not
 *   valid JSON (parseError is set instead)
 * @property {string} [parseError]
 */

/**
 * Pure compliance check over already-discovered skill eval state — no file
 * I/O, so this is the part unit tests exercise directly.
 *
 * @param {SkillEvalState[]} skills
 * @param {Set<string>} exemptSkills
 * @returns {{ errors: string[], warnings: string[], compliant: number, exempt: number }}
 */
export function evaluateSkillEvals(skills, exemptSkills) {
  const errors = [];
  const warnings = [];
  let compliant = 0;
  let exempt = 0;

  for (const skill of skills) {
    const isExempt = exemptSkills.has(skill.name);

    if (!skill.hasFile) {
      if (isExempt) {
        exempt++;
        warnings.push(
          `${skill.name} has no evals/evals.json (temporarily exempt — see ` +
            `issue #775; the exemption must be removed once the backfill lands).`,
        );
        continue;
      }
      errors.push(
        `.claude/skills/${skill.name}/ has no evals/evals.json — every skill ` +
          `needs >= ${MIN_CASES} eval cases (see ` +
          `.claude/skills/writing-commits/evals/evals.json for the shape).`,
      );
      continue;
    }

    if (skill.caseCount === null) {
      errors.push(
        `.claude/skills/${skill.name}/evals/evals.json is not valid JSON: ${skill.parseError}`,
      );
      continue;
    }

    if (skill.caseCount < MIN_CASES) {
      errors.push(
        `.claude/skills/${skill.name}/evals/evals.json has ${skill.caseCount} ` +
          `case(s), below the ${MIN_CASES}-case minimum.`,
      );
      continue;
    }

    if (isExempt) {
      errors.push(
        `${skill.name} is listed in EXEMPT_SKILLS (bin/check-skill-evals.mjs) ` +
          `but already has ${skill.caseCount} qualifying eval case(s) — remove ` +
          `it from the exemption list now that its backfill has landed.`,
      );
      continue;
    }

    compliant++;
  }

  return { errors, warnings, compliant, exempt };
}

/**
 * Read every `.claude/skills/<name>/evals/evals.json` on disk into the
 * pure-checkable {@link SkillEvalState} shape.
 *
 * @param {string} skillsDir
 * @returns {SkillEvalState[]}
 */
export function discoverSkillEvalState(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .sort();

  return skillNames.map((name) => {
    const evalsPath = join(skillsDir, name, "evals", "evals.json");
    if (!existsSync(evalsPath)) {
      return { name, hasFile: false, caseCount: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(evalsPath, "utf8"));
      const caseCount = Array.isArray(parsed.evals) ? parsed.evals.length : 0;
      return { name, hasFile: true, caseCount };
    } catch (err) {
      return {
        name,
        hasFile: true,
        caseCount: null,
        parseError: err.message,
      };
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const root = repoRoot(import.meta.url);
  const skillsDir = join(root, ".claude/skills");

  const skills = discoverSkillEvalState(skillsDir);
  const { errors, warnings, compliant, exempt } = evaluateSkillEvals(
    skills,
    EXEMPT_SKILLS,
  );

  for (const warning of warnings) reporter.warn(warning);
  for (const error of errors) reporter.error(error);

  if (errors.length > 0) {
    if (!json)
      console.error(`\n✗  ${errors.length} skill-eval coverage violation(s).`);
    reporter.finish({ skills: skills.length, compliant, exempt });
    process.exit(1);
  }

  reporter.succeed(
    `${skills.length} skill(s) checked: ${compliant} compliant, ${exempt} ` +
      `temporarily exempt (issue #775).`,
  );
  reporter.finish({ skills: skills.length, compliant, exempt });
}
