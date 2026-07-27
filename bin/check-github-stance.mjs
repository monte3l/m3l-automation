#!/usr/bin/env node
// Verifies every `.claude/skills/*/SKILL.md` that talks to GitHub (via the gh
// CLI or GitHub MCP) carries a pointer to the governing ADR-0030 amendment,
// contains no retired policy claim, and names the mechanism it actually uses
// — the drift gate ADR-0030's 2026-07-27 amendment introduced after auditing
// found the repo's prior "GitHub MCP blocked by enterprise policy" claim had
// survived, unchecked, for months in two skills.
//
// Usage:
//   node bin/check-github-stance.mjs   # exits 0 on success, 1 on any drift
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/agent-roster.mjs";
import { deriveGithubStanceIssues } from "./lib/github-stance.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, ".claude", "skills");

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const skillFiles = walk(skillsDir, (name) => name === "SKILL.md");
const skills = skillFiles.map((file) => ({
  name: relative(skillsDir, file).split("/")[0],
  content: readFileSync(file, "utf8"),
}));

const { missingStanceNote, retiredClaims, mechanismMismatches } =
  deriveGithubStanceIssues(skills);

for (const name of missingStanceNote) {
  reporter.error(
    `"${name}" talks to GitHub (gh CLI or GitHub MCP) but its SKILL.md frontmatter carries no ADR-0030 stance reference. Add a "GitHub-integration stance: ADR-0030 (amended 2026-07-27) — ..." line.`,
  );
}
for (const name of retiredClaims) {
  reporter.error(
    `"${name}" asserts the retired "GitHub MCP blocked by enterprise policy" claim. ADR-0030 retired this — remove it and cite the current stance instead.`,
  );
}
for (const message of mechanismMismatches) {
  reporter.error(`Mechanism mismatch: ${message}.`);
}

if (
  missingStanceNote.length > 0 ||
  retiredClaims.length > 0 ||
  mechanismMismatches.length > 0
) {
  reporter.finish({ missingStanceNote, retiredClaims, mechanismMismatches });
  process.exit(1);
}

reporter.succeed(
  `GitHub-integration stance is consistent across ${skills.length} skill(s).`,
);
reporter.finish({ missingStanceNote, retiredClaims, mechanismMismatches });
