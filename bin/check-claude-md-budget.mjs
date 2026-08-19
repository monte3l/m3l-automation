#!/usr/bin/env node
// Guards CLAUDE.md's always-loaded runtime content against silent regrowth.
// CLAUDE.md is injected in full into every session AND into every custom
// subagent launch (Explore/Plan skip it, but this repo's spoke roster does
// not) — its size is paid repeatedly per session, not once. Anthropic's
// stated guidance is that this isn't just a token-cost concern: "Longer
// files consume more context and reduce adherence" (docs.claude.com/en/
// memory), target under ~200 lines.
//
// Block-level HTML comments (`<!-- ... -->`) are stripped before CLAUDE.md is
// injected into context, so maintainer notes inside them cost nothing at
// runtime — this script strips them the same way before measuring, so
// documentation living in comments never counts against the budget.
//
// Deliberately measures CLAUDE.md only, not the ancestor/global CLAUDE.md
// hierarchy or `.claude/rules/*.md` — those are out of this repo's control
// or already load conditionally.
//
// Usage:
//   node bin/check-claude-md-budget.mjs   # verify (fails over budget)
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

export const MAX_RUNTIME_LINES = 200;
export const MAX_APPROX_TOKENS = 3000;
export const MAX_TABLE_LINE_WIDTH = 200;

/**
 * Strip block-level HTML comments the same way Claude Code strips them before
 * injecting CLAUDE.md into context — anything inside `<!-- ... -->` costs
 * zero runtime tokens, so it must not count toward the budget.
 *
 * Repeats the strip to a fixed point rather than a single pass: a single
 * non-greedy pass over adjacent/nested `<!--`/`-->` markers (e.g.
 * `<!--<!---->`) can leave a dangling `<!--` behind, which a later read of
 * this "sanitized" text could misinterpret as still-open markup (CodeQL
 * js/incomplete-multi-character-sanitization).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBlockComments(text) {
  let previous;
  let result = text;
  do {
    previous = result;
    result = result.replace(/<!--[\s\S]*?-->/g, "");
  } while (result !== previous);
  return result;
}

/**
 * Collapse runs of 3+ blank lines left behind by comment stripping (a
 * removed comment block otherwise leaves a stretch of empty lines that would
 * inflate the line count without carrying any content) and trim the ends.
 *
 * @param {string} strippedText output of {@link stripBlockComments}
 * @returns {string}
 */
export function normalizeRuntimeContent(strippedText) {
  return strippedText.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @returns {number}
 */
export function countRuntimeLines(normalized) {
  return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

/**
 * Rough token estimate (~4 chars/token) — good enough for a budget gate, not
 * a substitute for a real tokenizer.
 *
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @returns {number}
 */
export function estimateTokens(normalized) {
  return Math.ceil(normalized.length / 4);
}

/**
 * Table rows Prettier has padded past `maxWidth` — the recurring pattern
 * behind this repo's largest CLAUDE.md blocks (a wide Purpose/Scope cell
 * forces every row in the column to the same width). A warning, not a
 * failure: legitimate short tables can still have one wide cell.
 *
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function findWidePaddedTableLines(normalized, maxWidth) {
  return normalized
    .split("\n")
    .filter(
      (line) => line.trimStart().startsWith("|") && line.length > maxWidth,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const claudeMdPath = join(root, "CLAUDE.md");

  let raw;
  try {
    raw = readFileSync(claudeMdPath, "utf8");
  } catch (error) {
    reporter.error(
      `Cannot read CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  const normalized = normalizeRuntimeContent(stripBlockComments(raw));
  const lines = countRuntimeLines(normalized);
  const tokens = estimateTokens(normalized);

  const errors = [];
  if (lines > MAX_RUNTIME_LINES) {
    errors.push(
      `CLAUDE.md runtime content is ${lines} line(s) — exceeds the ${MAX_RUNTIME_LINES}-line budget. ` +
        "Longer files reduce Claude's instruction adherence; move procedures to a skill, " +
        "path-scoped constraints to .claude/rules/*.md, and always-true rules to a hook.",
    );
  }
  if (tokens > MAX_APPROX_TOKENS) {
    errors.push(
      `CLAUDE.md runtime content is ~${tokens} approx. token(s) — exceeds the ~${MAX_APPROX_TOKENS}-token budget.`,
    );
  }

  for (const line of findWidePaddedTableLines(
    normalized,
    MAX_TABLE_LINE_WIDTH,
  )) {
    reporter.warn(
      `CLAUDE.md table row is ${line.length} chars (> ${MAX_TABLE_LINE_WIDTH}) — likely Prettier ` +
        `alignment padding: "${line.slice(0, 60)}…". Shorten the cell or move the table on-demand.`,
      { file: "CLAUDE.md" },
    );
  }

  if (errors.length > 0) {
    if (!json)
      console.error(`✗  ${errors.length} CLAUDE.md budget violation(s):`);
    for (const e of errors) reporter.error(e, { file: "CLAUDE.md" });
    reporter.finish({ lines, approxTokens: tokens });
    process.exit(1);
  }

  reporter.succeed(
    `CLAUDE.md runtime content: ${lines} line(s), ~${tokens} approx. token(s) — within budget ` +
      `(${MAX_RUNTIME_LINES} lines / ${MAX_APPROX_TOKENS} tokens).`,
  );
  reporter.finish({ lines, approxTokens: tokens });
}
