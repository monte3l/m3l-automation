#!/usr/bin/env node
/**
 * `Stop` hook: TTL-gates and detaches the out-of-band per-model weekly-usage
 * refresh (docs/adr/0092-out-of-band-usage-cache.md). `Stop` blocks the UI
 * until it exits, so this hook must never await the network itself — it does
 * one `statSync` on the cache file and either exits immediately (still fresh)
 * or spawns `bin/usage-cache.mjs` detached and exits without waiting for it.
 *
 * Free to use `node:child_process`: `bin/check-hooks.mjs`'s
 * `FORBIDDEN_STATUSLINE_PATTERNS` scan only checks the `statusLine`/
 * `subagentStatusLine` scripts (`STATUSLINE_SETTINGS_KEYS`) — this is a
 * `Stop` hook, not a wired statusline script, so ADR-0080's "no subprocess,
 * no network" invariant does not apply here; the invariant instead holds
 * because the statusline itself never reaches this file or the network.
 *
 * Non-blocking (exits 0 always) — a refresh failure surfaces only as a
 * missing/stale statusline segment, never as a Stop-hook error.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  isCacheFresh,
  resolveUsageCachePath,
  USAGE_CACHE_TTL_MS,
} from "../../bin/usage-cache.mjs";

// The cache is account-scoped (resolveUsageCachePath), not repo-relative, so
// this stat/spawn needs no CLAUDE_PROJECT_DIR to locate it — only to locate
// bin/usage-cache.mjs itself below.
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const cachePath = resolveUsageCachePath(homedir());

let mtimeMs = null;
try {
  mtimeMs = statSync(cachePath).mtimeMs;
} catch {
  // Cache file absent or unreadable — mtimeMs stays null (never fresh).
}

if (!isCacheFresh(mtimeMs, Date.now(), USAGE_CACHE_TTL_MS)) {
  const child = spawn(
    process.execPath,
    [join(projectDir, "bin", "usage-cache.mjs")],
    { cwd: projectDir, stdio: "ignore", detached: true },
  );
  child.unref();
}

process.exit(0);
