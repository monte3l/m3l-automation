import { describe, expect, test } from "vitest";
import {
  deriveIntegrationStanceIssues,
  extractFrontmatterBlock,
} from "../lib/integration-stance.mjs";

// ---------------------------------------------------------------------------
// extractFrontmatterBlock
// ---------------------------------------------------------------------------

describe("extractFrontmatterBlock", () => {
  test("returns the text between the first two --- lines", () => {
    const content = "---\nname: foo\ndescription: bar\n---\n\n# Foo\n";
    expect(extractFrontmatterBlock(content)).toBe(
      "name: foo\ndescription: bar",
    );
  });

  test("returns an empty string when the file has no frontmatter block", () => {
    expect(extractFrontmatterBlock("# Foo\n\nNo frontmatter here.")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deriveIntegrationStanceIssues
// ---------------------------------------------------------------------------

describe("deriveIntegrationStanceIssues", () => {
  test("a skill with no gh or GitHub MCP surface is skipped entirely", () => {
    const skills = [
      {
        name: "eslint-flat-config",
        content: "---\nname: eslint-flat-config\n---\n\nNo GitHub here.",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: [],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("a gh-using skill with an ADR-0030 gh-CLI stance note has no issues", () => {
    const skills = [
      {
        name: "triaging-ci",
        content:
          "---\nname: triaging-ci\ndescription: >-\n  Uses the gh CLI (GitHub-integration stance: ADR-0030, amended 2026-07-27).\n---\n\n```bash\ngh run list --limit 5\n```",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: [],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("an MCP-using skill with an ADR-0030 MCP stance note has no issues", () => {
    const skills = [
      {
        name: "resolving-pr-comments",
        content:
          "---\nname: resolving-pr-comments\ndescription: >-\n  GitHub-integration stance: ADR-0030 (amended 2026-07-27) — uses `mcp__github__*` tools rather than the gh CLI.\n---\n\n`mcp__github__list_pull_requests({ owner, repo })`",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: [],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("a gh-using skill with no ADR-0030 reference is flagged missingStanceNote", () => {
    const skills = [
      {
        name: "creating-prs",
        content:
          "---\nname: creating-prs\ndescription: Requires gh CLI authentication.\n---\n\n```bash\ngh pr create --title foo\n```",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: ["creating-prs"],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("flags the retired enterprise-policy claim wherever it appears", () => {
    const skills = [
      {
        name: "triaging-ci",
        content:
          "---\nname: triaging-ci\ndescription: GitHub MCP is blocked by enterprise policy.\n---\n\n```bash\ngh run list\n```",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    expect(result.retiredClaims).toEqual(["triaging-ci"]);
  });

  test("flags a mismatch when the body only uses MCP but the stance note claims the gh CLI", () => {
    const skills = [
      {
        name: "resolving-pr-comments",
        content:
          "---\nname: resolving-pr-comments\ndescription: >-\n  GitHub-integration stance: ADR-0030 — uses the gh CLI.\n---\n\n`mcp__github__list_pull_requests({ owner, repo })`",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    expect(result.mechanismMismatches).toEqual([
      "resolving-pr-comments: body uses mcp__github__ tools but the frontmatter stance note claims the gh CLI",
    ]);
  });

  test("flags a mismatch when the body only uses gh CLI but the stance note claims GitHub MCP", () => {
    const skills = [
      {
        name: "triaging-ci",
        content:
          "---\nname: triaging-ci\ndescription: >-\n  GitHub-integration stance: ADR-0030 — uses `mcp__github__*` tools.\n---\n\n```bash\ngh run list --limit 5\n```",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    expect(result.mechanismMismatches).toEqual([
      "triaging-ci: body uses gh CLI commands but the frontmatter stance note claims GitHub MCP",
    ]);
  });

  test("reports every category simultaneously across multiple skills", () => {
    const skills = [
      {
        name: "no-note",
        content:
          "---\nname: no-note\ndescription: talks to GitHub.\n---\n\n```bash\ngh pr view\n```",
      },
      {
        name: "clean",
        content:
          "---\nname: clean\ndescription: >-\n  GitHub-integration stance: ADR-0030 — uses the gh CLI.\n---\n\n```bash\ngh run view 1\n```",
      },
      {
        name: "retired-claim",
        content:
          "---\nname: retired-claim\ndescription: >-\n  GitHub-integration stance: ADR-0030 — uses the gh CLI. Previously blocked by enterprise policy.\n---\n\n```bash\ngh api foo\n```",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    expect(result.missingStanceNote).toEqual(["no-note"]);
    expect(result.retiredClaims).toEqual(["retired-claim"]);
    expect(result.mechanismMismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveIntegrationStanceIssues — context7 descriptor (ADR-0092)
// ---------------------------------------------------------------------------

describe("deriveIntegrationStanceIssues — context7 descriptor", () => {
  test("a skill with no context7 surface at all is skipped entirely", () => {
    const skills = [
      {
        name: "eslint-flat-config",
        content: "---\nname: eslint-flat-config\n---\n\nNo context7 here.",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: [],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("a context7-using skill with an ADR-0092 stance note has no issues", () => {
    const skills = [
      {
        name: "implementing-submodules",
        content:
          "---\nname: implementing-submodules\ndescription: >-\n  Docs stance: context7 MCP (ADR-0092).\n---\n\n`mcp__context7__query-docs({ libraryId, query })`",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: [],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("a context7-using skill with no ADR-0092 reference is flagged missingStanceNote", () => {
    const skills = [
      {
        name: "reviewing-dependabot-prs",
        content:
          "---\nname: reviewing-dependabot-prs\ndescription: Reviews dependabot PRs.\n---\n\n`mcp__context7__query-docs({ libraryId, query })`",
      },
    ];
    expect(deriveIntegrationStanceIssues(skills)).toEqual({
      missingStanceNote: ["reviewing-dependabot-prs"],
      retiredClaims: [],
      mechanismMismatches: [],
    });
  });

  test("a single-mechanism descriptor never reports a mechanism mismatch", () => {
    const skills = [
      {
        name: "implementing-submodules",
        content:
          "---\nname: implementing-submodules\ndescription: >-\n  Docs stance: uses the gh CLI, not context7 (ADR-0092).\n---\n\n`mcp__context7__resolve-library-id({ name })`",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    expect(result.mechanismMismatches).toEqual([]);
  });

  test("GitHub and context7 descriptors are checked independently on the same skill", () => {
    const skills = [
      {
        name: "creating-prs",
        content:
          "---\nname: creating-prs\ndescription: >-\n  GitHub-integration stance: ADR-0030 — uses the gh CLI.\n---\n\n```bash\ngh pr create --title foo\n```\n\n`mcp__context7__query-docs({ libraryId, query })`",
      },
    ];
    const result = deriveIntegrationStanceIssues(skills);
    // GitHub side is clean (ADR-0030 present, gh CLI declared and used);
    // context7 side has no ADR-0092 reference at all.
    expect(result.missingStanceNote).toEqual(["creating-prs"]);
    expect(result.mechanismMismatches).toEqual([]);
  });
});
