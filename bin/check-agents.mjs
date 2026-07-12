#!/usr/bin/env node
// Validates the hub-and-spoke subagent configuration:
//   1. Every agent referenced via `subagent_type:` in .claude/skills/** and
//      every spoke listed on the CLAUDE.md "Spokes" line resolves to a real
//      .claude/agents/<name>.md definition OR a known Claude Code built-in.
//   2. The no-nesting invariant holds: no spoke is granted the `Agent` tool
//      (spokes are leaf nodes — only the hub dispatches subagents). A spoke
//      that omits `tools:` would inherit all tools, including `Agent`, so that
//      is rejected too. Every spoke must also declare `disallowedTools: Agent`
//      as defense-in-depth alongside the tools allowlist.
//   3. Least-privilege holds: only the designated writer spokes (see
//      WRITER_SPOKES in bin/lib/agent-roster.mjs — also consumed by the
//      .claude/hooks/guard-readonly-bash.mjs PreToolUse hook, so the roster
//      can't drift between the static check and the runtime restriction) may
//      hold the `Write`/`Edit` tools — every reviewer/research spoke must
//      stay structurally read-only, not just read-only by prompt convention.
//   4. Every agent declares a non-empty `description:` — Claude uses it to
//      decide when to delegate (see https://code.claude.com/docs/en/sub-agents).
//   5. The model-selection matrix holds: every agent's `model:`/`effort:`
//      frontmatter and every `--model` pin in .github/workflows/*.yml matches
//      the MODEL-MATRIX block in docs/contributing/model-selection.md, so the
//      documented tiering and the executing config cannot drift apart. Every
//      model/effort value — in the matrix AND in frontmatter/pins — is also
//      checked against the legal-value lists in bin/lib/claude-models.mjs, so
//      a typo shared by both sides no longer passes silently, and an agent
//      that omits `model:`/`effort:` is rejected with a dedicated message
//      rather than surfacing as a confusing "model: undefined" mismatch.
// It also warns (non-blocking) about agents that are defined but never
// referenced anywhere.
//
// Usage:
//   node bin/check-agents.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isValidAgentModel,
  isValidEffort,
  isValidWorkflowModel,
} from "./lib/claude-models.mjs";
import { WRITER_SPOKES, frontmatter, walk } from "./lib/agent-roster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(root, ".claude/agents");
const skillsDir = join(root, ".claude/skills");
const claudeMd = join(root, "CLAUDE.md");

// Built-in agent types shipped by Claude Code. Most have no definition file;
// `Explore` is the exception — this repo overrides the built-in with a
// project definition (.claude/agents/Explore.md, pinned to `model: haiku`)
// while still being recognized here as a known name.
const BUILTINS = new Set([
  "Explore",
  "Plan",
  "general-purpose",
  "statusline-setup",
  "claude-code-guide",
]);

