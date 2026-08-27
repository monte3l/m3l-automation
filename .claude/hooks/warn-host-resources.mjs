#!/usr/bin/env node
/**
 * SessionStart advisory: surfaces bin/check-host-resources.mjs's findings at
 * the one moment they matter most — before a session starts doing work that
 * can fan out to 30+ Node processes (pre-push) or add another ~1 GiB of
 * per-session overhead on top of whatever else is already running. See
 * docs/adr/0080-host-resource-budgeting.md.
 *
 * Runs once per session (SessionStart, not PreToolUse/PostToolUse) — the one
 * hook cost this PR adds, deliberately placed off the hot per-edit path.
 *
 * Non-blocking: always exits 0. The advisory prints to stderr so it surfaces
 * in the transcript without gating the session.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? join(hooksDir, "../..");
const checkScript = join(projectDir, "bin/check-host-resources.mjs");

const res = spawnSync("node", [checkScript, "--json"], {
  cwd: projectDir,
  encoding: "utf8",
});

if (res.status !== 0 && res.error) process.exit(0); // node itself missing/failed — fail open

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  process.exit(0); // unparseable — fail open rather than block the session
}

if (!Array.isArray(report.warnings) || report.warnings.length === 0) {
  process.exit(0);
}

process.stderr.write(
  `⚡ host-resources: ${report.warnings.length} mitigation(s) not in place ` +
    "for the multi-session OOM/livelock hazard:\n" +
    report.warnings.map((w) => `   - ${w}`).join("\n") +
    "\n   Run `pnpm check:host-resources` for details, or " +
    "`node bin/setup-host-resources.mjs` to apply fixes. " +
    "See docs/contributing/host-resources.md.\n",
);
process.exit(0);
