/**
 * Resolves where a process is standing relative to the main checkout — the
 * main checkout itself, or a linked worktree (ADR-0013) — and the sibling
 * worktree slug that location's directory name encodes, if any. Consolidates
 * the `dirname(git rev-parse --path-format=absolute --git-common-dir)` idiom
 * that `bin/worktree-new.mjs` and `bin/worktree-remove.mjs` each computed
 * inline (issue #1004, ROADMAP H11).
 *
 * Pure apart from the injected git seam, mirroring `bin/lib/claude-home.mjs`'s
 * shape so it stays exercisable in `bin/tests/**` without touching disk.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { worktreeDirName } from "./worktree-new.mjs";

/** @typedef {{ kind: "main" | "worktree", mainCheckout: string, here: string, slug: string | null }} CheckoutLocation */

/**
 * Default git runner; returns trimmed stdout. Injectable for tests.
 *
 * @param {string[]} args
 * @returns {string}
 */
function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * The sibling-worktree slug encoded in a checkout directory's basename, or
 * `null` when it does not follow ADR-0014's `m3l-automation-<slug>`
 * convention. A hand-made `git worktree add ../scratch` is still a linked
 * worktree — callers must treat `slug: null` as "cannot name a
 * `worktree:remove` remedy", never as "not a worktree". Derived from
 * {@link worktreeDirName} rather than re-declaring the `m3l-automation-`
 * prefix, so the two can't drift.
 *
 * @param {string} dirName basename of a checkout root
 * @returns {string | null}
 * @example
 * ```js
 * slugFromWorktreeDir("m3l-automation-core-json"); // "core-json"
 * slugFromWorktreeDir("m3l-automation");           // null
 * slugFromWorktreeDir("scratch");                  // null
 * ```
 */
export function slugFromWorktreeDir(dirName) {
  const prefix = worktreeDirName("");
  if (!dirName.startsWith(prefix)) return null;
  const slug = dirName.slice(prefix.length);
  return slug === "" ? null : slug;
}

/**
 * The slug half of a branch name — everything after the first `/`, or the
 * whole name when it carries no `<kind>/` prefix. Mirrors what
 * `worktree:new <slug> --kind <kind>` produces as `<kind>/<slug>` in the
 * other direction.
 *
 * @param {string} branch
 * @returns {string}
 * @example
 * ```js
 * branchSlug("feat/core-json"); // "core-json"
 * branchSlug("core-json");      // "core-json"
 * ```
 */
export function branchSlug(branch) {
  const slashIndex = branch.indexOf("/");
  return slashIndex === -1 ? branch : branch.slice(slashIndex + 1);
}

/**
 * Pure classifier: main checkout vs linked worktree, given both paths
 * already resolved. Split from {@link resolveCheckoutLocation} so the
 * decision is assertable without touching git or disk.
 *
 * `kind` and `slug` are independent fields — a linked worktree whose
 * directory name doesn't follow the `m3l-automation-<slug>` convention still
 * classifies as `kind: "worktree"`, just with `slug: null`. Never read
 * `slug === null` as "this is the main checkout".
 *
 * @param {string} mainCheckout absolute path, `dirname(--git-common-dir)`
 * @param {string} here absolute path of this checkout's root
 * @returns {CheckoutLocation}
 */
export function classifyCheckout(mainCheckout, here) {
  const resolvedMain = resolve(mainCheckout);
  const resolvedHere = resolve(here);
  if (resolvedMain === resolvedHere) {
    return {
      kind: "main",
      mainCheckout: resolvedMain,
      here: resolvedHere,
      slug: null,
    };
  }
  return {
    kind: "worktree",
    mainCheckout: resolvedMain,
    here: resolvedHere,
    slug: slugFromWorktreeDir(basename(resolvedHere)),
  };
}

/**
 * Where this process is standing: the main checkout, or a linked worktree
 * (ADR-0013), plus the worktree slug its directory name encodes if any.
 *
 * Uses `--git-common-dir` (never `--git-dir`) for the same reason
 * `bin/lib/claude-home.mjs` does: inside a linked worktree only the common
 * dir points back at the main checkout. Resolves `here` via
 * `--show-toplevel` rather than raw `process.cwd()`, so this is correct from
 * a subdirectory too — matching `.claude/hooks/guard-worktree-ready.mjs`'s
 * existing check.
 *
 * Throws if git cannot answer (bare repo, no repo, git missing) — a caller
 * whose guard is advisory must catch and degrade, not treat this as safe to
 * skip.
 *
 * @param {{ runGit?: (args: string[]) => string }} [opts]
 * @returns {CheckoutLocation}
 */
export function resolveCheckoutLocation({ runGit = defaultRunGit } = {}) {
  const commonDir = runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const mainCheckout = dirname(commonDir);
  const here = runGit(["rev-parse", "--show-toplevel"]);
  return classifyCheckout(mainCheckout, here);
}

/**
 * The worktree record whose branch is `branch`, or `null` when no linked
 * worktree has it checked out (unattached, or only reachable via a detached
 * HEAD). Takes already-parsed records
 * ({@link import("./worktree-prune.mjs").parseWorktreeList}) rather than
 * re-shelling — keeps this pure and reuses the one porcelain parser.
 *
 * @param {string} branch
 * @param {import("./worktree-prune.mjs").WorktreeRecord[]} records
 * @returns {{ path: string, slug: string | null } | null}
 */
export function worktreeForBranch(branch, records) {
  const record = records.find((r) => r.branch === branch);
  if (!record) return null;
  return {
    path: record.path,
    slug: slugFromWorktreeDir(basename(record.path)),
  };
}
