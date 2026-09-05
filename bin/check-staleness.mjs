#!/usr/bin/env node
// Warns (non-blocking) on post-merge local residue: a worktree, local
// branch, remote-tracking ref, or tmp/ file that a landed PR left behind.
// Issue #995 (ROADMAP row H2): `finishing-work` is invoked manually, never
// hook-triggered, so when it's skipped the residue accumulates in silence —
// a live audit of this repo's own checkout after four clean merges found
// 4 stale remote-tracking refs, 1 stale local branch, 1 stale worktree, and
// 1 orphaned spoke journal, none of it caught by any gate
// (docs/plans/archive/2026-09-02-session-continuity-remediation.md).
//
// Detection only — the fixes are the commands that already exist:
//   pnpm worktree:prune       # stale worktrees (bin/worktree-prune.mjs)
//   pnpm branch:cleanup <b>   # a stale branch never attached to a worktree
//   git fetch --prune         # stale remote-tracking refs
// A tmp/ orphan has no scripted fix — `finishing-work` Step 7 asks before
// deleting, since a journal from a still-in-progress branch can share the
// naming pattern of a genuinely orphaned one.
//
// Modelled on bin/check-retrospective.mjs (ADR-0084): same reporter, same
// always-exit-0 shape, same "no CI equivalent -> clean no-op" behaviour —
// CI's ephemeral checkout has no linked worktrees and no local branch
// history to speak of, so every finding class is naturally empty there.
// Offline-tolerant: a failed `git remote prune --dry-run` degrades to a
// warning about possibly-stale remote-tracking refs, never a failure.
//
// Usage:
//   node bin/check-staleness.mjs
//   node bin/check-staleness.mjs --json             # ADR-0030 structured report
//   node bin/check-staleness.mjs --journal-age <N>  # tmp/ staleness threshold (days)
//   node bin/check-staleness.mjs --no-fetch         # skip the remote-prune dry-run
//   pnpm check:staleness
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";
import {
  parseWorktreeList,
  mergedBranches,
  goneUpstreamBranches,
  isMergedDetached,
  classifyWorktrees,
} from "./lib/worktree-prune.mjs";
import {
  staleBranches,
  pendingRemotePrunes,
  orphanedTmpFiles,
  DEFAULT_STALE_DAYS,
} from "./lib/staleness-scan.mjs";

const root = repoRoot(import.meta.url);

/**
 * `tmp/`-relative file entries with their mtime, for {@link orphanedTmpFiles}.
 * Never throws — a missing `tmp/` directory (a fresh clone, CI) yields an
 * empty list rather than a findable error.
 *
 * @param {string} tmpDir absolute path to `tmp/`
 * @returns {{ relPath: string, mtimeMs: number }[]}
 */
export function listTmpEntries(tmpDir) {
  let names;
  try {
    names = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      relPath: `tmp/${entry.name}`,
      mtimeMs: statSync(join(tmpDir, entry.name)).mtimeMs,
    }));
}

/**
 * Run every residue-class scan against injected seams and report findings.
 * Returns the outcome rather than exiting, so tests can assert on it
 * directly — `ok: false` here does NOT mean a non-zero exit; the CLI guard
 * below always exits 0 (advisory only, per the header comment).
 *
 * @param {object} deps
 * @param {(args: string[]) => string} deps.runGit
 * @param {() => { relPath: string, mtimeMs: number }[]} deps.listTmp
 * @param {Date} deps.now
 * @param {number} deps.staleDays
 * @param {boolean} deps.fetchRemote whether to run the network-dependent remote-prune check
 * @param {ReturnType<typeof createReporter>} deps.reporter
 * @returns {{ ok: boolean, findings: string[] }}
 */
