#!/usr/bin/env node
// Validates `.claude/skills/*/SKILL.md` frontmatter, naming convention, and
// catalog coverage — the skill-side counterpart to `bin/check-agents.mjs`'s
// agent checks, which had no equivalent for skills before this gate.
//
// Four checks, three enforcement shapes:
//
//   1. Structural frontmatter validity: HARD-FAIL on a missing/empty
//      `description` (mirrors check-agents.mjs's identical rule for
//      `.claude/agents/*.md` — `collectSkillDescriptions` in
//      check-context-budget.mjs reads `description` only to measure length,
//      so an empty one there silently produced `chars: 0`, nothing else
//      caught it), and HARD-FAIL when `name:` doesn't match the skill's
//      directory name.
//   2. Naming convention: HARD-FAIL on a name breaking the Agent Skills
//      spec's hard rules (kebab-case, ≤64 chars) or matching neither this
//      repo's gerund-phrase nor <topic>-<head-noun> convention (unless
//      explicitly grandfathered). WARN-only when a name contains a spec-
//      reserved word ("anthropic"/"claude") — see
//      bin/lib/skill-frontmatter.mjs's deriveNameIssues doc comment for why
//      that one case is a warning, not a hard-fail.
//   3. Catalog coverage: HARD-FAIL when `docs/contributing/skills-catalog.md`
//      doesn't mention a skill directory at all — this is exactly how
//      `finishing-work` went undocumented after shipping (docs/logs/
//      2026-09-02-finishing-work-skill.md), with nothing to catch it.
//   4. Description overlap: WARN-only. Two skills whose descriptions share
//      enough vocabulary risk competing for the same prose-triggered
//      request. Judgment call, not a defect — see
//      bin/lib/skill-frontmatter.mjs's OVERLAP_WARN_THRESHOLD comment for
//      how the threshold was picked against this repo's real corpus.
//
// Usage:
//   node bin/check-skill-frontmatter.mjs   # exits 0 on success, 1 on any hard violation
import process from "node:process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseSkillFrontmatter,
  deriveFrontmatterIssues,
  deriveNameIssues,
  deriveMissingFromCatalog,
  deriveOverlappingPairs,
} from "./lib/skill-frontmatter.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, ".claude", "skills");
const catalogPath = join(root, "docs", "contributing", "skills-catalog.md");

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const skillDirs = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

const skills = skillDirs.map((dirName) => ({
  dirName,
  content: readFileSync(join(skillsDir, dirName, "SKILL.md"), "utf8"),
}));

// --- 1. Structural frontmatter validity ------------------------------------
const parsed = parseSkillFrontmatter(skills);
const { emptyDescription, nameMismatch } = deriveFrontmatterIssues(parsed);

for (const dirName of emptyDescription) {
  reporter.error(
    `.claude/skills/${dirName}/SKILL.md has a missing or empty "description" ` +
      `field — Claude uses it to decide when to invoke the skill (code.claude.com/docs/en/skills).`,
    { file: `.claude/skills/${dirName}/SKILL.md` },
  );
}
for (const message of nameMismatch) {
  reporter.error(message);
}

// --- 2. Naming convention ----------------------------------------------------
const { specViolations, shapeViolations, reservedWordWarnings } =
  deriveNameIssues(parsed);

for (const message of specViolations) {
  reporter.error(message);
}
for (const message of shapeViolations) {
  reporter.error(message);
}
for (const message of reservedWordWarnings) {
  reporter.warn(message);
}

// --- 3. Catalog coverage ----------------------------------------------------
const catalogContent = existsSync(catalogPath)
  ? readFileSync(catalogPath, "utf8")
  : "";
const missingFromCatalog = deriveMissingFromCatalog(skillDirs, catalogContent);

for (const dirName of missingFromCatalog) {
  reporter.error(
    `"${dirName}" has no row in docs/contributing/skills-catalog.md — every ` +
      `skill directory must be mentioned there. Add a row (or a Periodic ` +
      `maintenance-style entry for a newly shipped skill with no usage evidence yet).`,
    { file: "docs/contributing/skills-catalog.md" },
  );
}

// --- 4. Description overlap (informational) ---------------------------------
const overlapping = deriveOverlappingPairs(parsed);
for (const { pair, similarity } of overlapping) {
  reporter.warn(
    `"${pair[0]}" and "${pair[1]}" descriptions overlap ${(similarity * 100).toFixed(0)}% ` +
      `by vocabulary — review whether they compete for the same prose-triggered request.`,
  );
}

reporter.info(
  `Skill frontmatter: ${skills.length} skill(s) checked, ${emptyDescription.length} empty description(s), ` +
    `${nameMismatch.length} name mismatch(es).`,
);
reporter.info(
  `Naming convention: ${specViolations.length} spec violation(s), ${shapeViolations.length} ` +
    `shape violation(s), ${reservedWordWarnings.length} reserved-word warning(s).`,
);
reporter.info(
  `Catalog coverage: ${missingFromCatalog.length} skill(s) missing from skills-catalog.md.`,
);
reporter.info(
  `Description overlap: ${overlapping.length} pair(s) at or above the ${(0.15 * 100).toFixed(0)}% threshold.`,
);

const finishExtra = {
  emptyDescription,
  nameMismatch,
  specViolations,
  shapeViolations,
  reservedWordWarnings,
  missingFromCatalog,
  overlapping,
};

if (
  emptyDescription.length > 0 ||
  nameMismatch.length > 0 ||
  specViolations.length > 0 ||
  shapeViolations.length > 0 ||
  missingFromCatalog.length > 0
) {
  const finalReport = reporter.finish(finishExtra);
  if (!json)
    console.error(
      `\n✗  ${finalReport.errors.length} skill-frontmatter violation(s).`,
    );
  process.exit(1);
}

reporter.succeed(
  `${skills.length} skill(s) valid: descriptions present, names match directories, ` +
    `naming convention followed, catalog coverage complete.`,
);
reporter.finish(finishExtra);
