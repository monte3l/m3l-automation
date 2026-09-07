// Unit tests for bin/check-mcp.mjs's three pure exported functions —
// validateMcpJsonEntry, reconcileToolAllowlist, validateToolAnnotations.
// ADR-0096's audit found the m3l MCP server had zero runtime verification of
// any kind; this gate closes that for the three static-declaration checks
// (the fourth, INSTRUCTIONS non-empty, is a one-line check inlined in the
// script's main guard and not a separately exported function). Each guard
// clause below is mutation-tested per tests.md — see the final report for
// what was mutated and what was observed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  reconcileToolAllowlist,
  validateMcpJsonEntry,
  validateToolAnnotations,
} from "../check-mcp.mjs";
import { TOOLS } from "../lib/mcp-tools.mjs";

// bin/check-mcp.mjs computes `root` via repoRoot(import.meta.url) from its
// own location (bin/check-mcp.mjs), i.e. the repo root. This test file lives
// one directory deeper (bin/tests/), so the same repo root needs one extra
// dirname() hop from here — same pattern as adr-claims.test.ts /
// check-file-budget.test.ts.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

type McpJsonFixture = {
  mcpServers?: Record<string, { type?: unknown; args?: unknown }>;
};

const alwaysExists = () => true;
const neverExists = () => false;

// ---------------------------------------------------------------------------
// validateMcpJsonEntry
// ---------------------------------------------------------------------------

