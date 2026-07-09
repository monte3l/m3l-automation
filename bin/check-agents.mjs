#!/usr/bin/env node
// Validates the hub-and-spoke subagent configuration:
//   1. Every agent referenced via `subagent_type:` in .claude/skills/** and
//      every spoke listed on the CLAUDE.md "Spokes" line resolves to a real
//      .claude/agents/<name>.md definition OR a known Claude Code built-in.
//   2. The no-nesting invariant holds: no spoke is granted the `Agent` tool
//      (spokes are leaf nodes — only the hub dispatches subagents). A spoke
//      that omits `tools:` would inherit all tools, including `Agent`, so that
//      is rejected too.
//   3. The model-selection matrix holds: every agent's `model:` frontmatter
//      and every `--model` pin in .github/workflows/*.yml matches the
//      MODEL-MATRIX block in docs/contributing/model-selection.md, so the
//      documented tiering and the executing config cannot drift apart.
// It also warns (non-blocking) about agents that are defined but never
// referenced anywhere.
//
// Usage:
//   node bin/check-agents.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(root, ".claude/agents");
const skillsDir = join(root, ".claude/skills");
const claudeMd = join(root, "CLAUDE.md");

// Built-in agent types shipped by Claude Code; these have no definition file.
const BUILTINS = new Set([
  "Explore",
  "Plan",
  "general-purpose",
  "statusline-setup",
  "claude-code-guide",
]);

