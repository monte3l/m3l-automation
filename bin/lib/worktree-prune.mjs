/**
 * Staleness detection for `bin/worktree-prune.mjs`, split out for unit testing
 * (kept pattern-parallel with `bin/lib/signed-range.mjs`: pure/injectable
 * functions, no `process.exit`, no reporter).
 *
 * This repo lands PRs by squash merge (and sometimes rebase merge), so a
 * branch's tip is never an ancestor of `main` after landing — `git branch
 * --merged main` alone therefore misses the common case. `main` only ever
 * carries the squashed replacement commit, not the original branch history
 * (verified against PRs #650/#649/#647: none of their head commits are
 * ancestors of `main` after merge). The predicate here adds two signals that
 * are correct under any merge style:
 *
 *   - `merged`   — ancestry via `git branch --merged main` (still catches a
 *                  true merge-commit or fast-forward landing).
 *   - `gone`     — the branch's upstream tracking ref reads `[gone]`, the
 *                  marker GitHub's `deleteBranchOnMerge` leaves behind after
 *                  ANY merge style once `git fetch --prune` has run. A branch
 *                  that was never pushed has no upstream and never reports
 *                  `[gone]`, so this cannot misfire on in-progress work.
 *   - `detached` — a `--from <ref>` detached worktree (ADR-0014's 2026-08-25
 *                  amendment) whose HEAD is itself an ancestor of `main`.
 *   - `prunable` — git's own signal that the worktree directory is gone.
 */
import { execFileSync } from "node:child_process";

/** @typedef {{ path: string, head: string | null, branch: string | null, detached: boolean, flags: string[] }} WorktreeRecord */

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
 * Parse `git worktree list --porcelain` output into records. Captures the
 * `HEAD <sha>` line (needed for the detached-merged check) instead of folding
 * it into `flags` as an opaque string.
 *
 * @param {string} porcelain
 * @returns {WorktreeRecord[]}
 */
export function parseWorktreeList(porcelain) {
  /** @type {WorktreeRecord[]} */
  const records = [];
  /** @type {WorktreeRecord | null} */
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        flags: [],
      };
      records.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (current && line.trim() === "detached") {
      current.detached = true;
    } else if (current && line.trim() !== "") {
      current.flags.push(line.trim()); // bare, locked, prunable
    }
  }
  return records;
}

/**
 * Branches merged into `main` by ancestry (true merge-commit/fast-forward).
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {Set<string>}
 */
export function mergedBranches(runGit = defaultRunGit) {
  return new Set(
    runGit(["branch", "--merged", "main", "--format=%(refname:short)"])
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean),
  );
}

/**
 * Local branches whose upstream tracking ref reports `[gone]` — left behind
 * by a remote `deleteBranchOnMerge` deletion after the branch was merged,
 * regardless of merge style. Requires `git fetch --prune` to have run first
 * so the local remote-tracking refs are current; see {@link fetchPrune}.
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {Set<string>}
 */
export function goneUpstreamBranches(runGit = defaultRunGit) {
  const out = runGit([
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)%09%(upstream:track)",
  ]);
  const gone = new Set();
  for (const line of out.split("\n")) {
    const [name, track] = line.split("\t");
    if (name && track && track.includes("[gone]")) gone.add(name.trim());
  }
  return gone;
}

/**
 * Whether `sha` (a detached worktree's HEAD) is itself an ancestor of `main`.
 *
 * @param {string} sha
 * @param {(args: string[]) => string} [runGit]
 * @returns {boolean}
 */
export function isMergedDetached(sha, runGit = defaultRunGit) {
  try {
    runGit(["merge-base", "--is-ancestor", sha, "refs/heads/main"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh remote-tracking refs so `[gone]` upstream markers are current.
 * Never throws — a failed fetch degrades to classifying against whatever
 * remote-tracking state is already on disk, which the caller should warn
 * about rather than treat as fatal (staying offline-tolerant matters more
 * than a fully up-to-date `[gone]` signal for a local cleanup tool).
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {{ ok: boolean, error: string | null }}
 */
export function fetchPrune(runGit = defaultRunGit) {
  try {
    runGit(["fetch", "--prune"]);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message };
  }
}

/**
 * Classify worktrees as stale/not, with the reason(s) each candidate matched.
 * Never includes the main checkout (first porcelain record) or the worktree
 * the caller is currently standing in.
 *
 * @param {object} opts
 * @param {WorktreeRecord[]} opts.records
 * @param {string} opts.mainPath - resolved path of the main checkout
 * @param {string} opts.here - resolved path of the caller's cwd
 * @param {Set<string>} opts.mergedSet
 * @param {Set<string>} opts.goneSet
 * @param {(sha: string) => boolean} opts.isMergedDetachedFn
 * @returns {{ record: WorktreeRecord, reasons: string[] }[]}
 */
export function classifyWorktrees({
  records,
  mainPath,
  here,
  mergedSet,
  goneSet,
  isMergedDetachedFn,
}) {
  const candidates = [];
  for (const w of records) {
    if (w.path === mainPath || w.path === here) continue; // never main or current
    const reasons = [];
    // Porcelain output never emits a bare "prunable" token — it's always
    // "prunable <reason>" (e.g. "prunable gitdir file points to non-existent
    // location"), so match by prefix rather than exact value.
    if (w.flags.some((f) => f === "prunable" || f.startsWith("prunable ")))
      reasons.push("prunable");
    if (w.branch !== null && mergedSet.has(w.branch)) reasons.push("merged");
    if (w.branch !== null && goneSet.has(w.branch))
      reasons.push("upstream gone");
    if (
      w.branch === null &&
      w.detached &&
      w.head &&
      isMergedDetachedFn(w.head)
    ) {
      reasons.push("detached at merged commit");
    }
    if (reasons.length > 0) candidates.push({ record: w, reasons });
  }
  return candidates;
}
