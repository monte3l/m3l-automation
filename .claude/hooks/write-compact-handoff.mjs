#!/usr/bin/env node
/**
 * PreCompact: writes a structured handoff artifact to `tmp/compact-handoff.json`
 * before Claude Code compacts the conversation (ADR-0078).
 *
 * Anthropic's harness-design guidance argues durable artifacts outperform
 * in-place summarization for long-running work — "git commits eliminated the
 * need for an agent to have to guess at what had happened"
 * (`anthropic.com/engineering/effective-harnesses-for-long-running-agents`).
 * This repo's own incident history validated the same pattern one layer
 * down: every one of 20+ logged subagent truncations recovered losslessly
 * via its journal, none via a narrated summary
 * (`docs/contributing/subagent-context-management.md`). This hook extends
 * that pattern to the hub session itself, so post-compaction state
 * reconstruction doesn't depend on the summary having retained it —
 * `reinject-compact-handoff.mjs` (`SessionStart`, matcher `compact`) reads
 * this artifact back as `additionalContext`.
 *
 * Deliberately git/fs-only, no network calls (no `gh` lookup for a PR
 * number) — every other hook in this repo stays fast and dependency-free,
 * and a PreCompact hook runs on the hot path of every compaction, so a
 * network round-trip here would add latency to an already-slow moment.
 * The branch name is enough to look up the PR when needed
 * (`gh pr list --head <branch>`).
 *
 * "Pending gates" is deliberately NOT a live re-run of `pnpm verify` (far
 * too slow for a hook) — it's `git status --porcelain`, a fast, honest
 * proxy for "there is uncommitted work here."
 *
 * "Journal paths" is best-effort: `bin/spoke-recovery.mjs` takes an
 * explicit `--journal <path>` rather than discovering journals itself, and
 * a hook has no documented way to address the ephemeral session scratchpad
 * directory a subagent may have journaled to — so this only lists
 * journal-shaped files under this repo's own gitignored `tmp/` scratch
 * directory (real, cheap, deterministic), not a claim of session-scratchpad
 * discovery this hook cannot honestly make.
 *
 * Advisory-only: always exits 0. A write failure (e.g. `tmp/` unwritable)
 * is swallowed — losing a handoff on this one compaction is a hint the
 * next session can't reconstruct as cheaply, not a fatal failure of the
 * turn in progress.
 */
import process from "node:process";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
export const HANDOFF_REL_PATH = "tmp/compact-handoff.json";

/**
 * Trims only trailing whitespace/newlines, never leading — `git status
 * --porcelain`'s first two columns are semantically meaningful status
 * codes that can legitimately BE a leading space (` M` = modified in the
 * worktree only, vs. `M ` = staged); a plain `.trim()` would silently
 * corrupt that first line's status code.
 *
 * @param {string[]} args
 * @returns {string | null} trailing-trimmed stdout, or null on any failure
 *   (missing git, not a repo, command error) — never throws.
 */
export function runGit(args, cwd = root) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).replace(/\s+$/, "");
  } catch {
    return null;
  }
}

/** @returns {string} current branch, "" if unavailable */
export function currentBranch(cwd = root) {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "";
}

/** @returns {string} repo root of the worktree the hook is running in */
export function currentWorktree(cwd = root) {
  return runGit(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
}

/**
 * @returns {{ sha: string, signature: string } | null} the last commit's
 *   SHA and its `%G?` signature-verification code (`G`=good, `B`=bad,
 *   `N`=unsigned, …), or null if no commits/not a repo.
 */
export function lastCommitInfo(cwd = root) {
  const raw = runGit(["log", "-1", "--format=%H%x09%G?"], cwd);
  if (raw === null || raw === "") return null;
  const [sha, signature] = raw.split("\t");
  if (!sha) return null;
  return { sha, signature: signature ?? "N" };
}

/**
 * @returns {string[]} `git status --porcelain` lines — a fast, honest proxy
 *   for "there is uncommitted work here," not a gate re-run.
 */
export function uncommittedFiles(cwd = root) {
  const raw = runGit(["status", "--porcelain"], cwd);
  if (raw === null || raw === "") return [];
  return raw.split("\n").filter((line) => line.length > 0);
}

/**
 * Journal-shaped files under this repo's gitignored `tmp/` scratch
 * directory — best-effort, not a claim of ephemeral session-scratchpad
 * discovery (see file header).
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths, sorted
 */
export function findScratchJournals(repoRoot) {
  const tmpDir = join(repoRoot, "tmp");
  if (!existsSync(tmpDir)) return [];
  let entries;
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isFile() && /journal/i.test(e.name) && e.name.endsWith(".md"),
    )
    .map((e) => `tmp/${e.name}`)
    .sort();
}

/**
 * Build the full handoff payload from live git/fs state.
 *
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
export function buildHandoff(cwd = root) {
  const worktree = currentWorktree(cwd);
  return {
    capturedAt: new Date().toISOString(),
    branch: currentBranch(cwd),
    worktree,
    lastCommit: lastCommitInfo(cwd),
    uncommittedFiles: uncommittedFiles(cwd),
    journals: findScratchJournals(worktree),
  };
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Drain stdin (Claude Code pipes the hook payload) even though this hook
  // doesn't need any field from it — leaving it unread can leave the pipe
  // open under some harness/runtime combinations.
  for await (const _chunk of process.stdin) {
    // intentionally discarded
  }

  try {
    const handoff = buildHandoff();
    const handoffPath = join(root, HANDOFF_REL_PATH);
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  } catch {
    // Advisory-only — never block or fail a compaction over this.
  }
  process.exit(0);
}
