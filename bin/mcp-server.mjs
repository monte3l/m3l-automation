#!/usr/bin/env node
// In-repo MCP server (ADR-0030 Phase 5). Exposes the six repo-maintenance
// tools defined in bin/lib/mcp-tools.mjs — repo_verify, docs_sync,
// worktree_manage, scaffold_script, commit_lint, and catalog_query — to
// Claude Code (and any other MCP client) over stdio, under server name "m3l"
// (so the tools surface as mcp__m3l__<tool>). `catalog_query` is this
// server's interim answer to ADR-0012/0023: instead of an agent reading
// docs/reference/catalog.json + symbol-map.json in full (~11k tokens) to
// answer "which module owns symbol X", it gets a targeted ~50-token lookup.
//
// This file stays a thin composition root by design: every tool's schema,
// description, and handler lives in bin/lib/mcp-tools.mjs so it can be
// smoke-tested by importing that module directly, with no MCP transport
// involved. Nothing here may write to stdout except through the
// StdioServerTransport — any diagnostic goes to stderr, since stdout is the
// JSON-RPC protocol channel over stdio and a stray console.log would corrupt
// every message framed after it.
//
// Usage:
//   node bin/mcp-server.mjs   # connect over stdio (run by an MCP client)
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./lib/mcp-tools.mjs";

/**
 * Construct the server, register every tool from {@link TOOLS}, and connect
 * it over stdio. Exported (rather than only run as a script) so a test can
 * import and exercise the registration loop without spawning a real process.
 *
 * @returns {Promise<InstanceType<typeof McpServer>>}
 */
export async function main() {
  // "1.0.0" is this MCP server's own protocol identity (surfaced to MCP
  // clients during initialize), independent of the workspace's frozen
  // package.json "version" (0.0.0, ADR-0020 — internal, unpublished).
  const server = new McpServer({ name: "m3l", version: "1.0.0" });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
  await server.connect(new StdioServerTransport());
  return server;
}

// Guard the entry point so importing this module (e.g. from a test) never
// connects stdio — only running it directly as `node bin/mcp-server.mjs`
// does. Mirrors the import.meta convention used by .claude/hooks/guard-secret-writes.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error("m3l MCP server failed to start:", cause);
    process.exit(1);
  });
}
