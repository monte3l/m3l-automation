#!/usr/bin/env node
/**
 * SessionStart advisory: surfaces bin/check-node-version.mjs's findings before
 * any work starts, which is the only moment they're cheap. A session running
 * on the wrong Node major produces failures that look like regressions and
 * aren't — the m3l-console-server `readBigInts` case fails on Node 26 and is
 * green on CI's 24 — and that costs debugging time only until someone thinks
 * to check `node -v`. This makes the check unmissable instead. See ADR-0003's
 * 2026-08-31 amendment.
 *
 * Runs once per session (SessionStart, not PreToolUse/PostToolUse), the same
 * off-the-hot-path placement as warn-host-resources.mjs.
 *
 * Non-blocking: always exits 0, and fails open on any spawn/parse problem —
 * a broken advisory must never be the reason a session can't start. The
 * advisory prints to stderr so it surfaces in the transcript without gating.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? join(hooksDir, "../..");
const checkScript = join(projectDir, "bin/check-node-version.mjs");

const res = spawnSync("node", [checkScript, "--json"], {
  cwd: projectDir,
  encoding: "utf8",
});

if (res.error) process.exit(0); // node itself missing/failed — fail open

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  process.exit(0); // unparseable — fail open rather than block the session
}

// Static pin drift (errors) and the local runtime mismatch (warnings) are
// both worth surfacing here, but they mean different things: an error is a
// half-finished Node bump in the repo, a warning is this machine on the
// wrong major. Render whichever fired.
const errors = Array.isArray(report.errors) ? report.errors : [];
const warnings = Array.isArray(report.warnings) ? report.warnings : [];
if (errors.length === 0 && warnings.length === 0) process.exit(0);

const lines = [...errors, ...warnings].map((m) => `   - ${m}`).join("\n");
process.stderr.write(
  `⚡ node-version: ${errors.length} pin violation(s) and ` +
    `${warnings.length} runtime warning(s) against .node-version ` +
    `(pin: ${report.pinRaw ?? "unknown"}, running: ` +
    `${report.runtimeVersion ?? process.versions.node}):\n${lines}\n` +
    "   Run `pnpm check:node-version` for details.\n",
);
process.exit(0);
