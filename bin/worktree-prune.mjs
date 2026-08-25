#!/usr/bin/env node
// Cleans up stale git worktrees. A worktree is a removal candidate when its
// branch is already merged into `main` (by ancestry, or because its upstream
// reports `[gone]` after a squash/rebase/merge-commit landing — see
// bin/lib/worktree-prune.mjs for why ancestry alone misses squash merges), a
// `--from <ref>` detached worktree whose HEAD is itself merged, or git
// reports it `prunable` (its directory is gone). The main checkout and the
// current worktree are never touched.
//
// Usage:
//   node bin/worktree-prune.mjs             # remove safe (clean) candidates
//   node bin/worktree-prune.mjs --dry-run   # list candidates only
//   node bin/worktree-prune.mjs --force     # also remove candidates with changes
//   node bin/worktree-prune.mjs --no-fetch  # skip the default `git fetch --prune`
import process from "node:process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";
import {
  parseWorktreeList,
  mergedBranches,
  goneUpstreamBranches,
  isMergedDetached,
  fetchPrune,
  classifyWorktrees,
} from "./lib/worktree-prune.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const args = new Set(argv);
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const noFetch = args.has("--no-fetch");

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

// Refresh remote-tracking refs by default so the `[gone]`-upstream signal
// reflects reality (it only updates on a pruning fetch). Best-effort: a
// failed fetch degrades to classifying against whatever is already on disk
// rather than blocking a local cleanup tool on network access.
if (!noFetch) {
  const { ok, error } = fetchPrune(git);
  if (!ok) {
    reporter.warn(
      `worktree:prune: \`git fetch --prune\` failed (${error}). Continuing ` +
        "with possibly stale remote-tracking refs — some merged-and-deleted " +
        "branches may not be detected this run. Re-run with `--no-fetch` to " +
        "silence this if you're intentionally offline.",
    );
  }
}

const mergedSet = mergedBranches(git);
const goneSet = goneUpstreamBranches(git);

const records = parseWorktreeList(git(["worktree", "list", "--porcelain"]));

const here = resolve(process.cwd());
const mainPath = records.length > 0 ? resolve(records[0].path) : null;

const classified = classifyWorktrees({
  records: records.map((r) => ({ ...r, path: resolve(r.path) })),
  mainPath,
  here,
  mergedSet,
  goneSet,
  isMergedDetachedFn: (sha) => isMergedDetached(sha, git),
});

if (classified.length === 0) {
  reporter.succeed("No stale worktrees to prune.");
  reporter.finish({ pruned: [], dryRun });
  process.exit(0);
}

reporter.info(`Found ${classified.length} stale worktree(s):`);
for (const { record: w, reasons } of classified) {
  reporter.info(
    `  • ${w.path}  [${w.branch ?? "detached"}]  (${reasons.join(", ")})`,
  );
}

if (dryRun) {
  reporter.info("\n(dry run — nothing removed)");
  reporter.finish({
    pruned: classified.map(({ record: w, reasons }) => ({
      path: w.path,
      reasons,
    })),
    dryRun: true,
  });
  process.exit(0);
}

let removed = 0;
let failed = 0;
const prunedPaths = [];
for (const { record: w, reasons } of classified) {
  const removeArgs = ["worktree", "remove", w.path];
  if (force) removeArgs.push("--force");
  try {
    execFileSync("git", removeArgs, { stdio: "pipe" });
    reporter.change("removed", w.path);
    prunedPaths.push({ path: w.path, reasons });
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
