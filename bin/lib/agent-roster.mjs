// Shared source of truth for the defined `.claude/agents/*.md` roster: the
// frontmatter parser, a directory walker, and which spokes are writers vs
// read-only. Consumed by bin/check-agents.mjs (the static governance checks)
// and .claude/hooks/guard-readonly-bash.mjs (the runtime Bash restriction),
// so the "which agents are read-only" answer can never drift between the two
// enforcement points.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Spokes permitted to hold the `Write`/`Edit` tools. Every other defined
 * agent is a reviewer/research spoke and must stay structurally read-only.
 */
export const WRITER_SPOKES = new Set(["code-implementer", "test-author"]);

/**
 * Spokes permitted to hold any `mcp__*` tool grant (ADR-0093's selective,
 * not-blanket, spoke-access invariant) — every other agent must stay
 * MCP-free. Consumed by `bin/check-agents.mjs`'s MCP-grant check alongside
 * {@link parseMcpServers}/{@link deriveMcpGrantIssues}, so "which spokes may
 * reach an MCP server" has one answer instead of a convention nothing
 * enforces.
 */
export const MCP_SPOKES = new Set(["code-implementer"]);

/**
 * Reviewer spokes whose findings report is a per-section Must-fix/Should-fix/
 * Nits list, the shape `REVIEW.md`'s numeric finding cap fits. Consumed by
 * `bin/check-review-policy.mjs` so the enforced set can't silently diverge
 * from the roster `REVIEW.md`'s "Where this is enforced" table documents.
 * Deliberately excludes `docs-consistency-reviewer` (a fixed 6-check PASS/
 * FAIL report, not a severity-tiered list) and `spec-conformance-reviewer`
 * (promises never to truncate a Missing/Drifted/Unmet-contract finding,
 * which a numeric cap would contradict) — see `REVIEW.md` for the rationale.
 */
export const SEVERITY_CAPPED_SPOKES = new Set([
  "code-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-analyzer",
]);

/**
 * The turn-budget ceiling every spoke's `maxTurns:` frontmatter is checked
 * against (`bin/check-agents.mjs`). Raising a spoke's `maxTurns` is not the
 * fix for truncation (`.claude/rules/subagent-dispatch.md`'s "Don't raise
 * maxTurns as the fix" rule) — decompose the dispatch instead. Referenced by
 * name (not the literal number) in `.claude/hooks/detect-spoke-
 * truncation.mjs` and `.claude/hooks/guard-writer-dispatch-journal.mjs`'s
 * rationale comments, so neither can silently drift from this value the way
 * two independent hardcoded "40"s could.
 */
export const MAX_TURNS_CEILING = 40;

/**
 * Extract the YAML frontmatter block (between the first two `---` lines).
 *
 * @param {string} filePath
 * @returns {Record<string, string> | null}
 */
export function frontmatter(filePath) {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv !== null) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

/**
 * Recursively collect files under `dir` whose name matches `predicate`.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {string[]}
 */
export function walk(dir, predicate) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Names of every defined agent under `agentsDir` (.claude/agents/*.md) that
 * is NOT in {@link WRITER_SPOKES} — the structurally read-only reviewer/
 * research roster (includes the `Explore` override, since it has its own
 * definition file and is not a writer spoke).
 *
 * @param {string} agentsDir Absolute path to .claude/agents/
 * @returns {Set<string>}
 */
export function readOnlyAgentNames(agentsDir) {
  const names = new Set();
  for (const file of walk(agentsDir, (n) => n.endsWith(".md"))) {
    const fm = frontmatter(file);
    if (fm === null || fm.name === undefined) continue;
    if (!WRITER_SPOKES.has(fm.name)) names.add(fm.name);
  }
  return names;
}

/**
 * Parse an agent's `mcpServers:` frontmatter value (e.g. `[context7]` or
 * `[context7, github]`) into a Set of server names. Undefined or empty input
 * yields an empty Set — the "grants no MCP server" case.
 *
 * @param {string | undefined} value
 * @returns {Set<string>}
 */
export function parseMcpServers(value) {
  if (value === undefined || value.trim().length === 0) return new Set();
  const inner = value.match(/\[(.*)\]/)?.[1] ?? value;
  return new Set(
    inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * @typedef {{
 *   name: string,
 *   tools: string[] | null,
 *   mcpServers: string | undefined,
 *   file: string,
 * }} McpGrantCandidate
 * @typedef {{ ungrantedSpoke: string[], unscopedServer: string[] }} McpGrantIssues
 */

/**
 * Derive violations of ADR-0093's selective-spoke-access invariant: only
 * {@link MCP_SPOKES} members may hold any `mcp__*` tool in `tools:`, and a
 * member may only hold a tool scoped to a server it also declares via its own
 * `mcpServers:` frontmatter — so a grant can't silently widen to a second
 * server without both frontmatter fields agreeing.
 *
 * @param {McpGrantCandidate[]} agents
 * @returns {McpGrantIssues}
 */
export function deriveMcpGrantIssues(agents) {
  /** @type {McpGrantIssues} */
  const issues = { ungrantedSpoke: [], unscopedServer: [] };
  for (const { name, tools, mcpServers, file } of agents) {
    if (tools === null) continue; // no-`tools:` case is check-agents.mjs's own error
    const mcpTools = tools.filter((t) => t.startsWith("mcp__"));
    if (mcpTools.length === 0) continue;

    if (!MCP_SPOKES.has(name)) {
      issues.ungrantedSpoke.push(
        `${file}: "${name}" grants ${mcpTools.join(", ")} but is not in MCP_SPOKES`,
      );
      continue;
    }

    const declaredServers = parseMcpServers(mcpServers);
    for (const tool of mcpTools) {
      const server = tool.split("__")[1];
      if (server === undefined || !declaredServers.has(server)) {
        issues.unscopedServer.push(
          `${file}: "${name}" grants "${tool}" but does not declare server "${server}" in mcpServers:`,
        );
      }
    }
  }
  return issues;
}
