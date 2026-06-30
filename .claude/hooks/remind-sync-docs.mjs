#!/usr/bin/env node
/**
 * Stop hook advisory: emits non-blocking reminders when files edited during
 * the session need a follow-up check:
 *
 * 1. docs/implementation-status.md changed → remind to run /sync-docs
 *    (re-stamps provenance sidecars, verifies doc counts, lints markdown).
 *
 * 2. packages/m3l-common/tests/*.test.ts changed → remind to run
 *    `pnpm check:test-counts` to verify the Notes column counts are current.
 *
 * Non-blocking (exits 0 always). Advisories print to stderr so they surface
 * in the Claude Code transcript without blocking the session.
 */
import { execSync } from "node:child_process";
import process from "node:process";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function run(cmd) {
  try {
    return execSync(cmd, { cwd: projectDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function wasModified(pathSpec) {
  const uncommitted = run(`git status --porcelain -- "${pathSpec}"`);
  if (uncommitted.length > 0) return true;
  const recent = run(
    `git log --oneline --since="2 hours ago" -- "${pathSpec}"`,
  );
  return recent.length > 0;
}

// 1. Implementation-status drift — /sync-docs reconciles all doc metadata.
if (wasModified("docs/implementation-status.md")) {
  process.stderr.write(
    `⚡ /sync-docs reminder: docs/implementation-status.md was changed this session.\n` +
      `   Run \`/sync-docs\` to re-stamp provenance sidecars, verify doc counts,\n` +
      `   and lint markdown before committing.\n`,
  );
}

// 2. Test-file counts — recorded counts in the Notes column may be stale.
if (wasModified("packages/m3l-common/tests/")) {
  process.stderr.write(
    `⚡ test-counts reminder: test files were modified this session.\n` +
      `   Run \`pnpm check:test-counts\` to verify the counts recorded in\n` +
      `   docs/implementation-status.md still match the actual Vitest output.\n`,
  );
}

process.exit(0);
