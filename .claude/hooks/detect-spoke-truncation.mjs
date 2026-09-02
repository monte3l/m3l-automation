#!/usr/bin/env node
/**
 * SubagentStop advisory: inspects a finished spoke's final message for the
 * signature of a mid-turn truncation (a spoke hitting its `maxTurns`
 * ceiling — `MAX_TURNS_CEILING` in bin/lib/agent-roster.mjs, enforced
 * against every spoke's frontmatter by bin/check-agents.mjs — or an
 * output-token cap hit mid-thought) and, on a hit, reminds the hub to
 * verify on-disk state before trusting the summary — instead of leaving
 * that detection entirely to the hub noticing on its own.
 *
 * Why: subagent mid-turn truncation is this repo's most-recurring build
 * divergence (see `docs/contributing/subagent-context-management.md`), and
 * until now every hook in the dispatch lifecycle fired **before** dispatch
 * (`guard-writer-dispatch-journal.mjs` on PreToolUse[Agent]) — nothing
 * inspected a spoke's OUTPUT after it returned. The manual playbook (never
 * trust a mid-thought "final" report; verify the journal + `git status` +
 * gates yourself) still works exactly as documented; this hook only makes
 * the trigger for reaching for that playbook automatic instead of relying on
 * the hub to notice a fragment on its own mid-conversation.
 *
 * Detector, not enforcer: this is advisory only (always exits 0), mirroring
 * `guard-writer-dispatch-journal.mjs`'s fail-open stance. SubagentStop fires
 * on every spoke finish — including the overwhelming majority that complete
 * cleanly — so false positives must stay cheap (one extra reminder line) and
 * the hook must stay quiet on a clean return, never on by default noise.
 * `looksTruncated` is a heuristic over prose, not a parse of the SDK's
 * `stop_reason`/`ResultMessage.subtype` (those aren't part of the hook
 * payload Claude Code exposes) — false negatives simply defer to the
 * existing reactive playbook, which remains the authoritative backstop.
 *
 * Payload shape: per the Claude Code hooks reference, a SubagentStop hook
 * receives (at minimum) `agent_id`, `agent_type`, and `last_assistant_message`
 * on stdin. Fields are read defensively (optional chaining, typeof guards)
 * since the exact payload isn't pinned down by a local schema — matching the
 * same tool-name caveat `guard-writer-dispatch-journal.mjs` documents for its
 * own PreToolUse payload.
 *
 * On a detected truncation, this hook also appends a durable record to
 * `tmp/session-incidents.jsonl` (rotated at the start of every session by
 * `rotate-session-incidents.mjs`) — continuous note-taking rather than a
 * point-in-time snapshot, so a spoke-incident count survives a mid-task
 * compaction the way two work logs found it did NOT
 * (`docs/logs/2026-08-29-aws-bedrock-runtime-tools.md`,
 * `docs/logs/2026-08-30-v7-agent-decision-log.md`). `writing-work-logs`
 * reads this file to populate its mandatory "Spoke incidents:" line. Only
 * `kind: "truncation"` is ever written here — this hook has no mechanical
 * way to detect a review-spoke stall (a duration threshold, not a message
 * shape) or a `SendMessage` resume (a different tool entirely); the
 * `IncidentRecord` shape stays a 3-way union so those kinds have a place to
 * land if a future hook gains the ability to detect them.
 */
import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
export const INCIDENTS_REL_PATH = "tmp/session-incidents.jsonl";

/**
 * @typedef {{
 *   timestamp: string,
 *   agentType: string,
 *   agentId?: string,
 *   kind: "truncation" | "stall" | "resume",
 * }} IncidentRecord
 */

/**
 * Append one incident record as a single JSON line. Advisory-only — a write
 * failure (`tmp/` unwritable) is swallowed silently, matching
 * `write-compact-handoff.mjs`'s fail-open stance; losing one incident record
 * is a hint the next work log can't draw on as cheaply, not a fatal failure
 * of the turn in progress.
 *
 * @param {IncidentRecord} record
 * @param {string} [cwd]
 */
