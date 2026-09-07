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
 *
 * {@link validateWorktreeSafe} adds the worktree-stranding guard issue #1004
 * (ROADMAP H11) asked for — see its own doc comment for the two conditions it
 * checks and why the check is narrow rather than a blanket cwd refusal.
 */
import { execFileSync } from "node:child_process";
import { branchSlug, worktreeForBranch } from "./checkout-location.mjs";

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
 * Does NOT check "is this branch checked out in another worktree" —
 * {@link validateWorktreeSafe} owns that check, run separately by the caller
 * so a worktree-detection failure (bare repo, git missing) can be handled
 * without disturbing this simpler, always-available validation.
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
 * @typedef {{ kind: "attached", worktreePath: string, slug: string | null }} AttachedRefusal
 * @typedef {{ kind: "standing-in", worktreePath: string, slug: string | null }} StandingInRefusal
 * @typedef {{ ok: true, refusal: null } |
 *           { ok: false, refusal: AttachedRefusal | StandingInRefusal }} WorktreeSafeResult
 */

/**
 * Whether deleting `branch` from `location` would strand a linked worktree
 * (issue #1004, ROADMAP H11). Pure — the caller supplies the parsed worktree
 * records and its own already-resolved location; this makes no git calls.
 *
 * Two narrow conditions, not a blanket "cwd is a linked worktree" refusal —
 * that would break `check:staleness`'s `pnpm branch:cleanup <branch>` advice
 * (`bin/lib/staleness-scan.mjs`), which only ever recommends the command for
 * a branch *already confirmed* attached to no worktree, and routinely runs
 * from inside a worktree. Deleting an unattached branch from a linked
 * worktree is safe — the ref lives in the shared object store regardless of
 * which worktree stands in for it:
 *
 * - `"attached"` — `branch` is checked out in a *different* linked worktree.
 *   `git branch -d`/`-D` cannot delete it from anywhere; the only fix is
 *   `pnpm worktree:remove <slug>` (or a manual `git worktree remove` when
 *   `slug` is `null` — a worktree directory that doesn't follow the
 *   `m3l-automation-<slug>` convention).
 * - `"standing-in"` — the caller's own cwd is the worktree named for
 *   `branch`'s slug (`m3l-automation-<slug>`), even if that worktree has
 *   since been switched off the branch. `worktreeForBranch` cannot see this
 *   case (the worktree's `branch` field no longer names the target), so it
 *   is checked independently via the location's own slug.
 *
 * @param {object} opts
 * @param {string} opts.branch
 * @param {import("./checkout-location.mjs").CheckoutLocation} opts.location
 * @param {import("./worktree-prune.mjs").WorktreeRecord[]} opts.records
 * @returns {WorktreeSafeResult}
 * @example
 * ```js
 * import { validateWorktreeSafe } from "@m3l-automation/workspace/bin/lib/branch-cleanup.mjs";
 *
 * validateWorktreeSafe({
 *   branch: "feat/x",
 *   location: { kind: "main", mainCheckout: "/repo", here: "/repo", slug: null },
 *   records: [{ path: "/repo-x", branch: "feat/x", head: null, detached: false, flags: [] }],
 * });
 * // { ok: false, refusal: { kind: "attached", worktreePath: "/repo-x", slug: "x" } }
 * ```
 */
export function validateWorktreeSafe({ branch, location, records }) {
  // Exclude the main checkout's own porcelain record before searching —
  // `parseWorktreeList` always includes it (worktree-prune.mjs's first
  // record), and without this filter a branch checked out in the MAIN
  // checkout would be misreported as "attached" to "a linked worktree" with
  // a `git worktree remove <main checkout>` remedy git will reject. Git's
  // own `branch -d`/`-D` already refuses a branch checked out in the main
  // checkout on its own; deleteBranch() surfaces that refusal correctly, and
  // there's no worktree directory to strand in that case anyway.
  const linkedRecords = records.filter((r) => r.path !== location.mainCheckout);
  const attached = worktreeForBranch(branch, linkedRecords);
  if (attached !== null && attached.path !== location.here) {
    return {
      ok: false,
      refusal: {
        kind: "attached",
        worktreePath: attached.path,
        slug: attached.slug,
      },
    };
  }
  if (location.kind === "worktree" && location.slug === branchSlug(branch)) {
    return {
      ok: false,
      refusal: {
        kind: "standing-in",
        worktreePath: location.here,
        slug: location.slug,
      },
    };
  }
  return { ok: true, refusal: null };
}

/**
 * @typedef {{ deleted: true, kept: false, message: string } |
 *           { deleted: false, kept: true, message: string, cause: string }} DeleteBranchResult
 */

/**
 * Attempt to delete a local branch safely. Mirrors
 * `worktree-remove.mjs`'s keep-and-notify shape: an unmerged branch, or one
 * checked out in another worktree (git itself refuses that), is left in
 * place with an explanatory result rather than thrown — deletion failure is
 * an expected, non-fatal outcome here, not an error condition. The
 * underlying git failure is still captured and surfaced via `cause` rather
 * than swallowed, though — an "unmerged branch" and a nonexistent one, a
 * corrupt ref, or git itself failing to run are different problems, and
 * collapsing them all into one fixed message hides which one actually
 * happened.
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
  } catch (cause) {
    const causeMessage =
      cause &&
      typeof cause === "object" &&
      "stderr" in cause &&
      typeof cause.stderr === "string" &&
      cause.stderr.trim() !== ""
        ? cause.stderr.trim()
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return {
      deleted: false,
      kept: true,
      message:
        `Kept branch ${branch} (${causeMessage}). Delete manually with ` +
        `\`git branch -D ${branch}\` once you're sure, or investigate the ` +
        "error above if this branch name looks wrong.",
      cause: causeMessage,
    };
  }
}
