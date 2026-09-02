#!/usr/bin/env node
/**
 * SessionStart (no matcher — fires on every start): rotates
 * `tmp/session-incidents.jsonl` so a session's durable spoke-incident
 * records don't accumulate across sessions indefinitely.
 *
 * `detect-spoke-truncation.mjs` appends one record per detected truncation;
 * `writing-work-logs` reads the file near the end of the session that wrote
 * it, to populate the mandatory "Spoke incidents:" line, before that same
 * session ends. Rotating at the START of the NEXT session — rather than
 * never, since gitignored `tmp/` is otherwise unswept by any check — keeps
 * that next session's own incident count from being polluted by a prior
 * session's already-logged records; see the session-continuity remediation
 * plan's Decisions Q7.
 *
 * Advisory-only: always exits 0. A missing file or unwritable `tmp/` is a
 * silent no-op — there is nothing to rotate.
 */
import process from "node:process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { INCIDENTS_REL_PATH } from "./detect-spoke-truncation.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/**
 * @param {string} incidentsPath absolute path to the incidents file
 * @returns {boolean} true if a file existed and was removed
 */
export function rotate(incidentsPath) {
  if (!existsSync(incidentsPath)) return false;
  try {
    unlinkSync(incidentsPath);
    return true;
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Drain stdin (Claude Code pipes the hook payload) even though this hook
  // doesn't need any field from it — leaving it unread can leave the pipe
  // open under some harness/runtime combinations.
  for await (const _chunk of process.stdin) {
    // intentionally discarded
  }

  rotate(join(root, INCIDENTS_REL_PATH));
  process.exit(0);
}
