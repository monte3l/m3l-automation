/**
 * Pure decision logic for `bin/branch-cleanup.mjs` — the shared-checkout
 * equivalent of `worktree-remove.mjs`'s branch-delete step. Split out for
 * unit testing, mirroring `bin/lib/worktree-prune.mjs`'s shape: injectable
 * git runner, no `process.exit`, no reporter.
 *
 * `worktree-remove.mjs` and `worktree-prune.mjs` are both worktree-scoped —
 * neither helps a developer working in the shared checkout, `starting-work`'s
 * documented default location, delete a branch that has already merged. This
 * fills that gap without duplicating either script's worktree-specific
 * bookkeeping (this module never touches `git worktree *`).
 */
import { execFileSync } from "node:child_process";

/** Branches this tool refuses to delete under any circumstance. */
export const PROTECTED_BRANCHES = new Set(["main"]);

/**
 * Default git runner; returns stdout as a string. Injectable for tests.
 *
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function defaultRunGit(args, opts = {}) {
  const out = execFileSync("git", args, { encoding: "utf8", ...opts });
  return typeof out === "string" ? out.trim() : "";
}

/**
 * Whether it is even safe to ATTEMPT deleting `branch` — checked before any
 * git call so the caller gets a clear, specific refusal reason rather than a
 * raw git error. Pure — no git calls; `currentBranch` is supplied by the
 * caller (typically `git rev-parse --abbrev-ref HEAD`).
 *
 * Deliberately does NOT check "is this branch checked out in another
 * worktree" here — `git branch -d`/`-D` already refuses that case with its
 * own clear error, which {@link deleteBranch} surfaces via the kept/message
 * result rather than duplicating the check.
 *
 * @param {string} branch
 * @param {string} currentBranch
 * @returns {{ ok: true, reason: null } | { ok: false, reason: string }}
 * @example
 * ```js
 * import { validateDeletable } from "@m3l-automation/workspace/bin/lib/branch-cleanup.mjs";
 *
 * validateDeletable("feat/done-thing", "main");
 * // { ok: true, reason: null }
 * validateDeletable("main", "main");
 * // { ok: false, reason: 'refusing to delete protected branch "main"' }
 * ```
 */
export function validateDeletable(branch, currentBranch) {
  if (!branch || typeof branch !== "string" || branch.trim() === "") {
    return { ok: false, reason: "no branch name given" };
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    return {
      ok: false,
      reason: `refusing to delete protected branch "${branch}"`,
    };
  }
  if (branch === currentBranch) {
    return {
      ok: false,
      reason:
        `"${branch}" is the currently checked-out branch — switch to ` +
        "main (or another branch) first",
    };
  }
  return { ok: true, reason: null };
}

/**
 * @typedef {{ deleted: true, kept: false, message: string } |
 *           { deleted: false, kept: true, message: string }} DeleteBranchResult
 */

/**
 * Attempt to delete a local branch safely. Mirrors
 * `worktree-remove.mjs`'s keep-and-notify shape: an unmerged branch, or one
 * checked out in another worktree (git itself refuses that), is left in
 * place with an explanatory result rather than thrown — deletion failure is
 * an expected, non-fatal outcome here, not an error condition.
 *
 * @param {string} branch
 * @param {{ force?: boolean, runGit?: (args: string[], opts?: object) => string }} [opts]
 * @returns {DeleteBranchResult}
 * @example
 * ```js
 * import { deleteBranch } from "@m3l-automation/workspace/bin/lib/branch-cleanup.mjs";
 *
 * deleteBranch("feat/done-thing", { runGit: () => "" });
 * // { deleted: true, kept: false, message: "Deleted branch feat/done-thing." }
 * ```
 */
export function deleteBranch(
  branch,
  { force = false, runGit = defaultRunGit } = {},
) {
  try {
    runGit(["branch", force ? "-D" : "-d", branch], { stdio: "pipe" });
    return { deleted: true, kept: false, message: `Deleted branch ${branch}.` };
  } catch {
    return {
      deleted: false,
      kept: true,
      message:
        `Kept branch ${branch} (not merged into its base, or checked out ` +
        `in another worktree). Delete manually with \`git branch -D ${branch}\` ` +
        "once you're sure.",
    };
  }
}
