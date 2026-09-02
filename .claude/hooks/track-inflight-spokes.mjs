#!/usr/bin/env node
/**
 * SubagentStart + SubagentStop: appends one lifecycle record per event to
 * `tmp/spoke-lifecycle.jsonl` so `statusline-context-pressure.mjs` can render
 * how many spokes are currently in flight and for how long — the gap an
 * `/auditing` pass on status reporting found: every existing spoke-lifecycle
 * hook (`guard-writer-dispatch-journal.mjs` on dispatch,
 * `detect-spoke-truncation.mjs` on finish) is hub-facing or after-the-fact,
 * and nothing reports live progress to the USER while a fan-out is running.
 * Review-spoke fan-outs have stalled 30-60+ min with zero visible signal on
 * four recorded occasions (`docs/logs/2026-07-18-aws-athena.md`,
 * `2026-07-18-aws-s3.md`, `2026-07-19-subagent-stall-integration.md`,
 * `2026-08-21-core-procedure.md`); this hook is the passive, always-visible
 * counterpart — no watchdog, no alarm, just an honest elapsed-time readout
 * the user can judge for themselves, matching this project's Anthropic-guidance
 * research: prefer a passive surface over a polling/alarm mechanism.
 *
 * Append-only JSONL, not a read-modify-write JSON object — two spokes
 * starting or stopping simultaneously would race on the latter, and this
 * mirrors `detect-spoke-truncation.mjs`'s own `tmp/session-incidents.jsonl`
 * pattern. The statusline resolves "currently in flight" by reducing the
 * file to `start` records with no matching `stop` (see
 * `statusline-context-pressure.mjs`'s `resolveInflightSpokes`).
 *
 * Rotated by `rotate-session-incidents.mjs` (`SessionStart`,
 * `matcher: "startup|clear"`) alongside `session-incidents.jsonl`, for the
 * same reason documented there: `startup` starts from a genuinely empty
 * process with nothing in flight to protect, `clear` is an explicit user
 * reset, and `compact`/`resume` are deliberately excluded — a mid-task
 * compaction or a crash-resume must never erase a session's own in-flight
 * spoke records, the same protection that file's header explains in full.
 *
 * Advisory-only: always exits 0, and a write failure (`tmp/` unwritable) is
 * swallowed silently — losing one lifecycle record degrades the statusline
 * segment, never a spoke dispatch itself.
 */
import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
export const SPOKE_LIFECYCLE_REL_PATH = "tmp/spoke-lifecycle.jsonl";

/** The two `hook_event_name` values this hook is wired to. */
export const LIFECYCLE_EVENTS = new Set(["SubagentStart", "SubagentStop"]);

/**
 * @typedef {{
 *   event: "start" | "stop",
 *   agentId?: string,
 *   agentType: string,
 *   ts: string,
 * }} LifecycleRecord
 */

/**
 * @param {unknown} hookEventName the payload's `hook_event_name` field
 * @returns {"start" | "stop" | null} the lifecycle event this maps to, or
 *   null when the payload names an event this hook isn't wired for.
 */
export function eventKindFor(hookEventName) {
  if (hookEventName === "SubagentStart") return "start";
  if (hookEventName === "SubagentStop") return "stop";
  return null;
}

/**
 * Append one lifecycle record as a single JSON line. Advisory-only — a write
 * failure is swallowed silently, matching `appendIncident`'s fail-open
 * stance in `detect-spoke-truncation.mjs`.
 *
 * @param {LifecycleRecord} record
 * @param {string} [cwd]
 */
export function appendLifecycleRecord(record, cwd = root) {
  try {
    mkdirSync(join(cwd, "tmp"), { recursive: true });
    appendFileSync(
      join(cwd, SPOKE_LIFECYCLE_REL_PATH),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    // Advisory-only — never block a spoke dispatch or return over this.
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const kind = eventKindFor(input?.hook_event_name);
  if (kind === null) process.exit(0);

  const agentType = input.agent_type;
  const agentId = input.agent_id;

  appendLifecycleRecord({
    event: kind,
    ...(typeof agentId === "string" ? { agentId } : {}),
    agentType: typeof agentType === "string" ? agentType : "unknown",
    ts: new Date().toISOString(),
  });

  process.exit(0);
}