export function runStalenessCheck({
  runGit,
  listTmp,
  now,
  staleDays,
  fetchRemote,
  reporter,
}) {
  /** @type {string[]} */
  const findings = [];

  // Worktree records + branch/mergedness state, shared by the stale-worktree
  // and stale-branch-without-a-worktree checks below.
  let records = [];
  let worktreeBranches = new Set();
  let currentBranch = null;
  try {
    records = parseWorktreeList(runGit(["worktree", "list", "--porcelain"]));
    worktreeBranches = new Set(
      records.map((r) => r.branch).filter((b) => b !== null),
    );
    currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (cause) {
    reporter.warn(
      "check:staleness: could not read worktree/branch state — skipping " +
        `the worktree and stale-branch checks. (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
    );
  }

  if (currentBranch !== null) {
    try {
      const mergedSet = mergedBranches(runGit);
      const goneSet = goneUpstreamBranches(runGit);
      const here = resolve(process.cwd());
      const mainPath = records.length > 0 ? resolve(records[0].path) : null;

      const staleWorktrees = classifyWorktrees({
        records: records.map((r) => ({ ...r, path: resolve(r.path) })),
        mainPath,
        here,
        mergedSet,
        goneSet,
        isMergedDetachedFn: (sha) => isMergedDetached(sha, runGit),
      });
      for (const { record: w, reasons } of staleWorktrees) {
        findings.push(
          `Worktree \`${w.path}\` [${w.branch ?? "detached"}] is stale ` +
            `(${reasons.join(", ")}) — run \`pnpm worktree:prune\`.`,
        );
      }

      const stale = staleBranches({
        mergedSet,
        goneSet,
        worktreeBranches,
        currentBranch,
      });
      for (const { branch, reasons } of stale) {
        findings.push(
          `Local branch \`${branch}\` is stale (${reasons.join(", ")}) and ` +
            `attached to no worktree — run \`pnpm branch:cleanup ${branch}\`.`,
        );
      }
    } catch (cause) {
      reporter.warn(
        "check:staleness: could not evaluate merged/[gone] branches " +
          `(no local \`main\`?). (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
      );
    }
  }

  if (fetchRemote) {
    const { ok, refs, error } = pendingRemotePrunes(runGit);
    if (!ok) {
      reporter.warn(
        `check:staleness: \`git remote prune origin --dry-run\` failed ` +
          `(${error}) — remote-tracking-ref staleness could not be checked ` +
          "this run. Re-run with --no-fetch to silence this if offline.",
      );
    } else if (refs.length > 0) {
      findings.push(
        `${refs.length} remote-tracking ref(s) are stale: ${refs.join(", ")} ` +
          "— run `git fetch --prune`.",
      );
    }
  }

  const orphans = orphanedTmpFiles({ entries: listTmp(), now, staleDays });
  if (orphans.length > 0) {
    findings.push(
      `${orphans.length} tmp/ file(s) look orphaned (untouched ` +
        `${staleDays}+ days, not a known live-state file): ` +
        `${orphans.map((o) => `${o.relPath} (${o.ageDays}d)`).join(", ")} — ` +
        "review before deleting; a journal from a still-in-progress branch " +
        "can share the naming pattern.",
    );
  }

  for (const finding of findings) reporter.warn(finding);

  if (findings.length === 0) {
    reporter.succeed(
      "No post-merge residue found: no orphaned worktrees, branches, " +
        "remote-tracking refs, or tmp/ files.",
    );
  }

  reporter.finish({ findings });
  return { ok: findings.length === 0, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  const ageFlag = argv.indexOf("--journal-age");
  const staleDays =
    ageFlag !== -1 && argv[ageFlag + 1]
      ? Number.parseInt(argv[ageFlag + 1], 10)
      : DEFAULT_STALE_DAYS;
  const fetchRemote = !argv.includes("--no-fetch");

  runStalenessCheck({
    runGit: (args) =>
      execFileSync("git", args, { encoding: "utf8", cwd: root }).trim(),
    listTmp: () => listTmpEntries(resolve(root, "tmp")),
    now: new Date(),
    staleDays: Number.isNaN(staleDays) ? DEFAULT_STALE_DAYS : staleDays,
    fetchRemote,
    reporter,
  });

  // Advisory only — never blocks a merge, rebase, or push. See the header
  // comment and runStalenessCheck's own doc comment.
  process.exit(0);
}
