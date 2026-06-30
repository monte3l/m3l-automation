#!/usr/bin/env node
// Cleans up stale git worktrees. A worktree is a removal candidate when its
// branch is already merged into `main`, or git reports it as `prunable`
// (its directory is gone). The main checkout and the current worktree are
// never touched.
//
// Usage:
//   node bin/worktree-prune.mjs            # remove safe (clean) candidates
//   node bin/worktree-prune.mjs --dry-run  # list candidates only
//   node bin/worktree-prune.mjs --force    # also remove candidates with changes
import process from "node:process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

// `git branch --merged main` silently yields an empty set when `main` is
// absent, which would skip every merged-branch candidate without warning.
// Fail loudly instead so the operator knows the merged check did not run.
function branchExists(name) {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

if (!branchExists("main")) {
  console.error(
    "✗  worktree:prune: no local `main` branch found. This script removes " +
      "worktrees whose branch is merged into `main`; check out or fetch `main` " +
      "and re-run.",
  );
  process.exit(1);
}

// Branches merged into main can be cleaned up safely.
const mergedBranches = new Set(
  git(["branch", "--merged", "main", "--format=%(refname:short)"])
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean),
);

// Parse `git worktree list --porcelain` into records.
const records = [];
let current = null;
for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
  if (line.startsWith("worktree ")) {
    current = { path: line.slice("worktree ".length), branch: null, flags: [] };
    records.push(current);
  } else if (current && line.startsWith("branch ")) {
    current.branch = line.slice("branch ".length).replace("refs/heads/", "");
  } else if (current && line.trim() !== "") {
    current.flags.push(line.trim()); // bare, detached, locked, prunable
  }
}

const here = resolve(process.cwd());
const mainPath = records.length > 0 ? resolve(records[0].path) : null;

const candidates = records.filter((w) => {
  const p = resolve(w.path);
  if (p === mainPath || p === here) return false; // never the main or current tree
  const prunable = w.flags.includes("prunable");
  const merged = w.branch !== null && mergedBranches.has(w.branch);
  return prunable || merged;
});

if (candidates.length === 0) {
  console.log("✓  No stale worktrees to prune.");
  process.exit(0);
}

console.log(`Found ${candidates.length} stale worktree(s):`);
for (const w of candidates) {
  const why = [
    w.flags.includes("prunable") ? "prunable" : null,
    w.branch && mergedBranches.has(w.branch) ? "merged" : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`  • ${w.path}  [${w.branch ?? "detached"}]  (${why})`);
}

if (dryRun) {
  console.log("\n(dry run — nothing removed)");
  process.exit(0);
}

let removed = 0;
let failed = 0;
for (const w of candidates) {
  const removeArgs = ["worktree", "remove", w.path];
  if (force) removeArgs.push("--force");
  try {
    execFileSync("git", removeArgs, { stdio: "pipe" });
    console.log(`✓  Removed ${w.path}`);
    removed++;
  } catch {
    console.error(
      `✗  Could not remove ${w.path} (uncommitted changes or untracked files). ` +
        "Re-run with --force to discard them.",
    );
    failed++;
  }
}

try {
  git(["worktree", "prune"]);
} catch (err) {
  console.error(
    `✗  worktree:prune: \`git worktree prune\` failed ` +
      `(${/** @type {Error} */ (err).message}). Stale admin entries may remain; ` +
      "re-run or inspect `git worktree list`.",
  );
  failed++;
}

console.log(`\n✓  Pruned ${removed} worktree(s); ${failed} skipped.`);
if (failed > 0) process.exit(1);
