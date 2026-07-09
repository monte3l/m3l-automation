#!/usr/bin/env node
// Regenerates the per-model AI co-authorship badges in the root README from
// git history. Counts every `Co-Authored-By: … <noreply@anthropic.com>`
// trailer, folds historical aliases (bin/lib/claude-models.mjs) into their
// canonical model, and rewrites the marker-delimited badge block.
//
// Deliberately NOT a CI gate: the counts change on every commit, so a
// fail-on-drift check would fail every PR. Freshness rides the /syncing-docs
// reconciliation pass instead — the badges are a periodically refreshed
// snapshot, and the authoritative source is always `git log` itself.
//
// Usage:
//   node bin/gen-commit-stats.mjs   # idempotent; rewrites README.md in place
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CANONICAL_CLAUDE_MODELS,
  CO_AUTHOR_EMAIL,
  normalizeClaudeModel,
  parseCoAuthor,
} from "./lib/claude-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");

export const BEGIN_MARKER = "<!-- BEGIN COMMIT-STATS-BADGES -->";
export const END_MARKER = "<!-- END COMMIT-STATS-BADGES -->";

/** Style shared with the hand-written badges above the block. */
const BADGE_STYLE = "style=flat-square&labelColor=272822";
const BADGE_COLOR = "A6E22E";

/**
 * Count commits per canonical Claude model from the repo's trailer history.
 *
 * @returns {Map<string, number>} canonical model name -> commit count
 */
export function countCommitsByModel() {
  const trailers = execFileSync(
    "git",
    ["log", "--format=%(trailers:key=Co-Authored-By,valueonly,separator=%x0A)"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(CO_AUTHOR_EMAIL));

  const counts = new Map();
  for (const value of trailers) {
    const parsed = parseCoAuthor(value);
    if (parsed === null) continue;
    const model = normalizeClaudeModel(parsed.name);
    if (model === null) continue; // unknown names are the completeness test's job
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return counts;
}

/** Escape a shields.io static-badge path segment (dashes double, spaces encode). */
function badgeSegment(text) {
  return String(text).replace(/-/g, "--").replace(/ /g, "%20");
}

/**
 * Build the marker-delimited badge block, one badge per model that has
 * commits, in allowlist (capability-tier) order.
 *
 * @param {Map<string, number>} counts
 * @returns {string}
 */
export function buildBadgeBlock(counts) {
  const lines = [BEGIN_MARKER];
  for (const model of CANONICAL_CLAUDE_MODELS) {
    const count = counts.get(model);
    if (count === undefined) continue;
    const url = `https://img.shields.io/badge/${badgeSegment(model)}-${badgeSegment(count)}%20commits-${BADGE_COLOR}?${BADGE_STYLE}`;
    lines.push(
      `<a href="#co-developed-with-claude"><img src="${url}" alt="${model}: ${count} commits"></a>`,
    );
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

/**
 * Replace the marker-delimited block in the README content.
 *
 * @param {string} content
 * @param {string} block
 * @returns {string}
 */
export function replaceBadgeBlock(content, block) {
  const start = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `README.md is missing the ${BEGIN_MARKER} … ${END_MARKER} block`,
    );
  }
  return (
    content.slice(0, start) + block + content.slice(end + END_MARKER.length)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = countCommitsByModel();
  const content = readFileSync(readmePath, "utf8");
  const next = replaceBadgeBlock(content, buildBadgeBlock(counts));
  if (next === content) {
    console.log("✓  commit-stats badges already current");
  } else {
    writeFileSync(readmePath, next);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(
      `✓  commit-stats badges regenerated (${total} co-authored commits across ${counts.size} models)`,
    );
  }
}
