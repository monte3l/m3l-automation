#!/usr/bin/env node
/**
 * Derives the git-hook cadence from `lefthook.yml` and asserts that the CLAUDE.md
 * "## Commands" cadence table documents exactly the checks each lefthook stage
 * runs — one table row per stage (`pre-commit`, `commit-msg`, `pre-push`), listing
 * the same set of check tokens the hook file runs.
 *
 * Prevents the drift this guard was written to catch: the cadence prose once
 * claimed lint/typecheck/check:api ran pre-commit and build/knip/check:exports ran
 * "pre-publish" — none of which matched `lefthook.yml`. A developer or agent
 * trusting a wrong cadence believes a local hook covers a check that only runs in
 * CI. `check:workflows-doc` guards the CI/CD table the same way; this is its
 * sibling for the hook-stage table.
 *
 * Canonical rule: `lefthook.yml` drives the set; the CLAUDE.md table must match it
 * in both directions per lefthook stage — no check listed for a stage that the hook
 * does not run, and none the hook runs that the table omits. The CI `verify` row is
 * informational (its workflow set is guarded separately by check:workflows-doc) and
 * is not machine-verified here.
 *
 * Exit codes:
 *   0  Table matches lefthook.yml.
 *   1  Drift found, or a file/section could not be parsed.
 *
 * Usage:
 *   node bin/check-cadence-doc.mjs
 *   pnpm check:cadence
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The lefthook stages the CLAUDE.md table is expected to document, keyed by the
// stage name that appears (in backticks) in the table's first column.
const TRACKED_STAGES = ["pre-commit", "commit-msg", "pre-push"];

/**
 * Normalise one check reference to a stable token: strip a leading `pnpm`/
 * `pnpm exec`, a `node bin/…`/`bin/…` wrapper and the `.mjs` suffix, then drop any
 * trailing flags/args. `pnpm format:check` and `format:check` both → `format:check`;
 * `eslint --fix` → `eslint`; `node bin/lint-commit.mjs` → `lint-commit`.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeToken(raw) {
  let token = raw.trim();
  token = token.replace(/^pnpm\s+(?:exec\s+)?/, "");
  token = token.replace(/^node\s+/, "");
  // Drop flags/args before stripping the wrapper so a trailing `--edit {1}` can't
  // leave the `.mjs` un-anchored.
  token = token.split(/\s+/)[0] ?? "";
  return token.replace(/^bin\//, "").replace(/\.mjs$/, "");
}

/**
 * Extract the set of check tokens from one lefthook `run:` command string. Picks
 * up `pnpm <script>` / `pnpm exec <tool>` invocations and `bin/<name>.mjs` scripts.
 *
 * @param {string} runStr
 * @returns {Set<string>}
 */
export function extractRunTokens(runStr) {
  const tokens = new Set();
  for (const m of runStr.matchAll(/pnpm\s+(?:exec\s+)?([a-z0-9:_@./-]+)/g)) {
    tokens.add(normalizeToken(m[1]));
  }
  for (const m of runStr.matchAll(/(?:node\s+)?bin\/([a-z0-9-]+)\.mjs/g)) {
    tokens.add(m[1]);
  }
  return tokens;
}

/**
 * Parse `lefthook.yml` into a map of tracked stage → set of check tokens it runs.
 * Deliberately regex-based (no YAML dependency), matching the style of
 * check-workflows-doc.mjs: it splits on top-level `<stage>:` headers and collects
 * every `run:` value inside each tracked stage block.
 *
 * @param {string} yamlText
 * @returns {Map<string, Set<string>>}
 */
export function parseLefthookStages(yamlText) {
  const stages = new Map();
  const lines = yamlText.split("\n");
  let current = null;
  for (const line of lines) {
    const header = /^([a-z][a-z-]*):\s*$/.exec(line);
    if (header) {
      current = TRACKED_STAGES.includes(header[1]) ? header[1] : null;
      if (current && !stages.has(current)) stages.set(current, new Set());
      continue;
    }
    if (!current) continue;
    const run = /^\s*run:\s*(.+?)\s*$/.exec(line);
    if (run) {
      const set = stages.get(current);
      for (const t of extractRunTokens(run[1])) set.add(t);
    }
  }
  return stages;
}

/**
 * Parse the CLAUDE.md "## Commands" cadence table into a map of tracked stage → set
 * of check tokens documented for it. Only rows whose first cell names a tracked
 * stage and contains `(lefthook)` are read; the CI row is skipped.
 *
 * @param {string} claudeMd
 * @returns {Map<string, Set<string>>}
 */
export function parseCadenceTable(claudeMd) {
  const sectionMatch = /## Commands\n([\s\S]*?)(?:\n## |\n?$)/.exec(claudeMd);
  if (!sectionMatch) {
    throw new Error('could not locate the "## Commands" section in CLAUDE.md');
  }
  const stages = new Map();
  for (const line of sectionMatch[1].split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells: ['', Stage, Checks, Scope, ''] for a well-formed row.
    const [, stageCell, checksCell] = cells;
    if (!stageCell || !checksCell) continue;
    if (!/\(lefthook\)/.test(stageCell)) continue;
    const stage = TRACKED_STAGES.find((s) =>
      new RegExp(`\`${s}\``).test(stageCell),
    );
    if (!stage) continue;
    const tokens = new Set();
    for (const m of checksCell.matchAll(/`([^`]+)`/g)) {
      tokens.add(normalizeToken(m[1]));
    }
    stages.set(stage, tokens);
  }
  return stages;
}

/**
 * Compare the lefthook-derived cadence against the documented cadence and return a
 * list of human-readable drift messages (empty when they match).
 *
 * @param {Map<string, Set<string>>} fromHook
 * @param {Map<string, Set<string>>} fromDoc
 * @returns {string[]}
 */
export function diffCadence(fromHook, fromDoc) {
  const errors = [];
  for (const stage of TRACKED_STAGES) {
    const hook = fromHook.get(stage);
    const doc = fromDoc.get(stage);
    if (!hook) {
      errors.push(`lefthook.yml has no \`${stage}\` stage — cannot verify.`);
      continue;
    }
    if (!doc) {
      errors.push(
        `CLAUDE.md cadence table has no \`${stage}\` (lefthook) row.`,
      );
      continue;
    }
    for (const t of hook) {
      if (!doc.has(t)) {
        errors.push(
          `\`${stage}\`: lefthook.yml runs \`${t}\` but the cadence table omits it.`,
        );
      }
    }
    for (const t of doc) {
      if (!hook.has(t)) {
        errors.push(
          `\`${stage}\`: cadence table lists \`${t}\` but lefthook.yml does not run it.`,
        );
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let errors;
  try {
    const fromHook = parseLefthookStages(
      readFileSync(join(root, "lefthook.yml"), "utf8"),
    );
    const fromDoc = parseCadenceTable(
      readFileSync(join(root, "CLAUDE.md"), "utf8"),
    );
    errors = diffCadence(fromHook, fromDoc);
  } catch (error) {
    console.error(`✗  ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.error(`✗  ${errors.length} cadence-doc mismatch(es):`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log(
    `✓  CLAUDE.md cadence table matches lefthook.yml for ${TRACKED_STAGES.length} stage(s).`,
  );
}
