#!/usr/bin/env node
// Runs after a `git rebase` (post-rewrite) or `git merge` (post-merge)
// completes, regenerating the derived files that the m3l-generated merge
// driver deliberately left un-regenerated (bin/merge-driver-generated.mjs
// only keeps the current side; it never runs a generator mid-merge, since
// the working tree is half-merged at that point).
//
// Contract: NEVER auto-commits (signing + Conventional-Commit flow stays in
// the operator's hands — see `docs: reconcile doc metadata` in
// docs/contributing/*) and ALWAYS exits 0 (a regeneration failure prints a
// warning but never blocks the rebase/merge that just completed).
//
// Usage:
//   node bin/post-integrate-regen.mjs
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The regeneration commands to run, in order. `pnpm-lock.yaml` is tagged
 * `merge=m3l-generated` (.gitattributes) alongside catalog.json/symbol-map.json,
 * but unlike those two it isn't rebuilt from other repo state — it has to be
 * re-derived from `package.json` via `pnpm install`. Without this, a
 * driver-resolved lockfile conflict (kept the current side) can silently
 * drift out of sync with a `package.json` that merged in new dependencies,
 * caught only much later by CI's `--frozen-lockfile` on an unrelated PR.
 * `pnpm install` only runs when `pnpm-lock.yaml` is actually dirty, so a
 * rebase/merge that never touched it doesn't pay the cost every time.
 *
 * @param {boolean} [lockfileDirty]
 * @returns {[string, string[]][]}
 */
export function regenerationCommands(lockfileDirty = false) {
  const commands = [
    ["node", ["bin/gen-reference-index.mjs"]],
    ["node", ["bin/gen-doc-counts.mjs"]],
    ["node", ["bin/check-doc-provenance.mjs", "--update"]],
  ];
  if (lockfileDirty) {
    commands.push(["pnpm", ["install"]]);
  }
  return commands;
}

/**
 * Default command runner: throws with the process's stderr/stdout on a
 * non-zero exit, so {@link runRegeneration}'s try/catch can turn it into a
 * warning rather than an uncaught crash.
 *
 * @param {string} cmd
 * @param {string[]} args
 */
function defaultRun(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      (res.stderr ?? res.stdout ?? "").trim() ||
        `exited with status ${String(res.status)}`,
    );
  }
}

/**
 * Run every regeneration command, collecting a warning per failure instead
 * of throwing — regeneration failure must never block the rebase/merge that
 * just completed.
 *
 * @param {(cmd: string, args: string[]) => void} [runCmd]
 * @param {boolean} [lockfileDirty]
 * @returns {string[]} human-readable warnings, one per failed command
 */
export function runRegeneration(runCmd = defaultRun, lockfileDirty = false) {
  const warnings = [];
  for (const [cmd, args] of regenerationCommands(lockfileDirty)) {
    try {
      runCmd(cmd, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${cmd} ${args.join(" ")} failed: ${message}`);
    }
  }
  return warnings;
}

/**
 * Default git runner for the dirty-file scan; returns raw stdout.
 *
 * @param {string[]} args
 * @returns {string}
 */
function defaultRunGit(args) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return res.stdout ?? "";
}

/**
 * The repo-relative paths `git status --porcelain` reports as changed,
 * after regeneration. Pure parse of the porcelain output — testable without
 * a real git call.
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {string[]}
 */
export function dirtyFiles(runGit = defaultRunGit) {
  const out = runGit(["status", "--porcelain"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^\S+\s+/, ""));
}

/**
 * Whether `pnpm-lock.yaml` is currently dirty (e.g. the merge driver kept
 * the current side on a real conflict, or the merge otherwise touched it).
 * Checked before regeneration so {@link runRegeneration} only pays for
 * `pnpm install` when there's actually something to reconcile.
 *
 * @param {(args: string[]) => string} [runGit]
 * @returns {boolean}
 */
export function isLockfileDirty(runGit = defaultRunGit) {
  return (
    runGit(["status", "--porcelain", "--", "pnpm-lock.yaml"]).trim().length > 0
  );
}

if (process.argv[1]?.endsWith("post-integrate-regen.mjs")) {
  const warnings = runRegeneration(undefined, isLockfileDirty());
  for (const w of warnings) {
    console.error(`⚠  post-integrate-regen: ${w}`);
  }

  const dirty = dirtyFiles();
  if (dirty.length > 0) {
    console.log(
      `ℹ  post-integrate-regen: ${dirty.length} file(s) regenerated or still dirty:`,
    );
    for (const f of dirty) console.log(`   - ${f}`);
    console.log(
      '   Review and commit them, e.g.: git add -A && git commit -S -m "docs: reconcile doc metadata"',
    );
  } else {
    console.log("✓  post-integrate-regen: nothing to reconcile.");
  }

  // Never block the rebase/merge that just completed.
  process.exit(0);
}
