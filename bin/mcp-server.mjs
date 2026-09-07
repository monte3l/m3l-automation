#!/usr/bin/env node
// In-repo MCP server (ADR-0030 Phase 5/6, replaced by ADR-0096). Exposes six
// read-only repo-metadata query tools — adr_query, logs_query,
// commands_query, hooks_query, catalog_query, commit_lint — to Claude Code
// (and any other MCP client) over stdio, under server name "m3l" (so the
// tools surface as mcp__m3l__<tool>).
//
// ADR-0096 replaced the server's original seven CLI-wrapper tools
// (repo_verify, docs_sync, worktree_manage, scaffold_script, spoke_recover)
// after an /auditing pass found zero invocations of any of them across every
// session transcript — the equivalent functionality was already exercised
// through the CLI/Bash path, and every one of those five tools either
// dominated-by an already-unprompted `Bash(pnpm check:*)` wildcard or was a
// pure passthrough. The replacement set answers "which ADR/log/command/hook
// covers X" — questions the audit found agents repeatedly answering by
// reading the ADR corpus, work logs, the command catalog, or the hooks
// reference in full, with no targeted-lookup path.
//
// Dropping every `execFileSync`-based tool also eliminates, as a class, the
// defects that motivated the rebuild: no spawn means no `cwd`-pinning bug
// after a mid-session `EnterWorktree`, no head-of-line blocking on a
// multi-minute child process, no discarded stderr, no timeout/SIGKILL
// escalation to get right. `catalog_query` and `commit_lint` survive
// unchanged in spirit — both already read/validate in-process.
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
import { TOOLS, resolveRepoRoot } from "./lib/mcp-tools.mjs";

// Told to the client at `initialize` (the SDK's `instructions` capability) —
// the one in-protocol discovery affordance the original server never used.
// ADR-0096's own root-cause finding was that nothing anywhere told an agent
// or a skill to reach for these tools over reading the underlying doc/data
// files directly; this string is the server's own answer to that, read by
// every client regardless of what any skill does or doesn't say. Exported
// (not just passed inline) so bin/check-mcp.mjs can assert it is non-empty
// without spawning the server.
export const INSTRUCTIONS =
  "Read-only lookups over this repo's own generated/curated metadata. Prefer " +
  "these over reading the underlying file in full: adr_query instead of " +
  "docs/adr/**, logs_query instead of docs/logs/**, commands_query instead of " +
  "package.json's scripts block, hooks_query instead of " +
  "docs/contributing/hooks-reference.md, catalog_query instead of " +
  "docs/reference/catalog.json + symbol-map.json. commit_lint validates a " +
  "commit message against this repo's commitlint config without creating a " +
  "real commit. None of these tools mutate anything or run a child process — " +
  "for repo-maintenance actions (verify, worktree lifecycle, doc sync, " +
  "scaffolding), use the corresponding `pnpm <script>` command instead.";

/**
 * Construct the server, register every tool from {@link TOOLS}, and connect
 * it over stdio. Exported (rather than only run as a script) so a test can
 * import and exercise the registration loop without spawning a real process.
 *
 * @returns {Promise<InstanceType<typeof McpServer>>}
 */
export async function main() {
  // "2.0.0" is this MCP server's own protocol identity (surfaced to MCP
  // clients during initialize), independent of the workspace's frozen
  // package.json "version" (0.0.0, ADR-0020 — internal, unpublished). Bumped
  // from "1.0.0" for ADR-0096's tool-set replacement — a manual bump, same as
  // the original; `check:mcp` (ADR-0096 PR3) gates against a further silent
  // drift between this string and the registered tool set's actual shape.
  const server = new McpServer(
    { name: "m3l", version: "2.0.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, async (args) => {
      // Resolve the repo root per call, not once at startup — a tool asked
      // right after a mid-session `EnterWorktree` should read the worktree
      // the agent is actually in, not the tree this already-running process
      // happened to load from. Only the tools that read repo files need it;
      // commit_lint validates a string in-process and never asks.
      const repoRoot = tool.needsRoot
        ? await resolveRepoRoot(server)
        : undefined;
      return tool.handler(args, { root: repoRoot });
    });
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
