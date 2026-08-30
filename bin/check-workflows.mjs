#!/usr/bin/env node
/**
 * Validates the `.claude/workflows/` dynamic-workflow surface against the
 * MODEL-MATRIX block in docs/contributing/model-selection.md (ADR-0025
 * prerequisite 1) and enforces the per-script agent-count guardrail
 * (prerequisite 2).
 *
 * Not to be confused with its name-sibling bin/check-workflows-doc.mjs
 * (`check:workflows-doc`), which reconciles the docs/contributing/ci-cd.md
 * CI/CD table against `.github/workflows/` — that one guards GitHub Actions
 * documentation; this one guards Claude Code dynamic-workflow scripts. The
 * two are deliberately separate checks; never merge them as "redundant."
 *
 * Canonical rules (R1–R8), documented in the "Enforcement" section of
 * docs/contributing/model-selection.md:
 *   R1 every `workflow-script` matrix row names an existing script file;
 *   R2 every script has exactly one file-level matrix row;
 *   R3 every `model:`/`effort:` string literal in a script matches one of the
 *      file's matrix rows;
 *   R4 every per-step matrix row's model/effort/label appears in its script
 *      (no stale step rows);
 *   R5 every matrix row and script literal pins a legal model/effort value
 *      (file-level rows may carry `n/a` effort);
 *   R6 `model:`/`effort:` values must be string literals — a dynamic value
 *      cannot be statically audited;
 *   R7 every script declares `// max-agents: <N>` near the top, with
 *      1 <= N <= MAX_WORKFLOW_AGENTS;
 *   R8 every `agentType:` string literal names a defined `.claude/agents/*.md`
 *      spoke (R8a), and when that spoke is structurally read-only
 *      (bin/lib/agent-roster.mjs's `readOnlyAgentNames()`), the script must
 *      not carry a write-instruction phrase for it (R8b — see Known
 *      limitations; this is the rule that would have caught
 *      audit-fanout.js instructing a read-only Explore spoke to write a
 *      scratchpad file, docs/logs/2026-07-16-audit-fanout-workflow.md).
 *
 * Known limitations (deliberately regex-based — no JS-parser dependency):
 * - the scan sees the whole file, so the tokens `model:` / `effort:` /
 *   `agentType:` must not appear in a workflow script's prose, comments, or
 *   schema property names; rephrase instead.
 * - R3/R4 check literal presence, not call-site association: a step row's
 *   model/effort/label each only need to appear somewhere in the file, so two
 *   `agent()` calls with swapped model-to-label pairings still pass. Binding a
 *   literal to its specific call would need a real JS parser; PR review
 *   remains the guard for that association.
 * - R8b is prose-matching over the whole file, not bound to the specific
 *   `agentType:` call site — a false positive is possible if unrelated prose
 *   happens to match a write-instruction pattern, and a differently-worded
 *   write instruction can evade it. It is a heuristic safety net, not a
 *   guarantee; R8a (the literal-names-a-real-agent check) is the load-bearing
 *   half of R8.
 *
 * Exit codes:
 *   0  Surface matches the matrix (trivially valid when no scripts exist).
 *   1  Drift found, or the matrix block could not be parsed.
 *
 * Usage:
 *   node bin/check-workflows.mjs
 *   pnpm check:workflows
 */
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isValidEffort, isValidWorkflowModel } from "./lib/claude-models.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import { frontmatter, readOnlyAgentNames, walk } from "./lib/agent-roster.mjs";

/**
 * R8b's write-instruction phrase list — a small, explicit denylist (see the
 * module header's "Known limitations" entry for why this stays a heuristic
 * rather than a call-site-bound check).
 */
const WRITE_INSTRUCTION_PATTERNS = [
  /write your .*? to .*?\.md/i,
  /to exactly this file/i,
];

/**
 * Every agent name defined under `.claude/agents/*.md` — the R8a "does this
 * agentType literal name a real spoke" universe. Reuses the same
 * `walk`/`frontmatter` primitives `readOnlyAgentNames()` is built from
 * (bin/lib/agent-roster.mjs), so the two can't drift apart.
 *
 * @param {string} agentsDir Absolute path to .claude/agents/
 * @returns {Set<string>}
 */
export function definedAgentNames(agentsDir) {
  const names = new Set();
  for (const file of walk(agentsDir, (n) => n.endsWith(".md"))) {
    const fm = frontmatter(file);
    if (fm !== null && fm.name !== undefined) names.add(fm.name);
  }
  return names;
}

const root = repoRoot(import.meta.url);

/**
 * Ceiling for a workflow script's declared `// max-agents:` budget — the
 * repo-level agent-count guardrail from ADR-0025 (prerequisite 2), anchored to
 * the Workflow tool's own "large workflow" warning threshold (>25 agents).
 * The companion >1.5M projected-token half of that threshold is advisory
 * prose in docs/contributing/model-selection.md — tokens are not statically
 * checkable.
 */
export const MAX_WORKFLOW_AGENTS = 25;

/** How many leading lines may carry the `// max-agents:` header (R7). */
const MAX_AGENTS_HEADER_WINDOW = 10;

