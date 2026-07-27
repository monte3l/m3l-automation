// Pure derivation for `bin/check-github-stance.mjs` (the ADR-0030 amendment's
// drift gate). Nothing here reads a filesystem — the CLI wrapper collects
// `.claude/skills/*/SKILL.md` file contents and hands them to
// `deriveGithubStanceIssues`, mirroring `bin/lib/command-catalog.mjs`'s
// gen/check-shared-derivation shape so this stays exercisable in tests
// without spawning anything.
//
// What it guards against — the exact way the repo's GitHub-integration
// stance has drifted before (ADR-0030's 2026-07-27 amendment):
//   1. A skill that talks to GitHub (via `gh` or GitHub MCP) with no pointer
//      back to the governing ADR — the "blocked by enterprise policy" claim
//      survived for months with nothing to catch it.
//   2. That exact retired claim (or an equivalent) reappearing anywhere.
//   3. A stance note that names the wrong mechanism — e.g. claiming "uses the
//      gh CLI" for a skill whose body only calls `mcp__github__*` tools, or
//      vice versa.
// A stale or inaccurate *description* of what a skill does otherwise is a
// review-time concern (same reasoning as `command-catalog.mjs`'s STRUCTURE-only
// scope) — this only checks the GitHub-mechanism claim specifically.

const GH_COMMAND_PATTERN = /\bgh (?:pr|api|run|repo|auth|issue|project)\b/;
const MCP_GITHUB_PATTERN = /mcp__github__/;
const RETIRED_CLAIM_PATTERN = /blocked by enterprise policy/i;
const ADR_REFERENCE_PATTERN = /ADR-0030/;
const DECLARES_MCP_PATTERN = /uses `?mcp__github__|full github mcp coverage/i;
const DECLARES_GH_PATTERN = /gh cli/i;

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

/**
 * Extract the YAML frontmatter block (the raw text between the first two
 * `---` lines) as one string. Skill `description` fields are YAML folded/
 * literal block scalars (`>-`/`|`) spanning many lines, so this returns the
 * whole block rather than parsing per-field key/value pairs the way
 * `bin/lib/agent-roster.mjs`'s `frontmatter()` does for the simpler
 * single-line agent frontmatter.
 *
 * @param {string} content
 * @returns {string} the frontmatter block, or `""` if the file has none
 */
export function extractFrontmatterBlock(content) {
  const match = content.match(FRONTMATTER_PATTERN);
  return match === null ? "" : match[1];
}

/**
 * The file content with its frontmatter block stripped — where actual `gh`/
 * `mcp__github__` *usage* lives (steps, code blocks). Kept separate from the
 * frontmatter so a stance note merely *naming* a tool (e.g. "uses
 * `mcp__github__*` tools" in its own description) isn't misread as the skill
 * actually calling it — only the body is evidence of real usage.
 *
 * @param {string} content
 * @returns {string}
 */
function stripFrontmatter(content) {
  return content.replace(FRONTMATTER_PATTERN, "");
}

/**
 * @typedef {{ name: string, content: string }} SkillFile
 * @typedef {{
 *   missingStanceNote: string[],
 *   retiredClaims: string[],
 *   mechanismMismatches: string[],
 * }} GithubStanceIssues
 */

/**
 * Derive every GitHub-integration-stance drift issue across a set of skill
 * files. Skills with no `gh`/GitHub-MCP surface at all are skipped entirely —
 * this only constrains skills that actually talk to GitHub.
 *
 * @param {SkillFile[]} skills
 * @returns {GithubStanceIssues}
 */
export function deriveGithubStanceIssues(skills) {
  /** @type {GithubStanceIssues} */
  const issues = {
    missingStanceNote: [],
    retiredClaims: [],
    mechanismMismatches: [],
  };

  for (const { name, content } of skills) {
    if (RETIRED_CLAIM_PATTERN.test(content)) {
      issues.retiredClaims.push(name);
    }

    const body = stripFrontmatter(content);
    const bodyHasGh = GH_COMMAND_PATTERN.test(body);
    const bodyHasMcp = MCP_GITHUB_PATTERN.test(body);
    if (!bodyHasGh && !bodyHasMcp) continue;

    const frontmatterBlock = extractFrontmatterBlock(content);
    if (!ADR_REFERENCE_PATTERN.test(frontmatterBlock)) {
      issues.missingStanceNote.push(name);
      continue;
    }

    const declaresMcp = DECLARES_MCP_PATTERN.test(frontmatterBlock);
    const declaresGh =
      !declaresMcp && DECLARES_GH_PATTERN.test(frontmatterBlock);

    if (bodyHasMcp && !bodyHasGh && declaresGh) {
      issues.mechanismMismatches.push(
        `${name}: body uses mcp__github__ tools but the frontmatter stance note claims the gh CLI`,
      );
    }
    if (bodyHasGh && !bodyHasMcp && declaresMcp) {
      issues.mechanismMismatches.push(
        `${name}: body uses gh CLI commands but the frontmatter stance note claims GitHub MCP`,
      );
    }
  }

  return issues;
}
