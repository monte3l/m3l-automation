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
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const args = new Set(argv);
const dryRun = args.has("--dry-run");
const force = args.has("--force");

function git(gitArgs) {
  return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
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
  reporter.error(
    "worktree:prune: no local `main` branch found. This script removes " +
      "worktrees whose branch is merged into `main`; check out or fetch `main` " +
      "and re-run.",
  );
  reporter.finish({ pruned: [], dryRun });
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
  reporter.succeed("No stale worktrees to prune.");
  reporter.finish({ pruned: [], dryRun });
  process.exit(0);
}

reporter.info(`Found ${candidates.length} stale worktree(s):`);
for (const w of candidates) {
  const why = [
    w.flags.includes("prunable") ? "prunable" : null,
    w.branch && mergedBranches.has(w.branch) ? "merged" : null,
  ]
    .filter(Boolean)
    .join(", ");
  reporter.info(`  • ${w.path}  [${w.branch ?? "detached"}]  (${why})`);
}

if (dryRun) {
  reporter.info("\n(dry run — nothing removed)");
  reporter.finish({
    pruned: candidates.map((w) => w.path),
    dryRun: true,
  });
  process.exit(0);
}

let removed = 0;
let failed = 0;
const prunedPaths = [];
for (const w of candidates) {
  const removeArgs = ["worktree", "remove", w.path];
  if (force) removeArgs.push("--force");
  try {
    execFileSync("git", removeArgs, { stdio: "pipe" });
    reporter.change("removed", w.path);
    prunedPaths.push(w.path);
    removed++;
  } catch {
    reporter.error(
      `Could not remove ${w.path} (uncommitted changes or untracked files). ` +
        "Re-run with --force to discard them.",
    );
    failed++;
  }
}

try {
  git(["worktree", "prune"]);
} catch (err) {
  reporter.error(
    `worktree:prune: \`git worktree prune\` failed ` +
      `(${/** @type {Error} */ (err).message}). Stale admin entries may remain; ` +
      "re-run or inspect `git worktree list`.",
  );
  failed++;
}

reporter.info("");
reporter.succeed(`Pruned ${removed} worktree(s); ${failed} skipped.`);
reporter.finish({ pruned: prunedPaths, dryRun: false });
if (failed > 0) process.exit(1);
