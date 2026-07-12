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
