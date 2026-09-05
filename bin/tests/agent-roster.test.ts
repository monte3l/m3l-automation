import { describe, expect, it } from "vitest";
import {
  MCP_SPOKES,
  deriveMcpGrantIssues,
  parseMcpServers,
} from "../lib/agent-roster.mjs";

describe("parseMcpServers", () => {
  it("parses a single-entry bracketed list", () => {
    expect(parseMcpServers("[context7]")).toEqual(new Set(["context7"]));
  });

  it("parses a multi-entry bracketed list", () => {
    expect(parseMcpServers("[context7, github]")).toEqual(
      new Set(["context7", "github"]),
    );
  });

  it("returns an empty Set for undefined", () => {
    expect(parseMcpServers(undefined)).toEqual(new Set());
  });

  it("returns an empty Set for an empty string", () => {
    expect(parseMcpServers("")).toEqual(new Set());
  });
});

describe("deriveMcpGrantIssues", () => {
  it("flags an mcp__* tool on an agent outside MCP_SPOKES", () => {
    const issues = deriveMcpGrantIssues([
      {
        name: "code-reviewer",
        tools: ["Read", "Grep", "mcp__context7__query-docs"],
        mcpServers: undefined,
        file: ".claude/agents/code-reviewer.md",
      },
    ]);
    expect(issues.ungrantedSpoke).toHaveLength(1);
    expect(issues.ungrantedSpoke[0]).toContain("code-reviewer");
    expect(issues.ungrantedSpoke[0]).toContain("mcp__context7__query-docs");
    expect(issues.unscopedServer).toHaveLength(0);
  });

  it("flags an MCP_SPOKES member's tool whose server isn't in mcpServers:", () => {
    const issues = deriveMcpGrantIssues([
      {
        name: "code-implementer",
        tools: ["Read", "Write", "mcp__github__get_me"],
        mcpServers: "[context7]",
        file: ".claude/agents/code-implementer.md",
      },
    ]);
    expect(issues.unscopedServer).toHaveLength(1);
    expect(issues.unscopedServer[0]).toContain("mcp__github__get_me");
    expect(issues.unscopedServer[0]).toContain("github");
    expect(issues.ungrantedSpoke).toHaveLength(0);
  });

  it("passes an MCP_SPOKES member whose tools all match a declared server", () => {
    const issues = deriveMcpGrantIssues([
      {
        name: "code-implementer",
        tools: [
          "Read",
          "Write",
          "mcp__context7__resolve-library-id",
          "mcp__context7__query-docs",
        ],
        mcpServers: "[context7]",
        file: ".claude/agents/code-implementer.md",
      },
    ]);
    expect(issues.ungrantedSpoke).toHaveLength(0);
    expect(issues.unscopedServer).toHaveLength(0);
  });

  it("ignores an agent with no mcp__* tools regardless of MCP_SPOKES membership", () => {
    const issues = deriveMcpGrantIssues([
      {
        name: "code-reviewer",
        tools: ["Read", "Grep", "Glob", "Bash"],
        mcpServers: undefined,
        file: ".claude/agents/code-reviewer.md",
      },
    ]);
    expect(issues.ungrantedSpoke).toHaveLength(0);
    expect(issues.unscopedServer).toHaveLength(0);
  });

  it("skips an agent whose tools is null (the no-tools: case)", () => {
    const issues = deriveMcpGrantIssues([
      {
        name: "some-agent",
        tools: null,
        mcpServers: undefined,
        file: ".claude/agents/some-agent.md",
      },
    ]);
    expect(issues.ungrantedSpoke).toHaveLength(0);
    expect(issues.unscopedServer).toHaveLength(0);
  });

  it("MCP_SPOKES currently contains exactly code-implementer", () => {
    expect(MCP_SPOKES).toEqual(new Set(["code-implementer"]));
  });
});
