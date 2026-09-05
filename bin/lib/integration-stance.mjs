// Pure derivation for `bin/check-integration-stance.mjs` (the ADR-0030 and
// ADR-0092 drift gates). Nothing here reads a filesystem — the CLI wrapper
// collects `.claude/skills/*/SKILL.md` file contents and hands them to
// `deriveIntegrationStanceIssues`, mirroring `bin/lib/command-catalog.mjs`'s
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
// ADR-0092 (documentation lookup via context7) generalized this from a single
// GitHub-shaped check to a table of `INTEGRATION_DESCRIPTORS` — one entry per
// governed external-integration surface — so a second integration (docs
// lookup) reuses the same missing-stance-note / retired-claim / mismatch
// machinery instead of a hand-rolled copy. context7 has exactly one
// mechanism (its MCP server), so no mismatch check applies to it; the
// mismatch machinery only activates for a descriptor with 2+ mechanisms.
//
// A stale or inaccurate *description* of what a skill does otherwise is a
// review-time concern (same reasoning as `command-catalog.mjs`'s STRUCTURE-only
// scope) — this only checks the governed-mechanism claim specifically.

/**
 * @typedef {{
 *   id: string,
 *   usagePattern: RegExp,
 *   declaresPattern: RegExp,
 *   usagePhrase: string,
 *   claimPhrase: string,
 * }} IntegrationMechanism
 * @typedef {{
 *   id: string,
 *   adrPattern: RegExp,
 *   mechanisms: IntegrationMechanism[],
 *   retiredClaimPattern?: RegExp,
 * }} IntegrationDescriptor
 */

/**
 * Not exported: no caller needs the table directly — `deriveIntegrationStanceIssues`'s
 * default parameter is the only consumer, and a test wanting to exercise a
 * single descriptor in isolation passes its own array via that same parameter.
 * @type {IntegrationDescriptor[]}
 */
const INTEGRATION_DESCRIPTORS = [
  {
    id: "github",
    adrPattern: /ADR-0030/,
    retiredClaimPattern: /blocked by enterprise policy/i,
    mechanisms: [
      // Order matters: mirrors the original precedence (MCP checked before
      // gh) so a stance note that names both — e.g. "uses mcp__github__*
      // tools rather than the gh CLI" — declares MCP, not gh, exactly as
      // the pre-generalization code did.
      {
        id: "github-mcp",
        usagePattern: /mcp__github__/,
        declaresPattern: /uses `?mcp__github__|full github mcp coverage/i,
        usagePhrase: "mcp__github__ tools",
        claimPhrase: "GitHub MCP",
      },
      {
        id: "gh-cli",
        usagePattern: /\bgh (?:pr|api|run|repo|auth|issue|project)\b/,
        declaresPattern: /gh cli/i,
        usagePhrase: "gh CLI commands",
        claimPhrase: "the gh CLI",
      },
    ],
  },
  {
    id: "context7",
    adrPattern: /ADR-0092/,
    mechanisms: [
      {
        id: "context7-mcp",
        usagePattern: /mcp__context7__/,
        declaresPattern: /mcp__context7__|context7 mcp/i,
        usagePhrase: "mcp__context7__ tools",
        claimPhrase: "the context7 MCP",
      },
    ],
  },
];

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
 * The file content with its frontmatter block stripped — where actual
 * mechanism *usage* lives (steps, code blocks). Kept separate from the
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
 * }} IntegrationStanceIssues
 */

/**
 * `missingStanceNote` entries are `"<skill name> (<descriptor id>)"`, not a
 * bare skill name — a skill missing the stance for two descriptors at once
 * (e.g. GitHub and context7) gets two distinct, actionable entries rather
 * than a literal duplicate of the same string.
 */

/**
 * Derive every integration-stance drift issue across a set of skill files,
 * checked independently against every descriptor in {@link INTEGRATION_DESCRIPTORS}
 * (or a caller-supplied override, for testing one descriptor in isolation).
 * A skill with no usage surface for a given descriptor is skipped for it
 * entirely — this only constrains skills that actually use the mechanism a
 * descriptor governs.
 *
 * @param {SkillFile[]} skills
 * @param {IntegrationDescriptor[]} [descriptors]
 * @returns {IntegrationStanceIssues}
 */
export function deriveIntegrationStanceIssues(
  skills,
  descriptors = INTEGRATION_DESCRIPTORS,
) {
  /** @type {IntegrationStanceIssues} */
  const issues = {
    missingStanceNote: [],
    retiredClaims: [],
    mechanismMismatches: [],
  };

  for (const { name, content } of skills) {
    const body = stripFrontmatter(content);
    const frontmatterBlock = extractFrontmatterBlock(content);
    let flaggedRetired = false;

    for (const descriptor of descriptors) {
      if (
        !flaggedRetired &&
        descriptor.retiredClaimPattern !== undefined &&
        descriptor.retiredClaimPattern.test(content)
      ) {
        issues.retiredClaims.push(name);
        flaggedRetired = true;
      }

      const usedMechanisms = descriptor.mechanisms.filter((m) =>
        m.usagePattern.test(body),
      );
      if (usedMechanisms.length === 0) continue;

      if (!descriptor.adrPattern.test(frontmatterBlock)) {
        // Keyed by descriptor id, not just the skill name: a skill using
        // both GitHub and context7 surfaces with neither ADR referenced
        // gets two distinct, actionable entries here rather than a
        // literal duplicate of the same string.
        issues.missingStanceNote.push(`${name} (${descriptor.id})`);
        continue;
      }

      // Nothing to mismatch against with a single-mechanism descriptor
      // (e.g. context7, which has only its MCP server) — declaresPattern
      // on a lone mechanism is forward-looking config for a future second
      // mechanism, never evaluated while mechanisms.length < 2.
      if (descriptor.mechanisms.length < 2) continue;

      // First-match-wins, in descriptor order — mirrors the pre-
      // generalization precedence where an MCP-declaring stance note is
      // never misread as also declaring gh, even when its own prose
      // mentions "gh CLI" in passing (e.g. "... rather than the gh CLI").
      const declared = descriptor.mechanisms.find((m) =>
        m.declaresPattern.test(frontmatterBlock),
      );

      if (
        usedMechanisms.length === 1 &&
        declared !== undefined &&
        declared.id !== usedMechanisms[0].id
      ) {
        issues.mechanismMismatches.push(
          `${name}: body uses ${usedMechanisms[0].usagePhrase} but the frontmatter stance note claims ${declared.claimPhrase}`,
        );
      }
    }
  }

  return issues;
}
