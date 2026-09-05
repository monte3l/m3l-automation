/**
 * Post-merge residue detection for `bin/check-staleness.mjs` (issue #995,
 * ROADMAP row H2), split out for unit testing — same pattern as
 * `bin/lib/worktree-prune.mjs`: pure/injectable functions, no
 * `process.exit`, no reporter.
 *
 * Reuses `bin/lib/worktree-prune.mjs`'s worktree-staleness signals
 * (`mergedBranches`, `goneUpstreamBranches`, `classifyWorktrees`, …) rather
 * than re-deriving them, and adds the residue classes worktree-scoped
 * pruning structurally cannot see: a merged/`[gone]` branch never attached to
 * any worktree, remote-tracking refs a `git fetch --prune` would clear, and
 * `tmp/` files left behind by a spoke dispatch or a retired hook.
 *
 * This is detection only — the fixes are the commands that already exist:
 * `pnpm worktree:prune`, `pnpm branch:cleanup <branch>`, `git fetch --prune`.
 */
import { execFileSync } from "node:child_process";

/**
 * Default git runner; returns stdout as a string. Injectable for tests.
 *
 * @param {string[]} args
 * @returns {string}
 */
function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Local branches that are merged-or-`[gone]` but attached to no worktree —
 * the class `bin/worktree-prune.mjs` cannot see, since it only classifies
 * worktree records. `main` and the branch currently checked out are never
 * candidates (mirrors `classifyWorktrees`'s "never main or current" rule).
 *
 * @param {object} opts
 * @param {Set<string>} opts.mergedSet from {@link import("./worktree-prune.mjs").mergedBranches}
 * @param {Set<string>} opts.goneSet from {@link import("./worktree-prune.mjs").goneUpstreamBranches}
 * @param {Set<string>} opts.worktreeBranches branch names already attached to a worktree
 * @param {string} opts.currentBranch the branch HEAD currently points at
 * @returns {{ branch: string, reasons: string[] }[]}
 */
export function staleBranches({
  mergedSet,
  goneSet,
  worktreeBranches,
  currentBranch,
}) {
  const all = new Set([...mergedSet, ...goneSet]);
  const candidates = [];
  for (const branch of all) {
    if (branch === "main" || branch === currentBranch) continue;
    if (worktreeBranches.has(branch)) continue; // worktree:prune's job
    const reasons = [];
    if (mergedSet.has(branch)) reasons.push("merged");
    if (goneSet.has(branch)) reasons.push("upstream gone");
    candidates.push({ branch, reasons });
  }
  return candidates.sort((a, b) => a.branch.localeCompare(b.branch));
}

/**
 * Remote-tracking refs a `git remote prune origin --dry-run` would delete —
 * left behind once `git fetch --prune` hasn't run since the remote branch
 * was deleted. Network-dependent: never throws, degrading to
 * `{ ok: false }` so the caller can warn-and-skip exactly as
 * `bin/lib/worktree-prune.mjs`'s `fetchPrune` already does for the same
 * reason (staying offline-tolerant matters more than a fully current signal
 * for a local advisory gate).
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {{ ok: boolean, refs: string[], error: string | null }}
 */
export function pendingRemotePrunes(runGit = defaultRunGit) {
  try {
    const out = runGit(["remote", "prune", "origin", "--dry-run"]);
    const refs = [...out.matchAll(/\* \[would prune\] (\S+)/g)].map(
      (m) => m[1],
    );
    return { ok: true, refs, error: null };
  } catch (err) {
    return {
      ok: false,
      refs: [],
      error: /** @type {Error} */ (err).message,
    };
  }
}

/**
 * `tmp/` files a live process is known to write, keyed by the constant each
 * writer exports — kept here rather than re-declared so this allowlist
 * cannot silently drift from its sources. An entry never counts as an
 * orphan, regardless of age.
 */
export const LIVE_TMP_FILES = new Set([
  // bin/usage-cache.mjs's weekly-usage cache moved out of tmp/ entirely — it
  // is account-scoped (resolveUsageCachePath, under ~/.claude/), not repo
  // data, so it no longer needs an entry here (docs/adr/0092's amendment).
  "tmp/slice-progress.json", // bin/slice-progress.mjs SLICE_PROGRESS_REL_PATH
  "tmp/compact-handoff.json", // .claude/hooks/write-compact-handoff.mjs HANDOFF_REL_PATH
  "tmp/session-incidents.jsonl", // .claude/hooks/detect-spoke-truncation.mjs INCIDENTS_REL_PATH
]);

/** Default staleness threshold for a non-allowlisted `tmp/` file. */
export const DEFAULT_STALE_DAYS = 7;

/**
 * `tmp/` entries not on {@link LIVE_TMP_FILES} whose age exceeds
 * `staleDays` — most often a spoke's dispatch journal
 * (`.claude/rules/subagent-dispatch.md`) that `finishing-work` Step 7 never
 * swept, or residue from a retired hook (e.g. `tmp/spoke-lifecycle.jsonl`,
 * left by the since-retired `track-inflight-spokes.mjs`).
 *
 * @param {object} opts
 * @param {{ relPath: string, mtimeMs: number }[]} opts.entries `tmp/`-relative
 *   file entries (directories excluded by the caller)
 * @param {Date} opts.now injected clock, so staleness is assertable
 * @param {number} [opts.staleDays]
 * @returns {{ relPath: string, ageDays: number }[]}
 */
export function orphanedTmpFiles({
  entries,
  now,
  staleDays = DEFAULT_STALE_DAYS,
}) {
  const orphans = [];
  for (const { relPath, mtimeMs } of entries) {
    if (LIVE_TMP_FILES.has(relPath)) continue;
    const ageDays = (now.getTime() - mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays >= staleDays) {
      orphans.push({ relPath, ageDays: Math.floor(ageDays) });
    }
  }
  return orphans.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
