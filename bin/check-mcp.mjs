#!/usr/bin/env node
// Reconciles the m3l MCP server's three independent declarations —
// .mcp.json's "m3l" entry, the registered TOOLS array (bin/lib/mcp-tools.mjs),
// and .claude/settings.json's mcp__m3l__* permission allowlist — and asserts
// the Anthropic MCP-directory baseline (readOnlyHint + title) on every tool,
// plus a non-empty server `instructions` string (bin/mcp-server.mjs).
//
// ADR-0096's audit found the m3l server was the least-gated executable
// artifact in the repo — no check:*, no smoke start, no tools/list assertion,
// no reconciliation of TOOLS against the settings allowlist. This gate closes
// that: it is the same class of wiring check check:hooks/check:agents already
// run for hooks and subagents, applied to the one remaining executable
// surface that had none. Its first run against this repo caught real drift:
// PR2's tool-set replacement (repo_verify/docs_sync/worktree_manage/
// scaffold_script/spoke_recover -> adr_query/logs_query/commands_query/
// hooks_query, keeping catalog_query/commit_lint) had left
// .claude/settings.json's allowlist still naming the dropped `repo_verify`
// and missing three of the four new tools.
//
// Usage:
//   node bin/check-mcp.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import { TOOLS } from "./lib/mcp-tools.mjs";
import { INSTRUCTIONS } from "./mcp-server.mjs";

const MCP_JSON_REL = ".mcp.json";
const SETTINGS_JSON_REL = ".claude/settings.json";
const MCP_TOOL_PREFIX = "mcp__m3l__";

/**
 * Validate the `.mcp.json` "m3l" server entry: present, stdio-typed, and its
 * `args` name a real `*mcp-server.mjs` file on disk. A typo'd path here
 * silently disables the server client-side with no error surfaced anywhere
 * else — the client just never sees an `m3l` server at all.
 *
 * @param {{ mcpServers?: Record<string, { type?: unknown, args?: unknown }> } | undefined} mcpJson parsed .mcp.json
 * @param {(relPath: string) => boolean} fileExists
 * @returns {string[]} error messages, empty when valid
 */
export function validateMcpJsonEntry(mcpJson, fileExists) {
  const errors = [];
  const entry = mcpJson?.mcpServers?.m3l;
  if (entry === undefined) {
    errors.push(`${MCP_JSON_REL} has no "mcpServers.m3l" entry.`);
    return errors;
  }
  if (entry.type !== "stdio") {
    errors.push(
      `${MCP_JSON_REL}'s "mcpServers.m3l.type" is ${JSON.stringify(entry.type)} — expected "stdio".`,
    );
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  const scriptArg = args.find(
    (a) => typeof a === "string" && a.endsWith("mcp-server.mjs"),
  );
  if (typeof scriptArg !== "string") {
    errors.push(
      `${MCP_JSON_REL}'s "mcpServers.m3l.args" does not name a *mcp-server.mjs script.`,
    );
  } else if (!fileExists(scriptArg)) {
    errors.push(
      `${MCP_JSON_REL}'s "mcpServers.m3l" points at "${scriptArg}", which does not exist.`,
    );
  }
  return errors;
}

/**
 * Diff the registered {@link TOOLS} array against
 * `.claude/settings.json`'s `mcp__m3l__*` permission allowlist, in both
 * directions — a registered tool with no allowlist entry needs a permission
 * prompt on every call; an allowlist entry naming a tool that no longer
 * exists is dead weight left over from a prior tool-set change.
 *
 * @param {{ name: string }[]} tools
 * @param {string[]} allowlist the full `permissions.allow` array
 * @returns {string[]} error messages, empty when the two sets match exactly
 */
export function reconcileToolAllowlist(tools, allowlist) {
  const errors = [];
  const toolNames = new Set(tools.map((t) => t.name));
  const allowedM3lTools = new Set(
    allowlist
      .filter((a) => a.startsWith(MCP_TOOL_PREFIX))
      .map((a) => a.slice(MCP_TOOL_PREFIX.length)),
  );
  for (const name of toolNames) {
    if (!allowedM3lTools.has(name)) {
      errors.push(
        `${SETTINGS_JSON_REL}'s permissions.allow is missing ` +
          `"${MCP_TOOL_PREFIX}${name}" (registered in TOOLS).`,
      );
    }
  }
  for (const name of allowedM3lTools) {
    if (!toolNames.has(name)) {
      errors.push(
        `${SETTINGS_JSON_REL}'s permissions.allow lists ` +
          `"${MCP_TOOL_PREFIX}${name}" but TOOLS has no such tool (dropped ` +
          "or renamed?).",
      );
    }
  }
  return errors;
}

/**
 * Assert the Anthropic MCP-directory baseline annotations on every tool:
 * `readOnlyHint: true` and a non-empty `title`. Every m3l tool is a pure
 * filesystem read (ADR-0096) so `readOnlyHint` is factually true here, not
 * merely a policy checkbox — it is also what lets a client auto-batch or
 * auto-approve the call.
 *
 * @param {{ name: string, config: { title?: unknown, annotations?: Record<string, unknown> } }[]} tools
 * @returns {string[]} error messages, empty when every tool is compliant
 */
export function validateToolAnnotations(tools) {
  const errors = [];
  for (const tool of tools) {
    if (tool.config.annotations?.["readOnlyHint"] !== true) {
      errors.push(`Tool "${tool.name}" does not declare readOnlyHint: true.`);
    }
    if (
      typeof tool.config.title !== "string" ||
      tool.config.title.length === 0
    ) {
      errors.push(`Tool "${tool.name}" has no non-empty "title".`);
    }
  }
  return errors;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const mcpJsonPath = join(root, MCP_JSON_REL);
  const settingsPath = join(root, SETTINGS_JSON_REL);

  /** @type {string[]} */
  const errors = [];

  if (!existsSync(mcpJsonPath)) {
    errors.push(`${MCP_JSON_REL} does not exist.`);
  } else {
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    errors.push(
      ...validateMcpJsonEntry(mcpJson, (rel) => existsSync(join(root, rel))),
    );
  }

  if (!existsSync(settingsPath)) {
    errors.push(`${SETTINGS_JSON_REL} does not exist.`);
  } else {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const allowlist = Array.isArray(settings.permissions?.allow)
      ? settings.permissions.allow
      : [];
    errors.push(...reconcileToolAllowlist(TOOLS, allowlist));
  }

  errors.push(...validateToolAnnotations(TOOLS));

  if (typeof INSTRUCTIONS !== "string" || INSTRUCTIONS.length === 0) {
    errors.push("bin/mcp-server.mjs's INSTRUCTIONS is empty or not a string.");
  }

  for (const error of errors) {
    reporter.error(error, { file: MCP_JSON_REL });
  }

  if (errors.length > 0) {
    if (!json) console.error(`\n✗  ${errors.length} MCP wiring violation(s).`);
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    `m3l MCP server wiring valid: ${TOOLS.length} tool(s) reconciled across ` +
      `${MCP_JSON_REL}, TOOLS, and ${SETTINGS_JSON_REL}'s allowlist.`,
  );
  reporter.finish();
}