/** Extract the YAML frontmatter block (between the first two `---` lines). */
function frontmatter(filePath) {
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

/** Recursively collect files under `dir` whose name matches `predicate`. */
function walk(dir, predicate) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

// --- 1. Catalogue the defined spokes and their tool grants ----------------
const defined = new Map(); // name -> { tools: string[] | null, model, file }
for (const file of walk(agentsDir, (n) => n.endsWith(".md"))) {
  const fm = frontmatter(file);
  if (fm === null || fm.name === undefined) continue;
  const tools =
    fm.tools === undefined
      ? null // no allowlist => inherits ALL tools (including Agent)
      : fm.tools.split(",").map((t) => t.trim());
  defined.set(fm.name, { tools, model: fm.model, file });
}

const known = new Set([...defined.keys(), ...BUILTINS]);

let errors = 0;
const referenced = new Set();

// --- 2. Explicit references from skills (`subagent_type: "<name>"`) --------
// These are canonical dispatch sites, so an unknown name here is an error.
const refRe = /subagent_type:\s*["']?([A-Za-z0-9_-]+)["']?/g;
const skillFiles = walk(skillsDir, (n) => n.endsWith(".md"));
for (const file of skillFiles) {
  const content = readFileSync(file, "utf8");
  let m;
  while ((m = refRe.exec(content)) !== null) {
    const name = m[1];
    referenced.add(name);
    if (!known.has(name)) {
      console.error(
        `✗  ${file.slice(root.length + 1)} references subagent_type "${name}" ` +
          `which is not a defined agent (.claude/agents/) or a known built-in.`,
      );
      errors++;
    }
  }
}

// --- 3. The CLAUDE.md "Spokes" list (the canonical roster) -----------------
// The bullet wraps across several physical lines, so collect the whole block.
if (existsSync(claudeMd)) {
  const lines = readFileSync(claudeMd, "utf8").split("\n");
  const start = lines.findIndex((l) => /\bSpokes\b/.test(l) && l.includes("`"));
  if (start !== -1) {
    let block = lines[start];
    for (let i = start + 1; i < lines.length; i++) {
      // Continuation lines are indented; a new top-level bullet or blank ends it.
      if (/^\s+\S/.test(lines[i])) block += "\n" + lines[i];
      else break;
    }
    // The roster only lives in the bullet's first sentence; later sentences
    // are free-form prose (e.g. "... every `subagent_type` resolves ...")
    // that may backtick-quote non-agent words. A sentence boundary is a
    // `.`/`!`/`?` followed by whitespace and a capital letter — this skips
    // false breaks like the period in `` `.claude/agents/*.md` ``, which
    // isn't followed by a space.
    const rosterEnd = block.search(/[.!?]\s+(?=[A-Z])/);
    const roster = rosterEnd === -1 ? block : block.slice(0, rosterEnd + 1);
    for (const m of roster.matchAll(/`([A-Za-z0-9_-]+)`/g)) {
      const name = m[1];
      referenced.add(name);
      if (!known.has(name)) {
        console.error(
          `✗  CLAUDE.md Spokes list names "${name}" which is not a defined ` +
            `agent or a known built-in.`,
        );
        errors++;
      }
    }
  }
}

// --- 3b. Prose backtick mentions (skills + CLAUDE.md) ----------------------
// Skills dispatch spokes in prose (e.g. `code-reviewer`), not only via
// subagent_type. Count any backtick mention of a DEFINED agent as a reference
// so the unused-agent warning below stays meaningful. Limited to known names
// to avoid treating arbitrary code spans as agent references.
for (const file of [
  ...skillFiles,
  ...(existsSync(claudeMd) ? [claudeMd] : []),
]) {
  const content = readFileSync(file, "utf8");
  for (const m of content.matchAll(/`([A-Za-z0-9_-]+)`/g)) {
    if (defined.has(m[1])) referenced.add(m[1]);
  }
}

// --- 4. No-nesting invariant: no spoke may hold the `Agent` tool -----------
for (const [name, { tools, file }] of defined) {
  if (tools === null) {
    console.error(
      `✗  ${file.slice(root.length + 1)} (${name}) omits "tools:", so it ` +
        `inherits ALL tools including "Agent". Spokes must declare an ` +
        `allowlist that excludes "Agent" (leaf-node / no-nesting invariant).`,
    );
    errors++;
  } else if (tools.includes("Agent")) {
    console.error(
      `✗  ${file.slice(root.length + 1)} (${name}) grants the "Agent" tool. ` +
        `Spokes are leaf nodes — only the hub dispatches subagents.`,
    );
    errors++;
  }
}

// --- 5. Model-selection matrix (docs/contributing/model-selection.md) ------
// The matrix's MODEL-MATRIX block is the single source of truth for which
// model each spoke and workflow runs on; frontmatter and workflow pins must
// match it exactly (see the "Enforcement" section of that doc).
const matrixDoc = join(root, "docs/contributing/model-selection.md");
const workflowsDir = join(root, ".github/workflows");
const matrixAgents = new Map(); // agent name -> model alias
const matrixWorkflows = new Map(); // workflow file -> pinned model
if (!existsSync(matrixDoc)) {
  console.error(
    "✗  docs/contributing/model-selection.md is missing — the model matrix " +
      "is required (see its Enforcement section).",
  );
  errors++;
} else {
  const doc = readFileSync(matrixDoc, "utf8");
  const block = doc.match(
    /<!-- BEGIN MODEL-MATRIX -->([\s\S]*?)<!-- END MODEL-MATRIX -->/,
  );
  if (block === null) {
    console.error(
      "✗  docs/contributing/model-selection.md lacks the MODEL-MATRIX block.",
    );
    errors++;
  } else {
    const rowRe =
      /^\|\s*(agent|workflow)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
    let row;
    while ((row = rowRe.exec(block[1])) !== null) {
      const [, surface, name, model] = row;
      if (surface === "agent") matrixAgents.set(name, model);
      else matrixWorkflows.set(name, model);
    }

    // 5a. Agent frontmatter <-> matrix, both directions.
    for (const [name, { model, file }] of defined) {
      const expected = matrixAgents.get(name);
      if (expected === undefined) {
        console.error(
          `✗  ${file.slice(root.length + 1)} (${name}) has no row in the ` +
            `MODEL-MATRIX block of docs/contributing/model-selection.md.`,
        );
        errors++;
      } else if (model !== expected) {
        console.error(
          `✗  ${file.slice(root.length + 1)} (${name}) declares "model: ${model}" ` +
            `but docs/contributing/model-selection.md pins "${expected}".`,
        );
        errors++;
      }
    }
    for (const name of matrixAgents.keys()) {
      if (!defined.has(name)) {
        console.error(
          `✗  MODEL-MATRIX row names agent "${name}" which has no ` +
            `.claude/agents/ definition.`,
        );
        errors++;
      }
    }

    // 5b. Workflow --model pins <-> matrix, both directions.
    const pinRe = /--model[= ]([\w.@:-]+)/g;
    const pinned = new Map(); // workflow file -> Set of pinned models
    for (const file of walk(workflowsDir, (n) => n.endsWith(".yml"))) {
      const name = file.slice(workflowsDir.length + 1);
      const content = readFileSync(file, "utf8");
      let pin;
      while ((pin = pinRe.exec(content)) !== null) {
        if (!pinned.has(name)) pinned.set(name, new Set());
        pinned.get(name).add(pin[1]);
        const expected = matrixWorkflows.get(name);
        if (expected === undefined) {
          console.error(
            `✗  .github/workflows/${name} pins "--model ${pin[1]}" but has no ` +
              `row in the MODEL-MATRIX block of docs/contributing/model-selection.md.`,
          );
          errors++;
        } else if (pin[1] !== expected) {
          console.error(
            `✗  .github/workflows/${name} pins "--model ${pin[1]}" but ` +
              `docs/contributing/model-selection.md pins "${expected}".`,
          );
          errors++;
        }
      }
    }
    for (const [name, model] of matrixWorkflows) {
      if (!pinned.has(name)) {
        console.error(
          `✗  MODEL-MATRIX row pins workflow "${name}" to "${model}" but that ` +
            `workflow has no --model pin (or does not exist).`,
        );
        errors++;
      }
    }
  }
}

// --- 6. Warn (non-blocking) on defined-but-unreferenced agents -------------
for (const name of defined.keys()) {
  if (!referenced.has(name)) {
    console.warn(
      `⚠  agent "${name}" is defined but never referenced in skills or the ` +
        `CLAUDE.md Spokes line.`,
    );
  }
}

if (errors > 0) {
  console.error(`\n✗  ${errors} subagent configuration violation(s).`);
  process.exit(1);
}

console.log(
  `✓  ${defined.size} spokes valid: references resolve, none grant "Agent", ` +
    `and the model matrix (${matrixAgents.size} agents, ${matrixWorkflows.size} ` +
    `workflows) is in sync.`,
);
