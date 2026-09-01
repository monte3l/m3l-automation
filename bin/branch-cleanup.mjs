#!/usr/bin/env node
// Shared-checkout equivalent of `worktree-remove.mjs`'s branch-delete step —
// deletes a merged local branch from the CURRENT checkout, without any of
// `worktree-remove.mjs`/`worktree-prune.mjs`'s worktree-specific bookkeeping.
// `starting-work` defaults to the shared checkout, and neither existing
// cleanup script covers it: a developer finishing work there had no
// equivalent of `pnpm worktree:remove`'s branch delete, so merged local
// branches accumulated indefinitely. See `.claude/skills/finishing-work/SKILL.md`,
// the primary caller.
//
// Usage:
//   node bin/branch-cleanup.mjs <branch>          # delete if safely merged
//   node bin/branch-cleanup.mjs <branch> --force  # force-delete (git branch -D)
//   pnpm branch:cleanup <branch>
import process from "node:process";
import { execFileSync } from "node:child_process";
import { deleteBranch, validateDeletable } from "./lib/branch-cleanup.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);
const force = argv.includes("--force");
const branch = argv.find((a) => !a.startsWith("--"));

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (!branch) {
  reporter.error(
    "branch-cleanup: missing <branch>.\n" +
      "   Usage: node bin/branch-cleanup.mjs <branch> [--force]",
  );
  reporter.finish();
  process.exit(1);
}

let currentBranch;
try {
  currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
} catch (cause) {
  reporter.error(
    "branch-cleanup: could not resolve the current branch — is this a git " +
      `repository? (${cause instanceof Error ? cause.message : String(cause)})`,
  );
  reporter.finish();
  process.exit(1);
}

const validation = validateDeletable(branch, currentBranch);
if (!validation.ok) {
  reporter.error(`branch-cleanup: ${validation.reason}.`);
  reporter.finish();
  process.exit(1);
}

const result = deleteBranch(branch, { force });
if (result.deleted) {
  reporter.succeed(result.message);
} else {
  // Kept (unmerged, or checked out elsewhere) is an expected, non-fatal
  // outcome — matches worktree-remove.mjs's keep-and-notify behavior.
  reporter.warn(result.message);
}
reporter.finish({ deleted: result.deleted, branch });
process.exit(0);
