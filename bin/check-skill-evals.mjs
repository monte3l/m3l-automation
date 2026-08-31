#!/usr/bin/env node
// Static gate (Anthropic AI-native SDLC harness-alignment plan, Section 4):
// every `.claude/skills/<name>/SKILL.md` must have a sibling
// `evals/evals.json` with >= MIN_CASES cases, and every case must be
// GRADEABLE — a `prompt`, an `expected_output`, and a checklist of at least
// one entry this repo's runner can actually render.
//
// The shape half exists because it was missing. CI run 33390425486 graded all
// 46 cases while 123 checklist entries across 24 cases were objects being
// interpolated as `1. [object Object]`, and `syncing-docs` carried no
// checklist key at all — three cases whose "verdict" graded against nothing.
// This gate read only `{name, hasFile, caseCount, parseError}`, so none of it
// was visible. Entries are now validated with the very same
// `renderChecklistEntry`/`selectChecklist` the runner uses (imported, not
// reimplemented) so the gate and the runner cannot disagree about what a
// valid entry is.
//
// Accepted checklist shapes: `expectations` or `assertions` (synonyms),
// holding either plain non-empty strings or objects with a non-empty
// `description`/`text`. Identifier-only entries are rejected on purpose —
// `{name}`/`{id}` alone gives the grader nothing to grade.
//
// EXEMPT_SKILLS is a temporary, named grandfather list for the skills that
// had zero evals when this gate was introduced — landing the gate as a hard
// requirement immediately would have failed the pre-push `checks` lane for
// every future push until the backfill finished. Backfill is tracked at
// https://github.com/monte3l/m3l-automation/issues/775, 2-3 skills per PR.
// A skill must be removed from EXEMPT_SKILLS in the SAME PR that makes it
// compliant — this script rejects a redundant exemption (an exempt skill
// that already has a qualifying, well-shaped file) so the list cannot
// silently outlive its purpose.
//
// Usage:
//   node bin/check-skill-evals.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import {
  CRITERION_KEYS,
  renderChecklistEntry,
  selectChecklist,
} from "./run-skill-evals.mjs";

export const MIN_CASES = 3;

/**
 * Minimum checklist entries for a case to mean anything. One is a low bar
 * deliberately: this gate's job is to reject a case that grades against
 * NOTHING, not to litigate how thorough a checklist should be.
 */
export const MIN_CHECKLIST_ENTRIES = 1;

export const EXEMPT_SKILLS = new Set([
  "eslint-flat-config",
  "implementing-scripts",
  "resolving-merge-conflicts",
  "reviewing-dependabot-prs",
  "starting-work",
  // Has 3 cases, but none carries a checklist key at all — so all 3 grade
  // against `expected_output` alone. Authoring a real checklist for it is
  // the follow-up corpus PR's job; remove this entry in that same PR.
  "syncing-docs",
  "triaging-scan-alerts",
  "tsconfig-strict-esm",
  "vitest-coverage-types-mocks",
]);

/**
 * @typedef {object} SkillEvalCaseState
 * @property {string | number | undefined} id the case's declared id
 * @property {boolean} hasPrompt
 * @property {boolean} hasExpectedOutput
 * @property {string | null} checklistKey which of CHECKLIST_KEYS was used
 * @property {number} entryCount entries found under that key
 * @property {number} unrenderableCount entries renderChecklistEntry rejected
 */

/**
 * @typedef {object} SkillEvalState
 * @property {string} name
 * @property {boolean} hasFile
 * @property {number | null} caseCount null when the file exists but is not
 *   valid JSON (parseError is set instead)
 * @property {SkillEvalCaseState[]} [cases] per-case shape, absent when the
 *   file is missing or unparseable
 * @property {string} [parseError]
 */

/**
 * Per-case shape violations for one skill, as human-readable messages.
 *
 * Pure and separate from the coverage rules so the two concerns stay
 * legible: coverage asks "are there enough cases?", this asks "is each case
 * gradeable?".
 *
 * @param {string} name skill name, for the message
 * @param {SkillEvalCaseState[]} cases
 * @returns {string[]}
 */
export function findCaseShapeViolations(name, cases) {
  const errors = [];
  const where = (index, id) =>
    `.claude/skills/${name}/evals/evals.json case ` +
    `${id === undefined ? `#${index} (no id)` : `#${id}`}`;

  cases.forEach((kase, index) => {
    if (!kase.hasPrompt) {
      errors.push(`${where(index, kase.id)} has no non-empty "prompt".`);
    }
    if (!kase.hasExpectedOutput) {
      errors.push(
        `${where(index, kase.id)} has no non-empty "expected_output".`,
      );
    }
    if (kase.unrenderableCount > 0) {
      errors.push(
        `${where(index, kase.id)} has ${kase.unrenderableCount} checklist ` +
          `entr${kase.unrenderableCount === 1 ? "y" : "ies"} the runner ` +
          `cannot render — each must be a non-empty string or carry a ` +
          `non-empty ${CRITERION_KEYS.map((k) => `"${k}"`).join(" or ")} ` +
          `string (an identifier-only entry grades against nothing).`,
      );
    }
    if (kase.entryCount - kase.unrenderableCount < MIN_CHECKLIST_ENTRIES) {
      errors.push(
        `${where(index, kase.id)} has no usable checklist ` +
          `(${kase.checklistKey === null ? 'no "expectations"/"assertions" key' : `"${kase.checklistKey}" yields 0 renderable entries`}) ` +
          `— it would grade against "expected_output" alone, which is not a ` +
          `verdict.`,
      );
    }
  });

  return errors;
}

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

    // Deliberately NOT grandfathered: an exemption covers "not backfilled
    // yet", never a file that cannot be parsed at all.
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

    const shapeErrors = findCaseShapeViolations(skill.name, skill.cases ?? []);

    // An exemption grandfathers shape too — otherwise adding the shape rules
    // would break the pre-push lane for every push until the corpus rewrite
    // landed. It still cannot outlive its purpose: once the shape errors are
    // gone the redundancy check below fires.
    if (isExempt) {
      if (shapeErrors.length > 0) {
        exempt++;
        warnings.push(
          `${skill.name} has ${skill.caseCount} case(s) but ` +
            `${shapeErrors.length} unresolved case-shape violation(s) ` +
            `(temporarily exempt — see issue #775): ${shapeErrors[0]}`,
        );
        continue;
      }
      errors.push(
        `${skill.name} is listed in EXEMPT_SKILLS (bin/check-skill-evals.mjs) ` +
          `but already has ${skill.caseCount} qualifying, well-shaped eval ` +
          `case(s) — remove it from the exemption list now that its backfill ` +
          `has landed.`,
      );
      continue;
    }

    if (shapeErrors.length > 0) {
      errors.push(...shapeErrors);
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
      const evals = Array.isArray(parsed.evals) ? parsed.evals : [];
      const cases = evals.map((evalCase) => {
        const { key, entries } = selectChecklist(evalCase ?? {});
        const unrenderableCount = entries.filter(
          (entry) => renderChecklistEntry(entry) === null,
        ).length;
        return {
          id: evalCase?.id,
          hasPrompt:
            typeof evalCase?.prompt === "string" &&
            evalCase.prompt.trim() !== "",
          hasExpectedOutput:
            typeof evalCase?.expected_output === "string" &&
            evalCase.expected_output.trim() !== "",
          checklistKey: key,
          entryCount: entries.length,
          unrenderableCount,
        };
      });
      return { name, hasFile: true, caseCount: evals.length, cases };
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