export function appendIncident(record, cwd = root) {
  try {
    mkdirSync(join(cwd, "tmp"), { recursive: true });
    appendFileSync(
      join(cwd, INCIDENTS_REL_PATH),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    // Advisory-only — never block or fail a SubagentStop over this.
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Trailing phrases that signal the message was cut off mid-intent rather
 * than completed — the writer stated what it was about to do and then
 * stopped, the exact shape from `docs/contributing/subagent-context-management.md`'s
 * incident table (`"Now the config module —"`, `"Let me replace these
 * prepares."`). Matched case-insensitively against the END of the trimmed
 * message only, so a message that merely CONTAINS one of these phrases
 * mid-sentence and then continues past it is not flagged. */
const TRAILING_INTENT_PHRASES = [
  /\b(now|next|let'?s|let me|i'?ll|i will|going to)[^.!?]{0,40}$/i,
];

/**
 * @param {string | undefined} message
 * @returns {boolean} true if `message` looks like it was cut off mid-turn
 *   rather than completed — empty/missing, ends on a trailing ellipsis, or
 *   ends on a trailing-intent phrase ("Now the...", "Let me...") with
 *   nothing after it. Deliberately does NOT flag every message lacking
 *   terminal punctuation — a bounded digest legitimately ending on a bullet
 *   list or a bare count ("- Nits: 3 items") is a common CLEAN ending for a
 *   review spoke, and flagging it on every return would defeat the "quiet on
 *   a clean return" design goal. This trades recall (a truncated report that
 *   happens to end on a complete clause, e.g. `docs/logs/...` "Let me
 *   replace these prepares.", won't be caught) for a low false-positive
 *   rate; the existing reactive playbook remains the backstop either way.
 */
export function looksTruncated(message) {
  if (typeof message !== "string") return true;
  const trimmed = message.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.endsWith("...") || trimmed.endsWith("…")) return true;
  return TRAILING_INTENT_PHRASES.some((re) => re.test(trimmed));
}

/**
 * @param {string | undefined} agentType
 * @returns {string} the advisory body tailored to whether the finished spoke
 *   was a writer (journal-bearing) or a review/research spoke (no journal).
 */
function adviceFor(agentType) {
  const isWriter =
    typeof agentType === "string" && WRITER_SPOKES.has(agentType);
  if (isWriter) {
    return (
      `   Writer spokes hit their turn limit mid-thought often enough that this\n` +
      `   is this repo's most-recurring build divergence. Before trusting this\n` +
      `   report: re-read the spoke's journal, run \`git status\`/\`git diff\`, and\n` +
      `   consider \`mcp__m3l__spoke_recover\` (or \`bin/spoke-recovery.mjs\`)\n` +
      `   against its journal path for a resume/redispatch recommendation. If\n` +
      `   truncated, resume the SAME spoke via SendMessage — never a fresh\n` +
      `   dispatch.\n`
    );
  }
  return (
    `   Review/research spokes have no journal to recover from truncation —\n` +
    `   if this looks cut short, check whether the scope was too large (the\n` +
    `   athena/eventbridge/s3 pattern: 30-60+ min stalls on an unbounded diff)\n` +
    `   and re-dispatch with a tighter per-spoke file list rather than waiting\n` +
    `   longer on this one.\n`
  );
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

  const agentType = input.agent_type;
  const agentId = input.agent_id;
  const lastMessage = input.last_assistant_message;

  if (!looksTruncated(lastMessage)) process.exit(0);

  appendIncident({
    timestamp: new Date().toISOString(),
    agentType: typeof agentType === "string" ? agentType : "unknown",
    ...(typeof agentId === "string" ? { agentId } : {}),
    kind: "truncation",
  });

  process.stderr.write(
    `⚡ possible spoke truncation: "${String(agentType ?? "unknown")}"` +
      `${agentId ? ` (${String(agentId)})` : ""} finished with a message that\n` +
      `   looks cut off rather than completed — treat this report as unverified,\n` +
      `   not authoritative (see docs/contributing/subagent-context-management.md).\n` +
      adviceFor(agentType),
  );
  process.exit(0);
}
