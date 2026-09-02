#!/usr/bin/env node
/**
 * SessionStart (matcher `startup|clear`): rotates
 * `tmp/session-incidents.jsonl` and `tmp/spoke-lifecycle.jsonl` so a
 * session's durable spoke records don't accumulate across sessions
 * indefinitely.
 *
 * `detect-spoke-truncation.mjs` appends one record per detected truncation;
 * `writing-work-logs` reads the file near the end of the session that wrote
 * it, to populate the mandatory "Spoke incidents:" line, before that same
 * session ends. `track-inflight-spokes.mjs` appends one record per
 * `SubagentStart`/`SubagentStop`, read live by
 * `statusline-context-pressure.mjs`'s in-flight-spoke segment. Rotating at
 * the START of a genuinely NEW session — rather than never, since gitignored
 * `tmp/` is otherwise unswept by any check — keeps that next session's own
 * records from being polluted by a prior session's already-logged ones; see
 * the session-continuity remediation plan's Decisions Q7.
 *
 * Deliberately scoped to `startup`/`clear` only, NOT `compact`/`resume`: a
 * `claude-pr-review.yml` Must-fix on the PR that introduced this hook
 * (originally wired to a matcher-less `SessionStart` block, firing on every
 * source) caught that rotating on `compact` deletes the SAME session's
 * already-recorded incidents the moment a mid-task auto-compaction fires —
 * the exact loss this feature exists to prevent — and rotating on `resume`
 * would erase evidence from a crashed session before anything (a future
 * `writing-work-logs` run, a human) gets to read it, defeating the
 * interruption-resume story Slices 1–2 of the same plan built. Only
 * `startup` (a fresh process with no in-flight session to protect) and
 * `clear` (an explicit user reset) are safe to rotate on.
 *
 * Advisory-only: always exits 0. A missing file or unwritable `tmp/` is a
 * silent no-op — there is nothing to rotate.
 */
import process from "node:process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { INCIDENTS_REL_PATH } from "./detect-spoke-truncation.mjs";
import { SPOKE_LIFECYCLE_REL_PATH } from "./track-inflight-spokes.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/** `SessionStart` `source` values this hook rotates the incidents file for. */
export const ROTATE_SOURCES = new Set(["startup", "clear"]);

/**
 * Belt-and-suspenders alongside the settings.json `matcher: "startup|clear"`
 * registration — if the harness ever routes an unmatched `SessionStart`
 * here, stay silent rather than rotating a `compact`/`resume` session's own
 * in-flight incident records. `input` can itself be `null` (valid JSON) or
 * any other shape — read defensively rather than assume it's an object.
 * Extracted from the CLI entry block so this check is unit-testable without
 * spawning the script as a subprocess.
 *
 * @param {unknown} input the parsed `SessionStart` hook payload
 * @returns {boolean} true when this SessionStart's source is one this hook
 *   should rotate the incidents file for (startup or clear)
 */
export function shouldRotate(input) {
  if (typeof input !== "object" || input === null) return false;
  const source = /** @type {{ source?: unknown }} */ (input).source;
  return typeof source === "string" && ROTATE_SOURCES.has(source);
}

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
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }

  if (!shouldRotate(input)) process.exit(0);

  rotate(join(root, INCIDENTS_REL_PATH));
  rotate(join(root, SPOKE_LIFECYCLE_REL_PATH));
  process.exit(0);
}