// --- 1. Catalogue the defined spokes and their tool grants ----------------
const defined = new Map(); // name -> { tools, disallowedTools, model, effort, description, file }
for (const file of walk(agentsDir, (n) => n.endsWith(".md"))) {
  const fm = frontmatter(file);
  if (fm === null || fm.name === undefined) continue;
  const tools =
    fm.tools === undefined
      ? null // no allowlist => inherits ALL tools (including Agent)
      : fm.tools.split(",").map((t) => t.trim());
  const disallowedTools =
    fm.disallowedTools === undefined
      ? []
      : fm.disallowedTools.split(",").map((t) => t.trim());
  defined.set(fm.name, {
    tools,
    disallowedTools,
    model: fm.model,
    effort: fm.effort,
    description: fm.description,
    file,
  });
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
for (const [name, { tools, disallowedTools, file }] of defined) {
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

  // Defense-in-depth: every spoke must also declare `disallowedTools: Agent`
  // explicitly, not just omit "Agent" from its tools allowlist above.
  if (tools !== null && !disallowedTools.includes("Agent")) {
    console.error(
      `✗  ${file.slice(root.length + 1)} (${name}) omits ` +
        `"disallowedTools: Agent" — every spoke must declare this alongside ` +
        `the tools allowlist as defense-in-depth (leaf-node / no-nesting ` +
        `invariant).`,
    );
    errors++;
  }
}

// --- 4b. Least-privilege: only writer spokes may hold Write/Edit tools -----
// Reviewer/research spokes claim to be read-only in their system prompts;
// this makes that contract structural rather than prose-only.
for (const [name, { tools, file }] of defined) {
  if (tools === null || WRITER_SPOKES.has(name)) continue; // 4 already flags null
  const writeTools = tools.filter((t) => t === "Write" || t === "Edit");
  if (writeTools.length > 0) {
    console.error(
      `✗  ${file.slice(root.length + 1)} (${name}) grants ` +
        `${writeTools.join(", ")}, but only ${[...WRITER_SPOKES].join(", ")} ` +
        `may hold write tools — every other spoke must stay structurally ` +
        `read-only.`,
    );
    errors++;
  }
}

// --- 4c. Every spoke must declare a non-empty description ------------------
// Claude uses `description` to decide when to delegate to a spoke — an empty
// or missing one silently breaks automatic/explicit routing.
for (const [name, { description, file }] of defined) {
  if (description === undefined || description.length === 0) {
    console.error(
      `✗  ${file.slice(root.length + 1)} (${name}) omits "description:" ` +
        `frontmatter, or it is empty — every spoke needs one so callers know ` +
        `when to dispatch it.`,
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
const matrixAgents = new Map(); // agent name -> { model, effort }
const matrixWorkflows = new Map(); // workflow file -> { model, effort }
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
      /^\|\s*(agent|workflow)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
    let row;
    while ((row = rowRe.exec(block[1])) !== null) {
      const [, surface, name, model, effort] = row;
      if (surface === "agent") {
        matrixAgents.set(name, { model, effort });
        if (!isValidAgentModel(model)) {
          console.error(
            `✗  MODEL-MATRIX row for agent "${name}" pins "model: ${model}", ` +
              `which is not a legal subagent model (see AGENT_MODEL_ALIASES ` +
              `in bin/lib/claude-models.mjs).`,
          );
          errors++;
        }
        if (!isValidEffort(effort)) {
          console.error(
            `✗  MODEL-MATRIX row for agent "${name}" pins "effort: ${effort}", ` +
              `which is not a legal effort level (see EFFORT_LEVELS in ` +
              `bin/lib/claude-models.mjs).`,
          );
          errors++;
        }
      } else {
        matrixWorkflows.set(name, { model, effort });
        if (!isValidWorkflowModel(model)) {
          console.error(
            `✗  MODEL-MATRIX row for workflow "${name}" pins "model: ${model}", ` +
              `which is not a legal workflow model (see WORKFLOW_MODEL_ALIASES ` +
              `in bin/lib/claude-models.mjs).`,
          );
          errors++;
        }
      }
    }

    // 5a. Agent frontmatter <-> matrix, both directions.
    for (const [name, { model, effort, file }] of defined) {
      const relFile = file.slice(root.length + 1);
      if (model === undefined) {
        console.error(
          `✗  ${relFile} (${name}) omits "model:" frontmatter — every agent ` +
            `must pin an explicit tier (see docs/contributing/model-selection.md).`,
        );
        errors++;
      } else if (!isValidAgentModel(model)) {
        console.error(
          `✗  ${relFile} (${name}) declares "model: ${model}", which is not ` +
            `a legal subagent model (see AGENT_MODEL_ALIASES in ` +
            `bin/lib/claude-models.mjs).`,
        );
        errors++;
      }
      if (effort === undefined) {
        console.error(
          `✗  ${relFile} (${name}) omits "effort:" frontmatter — every agent ` +
            `must pin an explicit level (see docs/contributing/model-selection.md).`,
        );
        errors++;
      } else if (!isValidEffort(effort)) {
        console.error(
          `✗  ${relFile} (${name}) declares "effort: ${effort}", which is not ` +
            `a legal effort level (see EFFORT_LEVELS in bin/lib/claude-models.mjs).`,
        );
        errors++;
      }

      const expected = matrixAgents.get(name);
      if (expected === undefined) {
        console.error(
          `✗  ${relFile} (${name}) has no row in the MODEL-MATRIX block of ` +
            `docs/contributing/model-selection.md.`,
        );
        errors++;
        continue;
      }
      if (model !== undefined && model !== expected.model) {
        console.error(
          `✗  ${relFile} (${name}) declares "model: ${model}" but ` +
            `docs/contributing/model-selection.md pins "${expected.model}".`,
        );
        errors++;
      }
      if (effort !== undefined && effort !== expected.effort) {
        console.error(
          `✗  ${relFile} (${name}) declares "effort: ${effort}" but ` +
            `docs/contributing/model-selection.md pins "${expected.effort}".`,
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
    const pinRe = /--model[= ]([\w.@:[\]-]+)/g;
    const pinned = new Map(); // workflow file -> Set of pinned models
    for (const file of walk(workflowsDir, (n) => n.endsWith(".yml"))) {
      const name = file.slice(workflowsDir.length + 1);
      const content = readFileSync(file, "utf8");
      let pin;
      while ((pin = pinRe.exec(content)) !== null) {
        if (!pinned.has(name)) pinned.set(name, new Set());
        pinned.get(name).add(pin[1]);
        if (!isValidWorkflowModel(pin[1])) {
          console.error(
            `✗  .github/workflows/${name} pins "--model ${pin[1]}", which is ` +
              `not a legal workflow model (see WORKFLOW_MODEL_ALIASES in ` +
              `bin/lib/claude-models.mjs).`,
          );
          errors++;
        }
        const expected = matrixWorkflows.get(name);
        if (expected === undefined) {
          console.error(
            `✗  .github/workflows/${name} pins "--model ${pin[1]}" but has no ` +
              `row in the MODEL-MATRIX block of docs/contributing/model-selection.md.`,
          );
          errors++;
        } else if (pin[1] !== expected.model) {
          console.error(
            `✗  .github/workflows/${name} pins "--model ${pin[1]}" but ` +
              `docs/contributing/model-selection.md pins "${expected.model}".`,
          );
          errors++;
        }
      }
    }
    for (const [name, { model }] of matrixWorkflows) {
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
