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
// Refuses (exit 1) rather than deleting when that would strand a linked
// worktree — either the target branch is checked out in a DIFFERENT linked
// worktree, or this process is standing in the worktree named for the
// branch's own slug. See `lib/branch-cleanup.mjs`'s `validateWorktreeSafe`
// for why the check is these two narrow conditions and not a blanket
// "cwd is a linked worktree" refusal (issue #1004, ROADMAP H11).
//
// Usage:
//   node bin/branch-cleanup.mjs <branch>          # delete if safely merged
//   node bin/branch-cleanup.mjs <branch> --force  # force-delete (git branch -D)
//   pnpm branch:cleanup <branch>
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  deleteBranch,
  validateDeletable,
  validateWorktreeSafe,
} from "./lib/branch-cleanup.mjs";
import { resolveCheckoutLocation } from "./lib/checkout-location.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";
import { parseWorktreeList } from "./lib/worktree-prune.mjs";

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

// A guard that can't answer must not block a delete git will refuse anyway
// if it's genuinely unsafe — degrade to today's behavior on any failure
// (bare repo, git missing) rather than treat an unreadable location as safe
// OR unsafe.
try {
  const location = resolveCheckoutLocation();
  const records = parseWorktreeList(git(["worktree", "list", "--porcelain"]));
  const worktreeSafety = validateWorktreeSafe({ branch, location, records });
  if (!worktreeSafety.ok) {
    const { kind, worktreePath, slug } = worktreeSafety.refusal;
    const remedy =
      slug === null
        ? `\`git worktree remove ${worktreePath}\` then \`git branch -d ${branch}\`, ` +
          "since that worktree's directory name doesn't follow the " +
          "`m3l-automation-<slug>` convention `worktree:remove` needs"
        : `\`pnpm worktree:remove ${slug}\``;
    const message =
      kind === "attached"
        ? `branch-cleanup: "${branch}" is checked out in the linked worktree ` +
          `${worktreePath} — \`git branch -d\`/\`-D\` cannot delete it from ` +
          `here, and deleting it would orphan that worktree. Tear the whole ` +
          `thing down instead: ${remedy} (from the main checkout, or after ` +
          '`ExitWorktree({action: "keep"})` if this session entered it).'
        : `branch-cleanup: this session is standing in the linked worktree ` +
          `${worktreePath}, which was created for "${branch}". Deleting the ` +
          `branch from here leaves the worktree directory orphaned. Run ` +
          `${remedy} from the main checkout instead. If you really do want ` +
          `to keep the directory and drop only the branch, run ` +
          `\`git branch -d ${branch}\` by hand.`;
    reporter.error(message);
    reporter.finish({ deleted: false, branch });
    process.exit(1);
  }
} catch (cause) {
  reporter.warn(
    "branch-cleanup: could not determine whether this branch is tied to a " +
      "linked worktree — proceeding without that check " +
      `(${cause instanceof Error ? cause.message : String(cause)}).`,
  );
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
