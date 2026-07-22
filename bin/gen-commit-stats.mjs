#!/usr/bin/env node
// Counts AI co-authorship from the repo's `Co-Authored-By: …
// <noreply@anthropic.com>` trailer history, folding historical aliases
// (bin/lib/claude-models.mjs) into their canonical model name. Consumed by
// bin/gen-commit-stats-endpoint.mjs, which publishes the counts as
// shields.io endpoint-badge JSON to GitHub Pages on every push to `main`
// (.github/workflows/pages-commit-stats.yml, ADR-0032 addendum) — the badge
// numbers live outside git history instead of being baked into a committed
// README block.
//
// Deliberately NOT a CI gate: the counts change on every commit, so a
// fail-on-drift check would fail every PR. The authoritative source is
// always `git log` itself.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CO_AUTHOR_EMAIL,
  normalizeClaudeModel,
  parseCoAuthor,
} from "./lib/claude-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * Count all commits reachable from HEAD — the same total GitHub's commit
 * counter reports for the branch, so the aggregate badge's denominator ties
 * the co-authored counts to the number a reader sees on the repo page.
 *
 * @returns {number}
 */
export function countTotalCommits() {
  return Number(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  );
}