describe("validateMcpJsonEntry", () => {
  test("happy path: valid stdio entry naming an existing *mcp-server.mjs → no errors", () => {
    const mcpJson: McpJsonFixture = {
      mcpServers: { m3l: { type: "stdio", args: ["bin/mcp-server.mjs"] } },
    };
    expect(validateMcpJsonEntry(mcpJson, alwaysExists)).toEqual([]);
  });

  test("no 'mcpServers.m3l' entry at all → single error, no further checks attempted", () => {
    const mcpJson: McpJsonFixture = { mcpServers: {} };
    const errors = validateMcpJsonEntry(mcpJson, alwaysExists);
    expect(errors).toEqual(['.mcp.json has no "mcpServers.m3l" entry.']);
  });

  test("mcpJson itself undefined → the same missing-entry error, not a throw", () => {
    const errors = validateMcpJsonEntry(undefined, alwaysExists);
    expect(errors).toEqual(['.mcp.json has no "mcpServers.m3l" entry.']);
  });

  test("wrong type ('sse' instead of 'stdio') → error naming the actual value", () => {
    const mcpJson: McpJsonFixture = {
      mcpServers: { m3l: { type: "sse", args: ["bin/mcp-server.mjs"] } },
    };
    const errors = validateMcpJsonEntry(mcpJson, alwaysExists);
    expect(errors).toEqual([
      '.mcp.json\'s "mcpServers.m3l.type" is "sse" — expected "stdio".',
    ]);
  });

  test("args does not name any *mcp-server.mjs file → error", () => {
    const mcpJson: McpJsonFixture = {
      mcpServers: {
        m3l: { type: "stdio", args: ["bin/some-other-script.mjs"] },
      },
    };
    const errors = validateMcpJsonEntry(mcpJson, alwaysExists);
    expect(errors).toEqual([
      '.mcp.json\'s "mcpServers.m3l.args" does not name a *mcp-server.mjs script.',
    ]);
  });

  test("args is missing entirely (not an array) → the same 'does not name' error, not a throw", () => {
    const mcpJson: McpJsonFixture = { mcpServers: { m3l: { type: "stdio" } } };
    const errors = validateMcpJsonEntry(mcpJson, alwaysExists);
    expect(errors).toEqual([
      '.mcp.json\'s "mcpServers.m3l.args" does not name a *mcp-server.mjs script.',
    ]);
  });

  test("args names a *mcp-server.mjs script that does not exist per fileExists → error naming the path", () => {
    const mcpJson: McpJsonFixture = {
      mcpServers: {
        m3l: { type: "stdio", args: ["bin/missing-mcp-server.mjs"] },
      },
    };
    const errors = validateMcpJsonEntry(mcpJson, neverExists);
    expect(errors).toEqual([
      '.mcp.json\'s "mcpServers.m3l" points at "bin/missing-mcp-server.mjs", which does not exist.',
    ]);
  });

  test("wrong type AND a nonexistent script → both errors reported together", () => {
    const mcpJson: McpJsonFixture = {
      mcpServers: {
        m3l: { type: "http", args: ["bin/missing-mcp-server.mjs"] },
      },
    };
    const errors = validateMcpJsonEntry(mcpJson, neverExists);
    expect(errors).toHaveLength(2);
    expect(errors).toContain(
      '.mcp.json\'s "mcpServers.m3l.type" is "http" — expected "stdio".',
    );
    expect(errors).toContain(
      '.mcp.json\'s "mcpServers.m3l" points at "bin/missing-mcp-server.mjs", which does not exist.',
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileToolAllowlist
// ---------------------------------------------------------------------------

describe("reconcileToolAllowlist", () => {
  const tools = [{ name: "adr_query" }, { name: "logs_query" }];

  test("happy path: allowlist matches TOOLS exactly → no errors", () => {
    const allowlist = ["mcp__m3l__adr_query", "mcp__m3l__logs_query"];
    expect(reconcileToolAllowlist(tools, allowlist)).toEqual([]);
  });

  test("a registered tool missing from the allowlist → error naming it, needing a prompt on every call", () => {
    const allowlist = ["mcp__m3l__adr_query"];
    const errors = reconcileToolAllowlist(tools, allowlist);
    expect(errors).toEqual([
      '.claude/settings.json\'s permissions.allow is missing "mcp__m3l__logs_query" (registered in TOOLS).',
    ]);
  });

  test("a stale allowlist entry naming a dropped/renamed tool → error naming it", () => {
    const allowlist = [
      "mcp__m3l__adr_query",
      "mcp__m3l__logs_query",
      "mcp__m3l__repo_verify",
    ];
    const errors = reconcileToolAllowlist(tools, allowlist);
    expect(errors).toEqual([
      '.claude/settings.json\'s permissions.allow lists "mcp__m3l__repo_verify" but TOOLS has no such tool (dropped or renamed?).',
    ]);
  });

  test("missing AND stale simultaneously (PR2's real drift shape) → both errors present", () => {
    const allowlist = ["mcp__m3l__adr_query", "mcp__m3l__repo_verify"];
    const errors = reconcileToolAllowlist(tools, allowlist);
    expect(errors).toHaveLength(2);
    expect(errors).toContain(
      '.claude/settings.json\'s permissions.allow is missing "mcp__m3l__logs_query" (registered in TOOLS).',
    );
    expect(errors).toContain(
      '.claude/settings.json\'s permissions.allow lists "mcp__m3l__repo_verify" but TOOLS has no such tool (dropped or renamed?).',
    );
  });

  test("non-mcp__m3l__-prefixed permission strings are ignored entirely, not misread as tool entries", () => {
    const allowlist = [
      "mcp__m3l__adr_query",
      "mcp__m3l__logs_query",
      "Bash(pnpm verify)",
      "mcp__context7__resolve-library-id",
    ];
    expect(reconcileToolAllowlist(tools, allowlist)).toEqual([]);
  });

  test("an empty tools array against a non-empty allowlist → every allowlist entry is stale", () => {
    const errors = reconcileToolAllowlist([], ["mcp__m3l__adr_query"]);
    expect(errors).toEqual([
      '.claude/settings.json\'s permissions.allow lists "mcp__m3l__adr_query" but TOOLS has no such tool (dropped or renamed?).',
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateToolAnnotations
// ---------------------------------------------------------------------------

describe("validateToolAnnotations", () => {
  test("happy path: compliant tool → no errors", () => {
    const tools = [
      {
        name: "adr_query",
        config: {
          title: "Query the ADR corpus",
          annotations: { readOnlyHint: true },
        },
      },
    ];
    expect(validateToolAnnotations(tools)).toEqual([]);
  });

  test("readOnlyHint explicitly false → error", () => {
    const tools = [
      {
        name: "adr_query",
        config: { title: "x", annotations: { readOnlyHint: false } },
      },
    ];
    expect(validateToolAnnotations(tools)).toEqual([
      'Tool "adr_query" does not declare readOnlyHint: true.',
    ]);
  });

  test("annotations object absent entirely → readOnlyHint error, not a throw", () => {
    const tools = [{ name: "adr_query", config: { title: "x" } }];
    expect(validateToolAnnotations(tools)).toEqual([
      'Tool "adr_query" does not declare readOnlyHint: true.',
    ]);
  });

  test("title missing entirely → error", () => {
    const tools = [
      { name: "adr_query", config: { annotations: { readOnlyHint: true } } },
    ];
    expect(validateToolAnnotations(tools)).toEqual([
      'Tool "adr_query" has no non-empty "title".',
    ]);
  });

  test("title is an empty string → error, distinct from 'missing'", () => {
    const tools = [
      {
        name: "adr_query",
        config: { title: "", annotations: { readOnlyHint: true } },
      },
    ];
    expect(validateToolAnnotations(tools)).toEqual([
      'Tool "adr_query" has no non-empty "title".',
    ]);
  });

  test("both readOnlyHint and title violated on one tool → both errors reported for it", () => {
    const tools = [{ name: "adr_query", config: {} }];
    const errors = validateToolAnnotations(tools);
    expect(errors).toHaveLength(2);
    expect(errors).toContain(
      'Tool "adr_query" does not declare readOnlyHint: true.',
    );
    expect(errors).toContain('Tool "adr_query" has no non-empty "title".');
  });

  test("multiple tools, only one violating → errors scoped to the offending tool only", () => {
    const tools = [
      {
        name: "good_tool",
        config: { title: "Good", annotations: { readOnlyHint: true } },
      },
      {
        name: "bad_tool",
        config: { title: "", annotations: { readOnlyHint: true } },
      },
    ];
    expect(validateToolAnnotations(tools)).toEqual([
      'Tool "bad_tool" has no non-empty "title".',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live-fixture check: all three functions against this repo's own real,
// committed .mcp.json / .claude/settings.json / TOOLS. This is the check
// that would have caught PR2's real allowlist drift (repo_verify still
// listed, four new tool names missing) had it existed then.
// ---------------------------------------------------------------------------

describe("live repo state (would have caught PR2's real allowlist drift)", () => {
  test("the real .mcp.json's m3l entry validates with zero errors", () => {
    const mcpJson = JSON.parse(
      readFileSync(join(root, ".mcp.json"), "utf8"),
    ) as McpJsonFixture;
    const errors = validateMcpJsonEntry(mcpJson, (rel) =>
      existsSync(join(root, rel)),
    );
    expect(errors).toEqual([]);
  });

  test("the real TOOLS reconciles with zero errors against .claude/settings.json's live allowlist", () => {
    const settings = JSON.parse(
      readFileSync(join(root, ".claude", "settings.json"), "utf8"),
    ) as { permissions?: { allow?: unknown } };
    const allowlist = Array.isArray(settings.permissions?.allow)
      ? (settings.permissions.allow as string[])
      : [];
    expect(reconcileToolAllowlist(TOOLS, allowlist)).toEqual([]);
  });

  test("the real TOOLS all carry readOnlyHint: true and a non-empty title", () => {
    expect(validateToolAnnotations(TOOLS)).toEqual([]);
  });
});