/**
 * Extract every `<prop>: "<value>"` string literal from a workflow script's
 * source, and count occurrences whose value is anything other than a plain
 * string literal (identifier, ternary, template literal, …) as dynamic.
 *
 * @param {string} source
 * @param {"model" | "effort"} prop
 * @returns {{ literals: string[], dynamicCount: number }}
 */
export function extractPropLiterals(source, prop) {
  const literals = [];
  let dynamicCount = 0;
  const site = new RegExp(`\\b${prop}\\s*:\\s*(?=(\\S))`, "g");
  for (const match of source.matchAll(site)) {
    const rest = source.slice(match.index + match[0].length);
    const literal = /^(["'])([^"']*)\1/.exec(rest);
    if (literal) literals.push(literal[2]);
    else dynamicCount++;
  }
  return { literals, dynamicCount };
}

/**
 * Parse the `// max-agents: <N>` guardrail header (R7) from the first
 * {@link MAX_AGENTS_HEADER_WINDOW} lines of a workflow script. Returns `null`
 * when the header is absent or malformed.
 *
 * @param {string} source
 * @returns {number | null}
 */
export function extractMaxAgents(source) {
  const head = source.split("\n").slice(0, MAX_AGENTS_HEADER_WINDOW);
  for (const line of head) {
    const match = /^\s*\/\/\s*max-agents:\s*(\d+)\s*$/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * A parsed `workflow-script` MODEL-MATRIX row. `label` is `null` for a
 * file-level row (`` `<file>` ``) and the step label for a per-step override
 * row (`` `<file>:<label>` ``).
 *
 * @typedef {{ name: string, file: string, label: string | null,
 *             model: string, effort: string }} WorkflowScriptRow
 */

/**
 * Extract every `workflow-script` row from the MODEL-MATRIX block of
 * docs/contributing/model-selection.md. Rows with surface `agent` or
 * `workflow` belong to bin/check-agents.mjs §5 and are ignored here — and,
 * symmetrically, that check's `(agent|workflow)` row regex cannot match
 * `workflow-script`, so neither check double-reads the other's rows.
 *
 * @param {string} docText
 * @returns {WorkflowScriptRow[]}
 */
export function parseWorkflowScriptRows(docText) {
  const block =
    /<!-- BEGIN MODEL-MATRIX -->([\s\S]*?)<!-- END MODEL-MATRIX -->/.exec(
      docText,
    );
  if (block === null) {
    throw new Error(
      "could not locate the MODEL-MATRIX block in docs/contributing/model-selection.md",
    );
  }
  const rows = [];
  const rowRe =
    /^\|\s*workflow-script\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
  let row;
  while ((row = rowRe.exec(block[1])) !== null) {
    const [, name, model, effort] = row;
    const colon = name.indexOf(":");
    rows.push({
      name,
      file: colon === -1 ? name : name.slice(0, colon),
      label: colon === -1 ? null : name.slice(colon + 1),
      model,
      effort,
    });
  }
  return rows;
}

/**
 * Validate the workflow-script surface (rules R1–R7) and return a list of
 * human-readable violations (empty when the surface is clean).
 *
 * @param {Map<string, string>} scripts  filename → source for every
 *   `.claude/workflows/*.js|*.mjs` file (empty Map when the directory is
 *   absent — the surface is then trivially valid, but R1 still runs).
 * @param {WorkflowScriptRow[]} rows
 * @param {{ definedNames: Set<string>, readOnlyNames: Set<string> } | null} [agentRoster]
 *   R8's agent-name universe. `null` (the default) skips R8 entirely — used
 *   by callers (unit tests) that don't need the agent-roster dependency.
 * @returns {string[]}
 */
export function validateWorkflowSurface(scripts, rows, agentRoster = null) {
  const errors = [];

  for (const row of rows) {
    if (!scripts.has(row.file)) {
      errors.push(
        `MODEL-MATRIX workflow-script row \`${row.name}\` names ` +
          `"${row.file}", which does not exist under .claude/workflows/ (R1).`,
      );
    }
    if (!isValidWorkflowModel(row.model)) {
      errors.push(
        `MODEL-MATRIX workflow-script row \`${row.name}\` pins ` +
          `"${row.model}", which is not a legal workflow model (R5 — see ` +
          `WORKFLOW_MODEL_ALIASES in bin/lib/claude-models.mjs).`,
      );
    }
    const effortLegal =
      isValidEffort(row.effort) || (row.label === null && row.effort === "n/a");
    if (!effortLegal) {
      errors.push(
        `MODEL-MATRIX workflow-script row \`${row.name}\` pins effort ` +
          `"${row.effort}", which is not a legal effort level (R5 — only a ` +
          `file-level row may carry \`n/a\`).`,
      );
    }
  }

  for (const [file, source] of scripts) {
    const fileRows = rows.filter((r) => r.file === file);
    const fileLevel = fileRows.filter((r) => r.label === null);
    if (fileLevel.length !== 1) {
      errors.push(
        `.claude/workflows/${file} has ${fileLevel.length} file-level ` +
          `workflow-script row(s) in the MODEL-MATRIX block — exactly one ` +
          `is required (R2).`,
      );
    }

    for (const prop of /** @type {const} */ (["model", "effort"])) {
      const { literals, dynamicCount } = extractPropLiterals(source, prop);
      if (dynamicCount > 0) {
        errors.push(
          `.claude/workflows/${file} has ${dynamicCount} non-literal ` +
            `\`${prop}:\` value(s) — model/effort must be string literals so ` +
            `the surface stays statically auditable (R6).`,
        );
      }
      const allowed = new Set(
        fileRows.map((r) => (prop === "model" ? r.model : r.effort)),
      );
      for (const literal of new Set(literals)) {
        const legal =
          prop === "model"
            ? isValidWorkflowModel(literal)
            : isValidEffort(literal);
        if (!legal) {
          errors.push(
            `.claude/workflows/${file} pins \`${prop}: ${literal}\`, which ` +
              `is not a legal ${prop === "model" ? "workflow model" : "effort level"} ` +
              `(R5 — see bin/lib/claude-models.mjs).`,
          );
          continue;
        }
        if (!allowed.has(literal)) {
          errors.push(
            `.claude/workflows/${file} pins \`${prop}: ${literal}\` but no ` +
              `workflow-script matrix row for the file carries it (R3).`,
          );
        }
      }
      for (const stepRow of fileRows) {
        if (stepRow.label === null) continue;
        const want = prop === "model" ? stepRow.model : stepRow.effort;
        if (!literals.includes(want)) {
          errors.push(
            `MODEL-MATRIX step row \`${stepRow.name}\` pins \`${prop}: ` +
              `${want}\` but .claude/workflows/${file} never carries that ` +
              `literal — stale step row (R4).`,
          );
        }
      }
    }

    for (const stepRow of fileRows) {
      if (stepRow.label === null) continue;
      if (
        !source.includes(`"${stepRow.label}"`) &&
        !source.includes(`'${stepRow.label}'`)
      ) {
        errors.push(
          `MODEL-MATRIX step row \`${stepRow.name}\` names label ` +
            `"${stepRow.label}", which never appears as a string literal in ` +
            `.claude/workflows/${file} (R4).`,
        );
      }
    }

    const maxAgents = extractMaxAgents(source);
    if (maxAgents === null) {
      errors.push(
        `.claude/workflows/${file} lacks a \`// max-agents: <N>\` header in ` +
          `its first ${MAX_AGENTS_HEADER_WINDOW} lines (R7 guardrail).`,
      );
    } else if (maxAgents < 1 || maxAgents > MAX_WORKFLOW_AGENTS) {
      errors.push(
        `.claude/workflows/${file} declares \`max-agents: ${maxAgents}\`, ` +
          `outside the allowed 1..${MAX_WORKFLOW_AGENTS} (R7 guardrail).`,
      );
    }

    if (agentRoster !== null) {
      const { literals: agentTypes } = extractPropLiterals(source, "agentType");
      for (const literal of new Set(agentTypes)) {
        if (!agentRoster.definedNames.has(literal)) {
          errors.push(
            `.claude/workflows/${file} dispatches \`agentType: "${literal}"\`, ` +
              `which names no defined agent under .claude/agents/ (R8a).`,
          );
          continue;
        }
        if (agentRoster.readOnlyNames.has(literal)) {
          const hit = WRITE_INSTRUCTION_PATTERNS.find((p) => p.test(source));
          if (hit !== undefined) {
            errors.push(
              `.claude/workflows/${file} dispatches read-only agent ` +
                `\`agentType: "${literal}"\` alongside a write-instruction ` +
                `phrase matching ${hit} — a read-only spoke cannot write a ` +
                `file (R8b).`,
            );
          }
        }
      }
    }
  }

  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  let errors;
  let scripts;
  let rows;
  try {
    rows = parseWorkflowScriptRows(
      readFileSync(join(root, "docs/contributing/model-selection.md"), "utf8"),
    );
    scripts = new Map();
    const dir = join(root, ".claude", "workflows");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (/\.(?:js|mjs)$/.test(name)) {
          scripts.set(name, readFileSync(join(dir, name), "utf8"));
        }
      }
    }
    const agentsDir = join(root, ".claude", "agents");
    const agentRoster = {
      definedNames: definedAgentNames(agentsDir),
      readOnlyNames: readOnlyAgentNames(agentsDir),
    };
    errors = validateWorkflowSurface(scripts, rows, agentRoster);
  } catch (error) {
    reporter.error(error instanceof Error ? error.message : String(error));
    reporter.finish();
    process.exit(1);
  }
  if (errors.length > 0) {
    if (!json) {
      console.error(`✗  ${errors.length} workflow-surface violation(s):`);
    }
    for (const e of errors) reporter.error(e);
    reporter.finish();
    process.exit(1);
  }
  reporter.succeed(
    `.claude/workflows surface valid (${scripts.size} script(s), ` +
      `${rows.length} workflow-script matrix row(s)).`,
  );
  reporter.finish();
}
