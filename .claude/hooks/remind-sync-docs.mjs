#!/usr/bin/env node
/**
 * Stop hook advisory: if docs/implementation-status.md was modified during
 * the session (staged, unstaged, or recently committed), remind to run
 * /sync-docs before the next commit.
 *
 * Non-blocking (exits 0 always). The advisory prints to stderr so it
 * surfaces in the Claude Code transcript without blocking.
 *
 * Trigger: docs/implementation-status.md changed → a submodule likely
 * shipped and provenance sidecars + doc counts need reconciling.
 */
import { execSync } from "node:child_process";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const target = "docs/implementation-status.md";

function run(cmd) {
  try {
    return execSync(cmd, { cwd: projectDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// 1. Check for uncommitted changes (staged or unstaged).
const gitStatus = run(`git status --porcelain -- "${target}"`);
const hasUncommitted = gitStatus.length > 0;

// 2. Check for a recent commit touching the file (within the last 2 hours)
//    as a proxy for "edited this session."
const recentCommit = run(
  `git log --oneline --since="2 hours ago" -- "${target}"`,
);
const hasRecentCommit = recentCommit.length > 0;

if (hasUncommitted || hasRecentCommit) {
  process.stderr.write(
    `⚡ /sync-docs reminder: ${target} was changed this session.\n` +
      `   Run \`/sync-docs\` to re-stamp provenance sidecars, verify doc counts,\n` +
      `   and lint markdown before committing.\n`,
  );
}

process.exit(0);
