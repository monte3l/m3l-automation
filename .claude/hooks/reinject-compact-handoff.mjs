#!/usr/bin/env node
/**
 * SessionStart (matcher `compact`): reads the handoff artifact
 * `write-compact-handoff.mjs` (`PreCompact`) wrote and re-injects it as
 * `additionalContext` — so post-compaction state reconstruction doesn't
 * depend on the summary having retained it (ADR-0078).
 *
 * Claude Code re-runs `SessionStart` hooks matching source `compact` after
 * an automatic or manual compaction — this is the read half of the
 * PreCompact/SessionStart pair; see `write-compact-handoff.mjs` for the
 * write half and the full rationale.
 *
 * Advisory-only: always exits 0. A missing or unreadable artifact (first
 * compaction ever, or the write hook failed) means nothing to inject —
 * silently no-op rather than surfacing a confusing "handoff not found"
 * line every time the artifact is legitimately absent.
 */
import process from "node:process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HANDOFF_REL_PATH } from "./write-compact-handoff.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/**
 * Render a handoff payload (as built by `write-compact-handoff.mjs`) into
 * the `additionalContext` string.
 *
 * @param {Record<string, any>} handoff
 * @returns {string}
 */
export function formatHandoff(handoff) {
  const lines = [
    "Post-compaction handoff (ADR-0078) — state captured just before this " +
      "session compacted:",
    `  • Branch: \`${handoff.branch || "(unknown)"}\` at \`${
      handoff.worktree || "(unknown)"
    }\``,
  ];

  const lastCommit = handoff.lastCommit;
  if (
    lastCommit &&
    typeof lastCommit === "object" &&
    typeof lastCommit.sha === "string"
  ) {
    lines.push(
      `  • Last commit: \`${lastCommit.sha.slice(0, 12)}\` ` +
        `(signature: \`${lastCommit.signature ?? "?"}\`)`,
    );
  }

  const uncommitted = Array.isArray(handoff.uncommittedFiles)
    ? handoff.uncommittedFiles
    : [];
  if (uncommitted.length > 0) {
    const shown = uncommitted.slice(0, 10);
    const more = uncommitted.length - shown.length;
    lines.push(
      `  • Uncommitted (${uncommitted.length}): ${shown.join(", ")}` +
        (more > 0 ? ` (+${more} more)` : ""),
    );
  }

  const journals = Array.isArray(handoff.journals) ? handoff.journals : [];
  if (journals.length > 0) {
    lines.push(`  • Scratchpad journal(s): ${journals.join(", ")}`);
  }

  lines.push(
    "Re-verify this against current `git status` before acting on it — it " +
      "is a snapshot from just before compaction, not necessarily still " +
      "current.",
  );
  return lines.join("\n");
}

/**
 * @param {string} handoffPath absolute path to the handoff artifact
 * @returns {Record<string, any> | null} parsed payload, or null if absent
 *   or unreadable/malformed
 */
export function readHandoff(handoffPath) {
  if (!existsSync(handoffPath)) return null;
  try {
    return JSON.parse(readFileSync(handoffPath, "utf8"));
  } catch {
    return null;
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

  // Belt-and-suspenders alongside the settings.json `matcher: "compact"`
  // registration — if the harness ever routes an unmatched SessionStart
  // here, stay silent rather than injecting a compaction handoff into a
  // fresh, non-compacted session. `input` can itself be `null` (valid JSON,
  // e.g. a bare `null` payload) — read defensively rather than assume it's
  // an object.
  if (input?.source !== "compact") process.exit(0);

  const handoffPath = join(root, HANDOFF_REL_PATH);
  const handoff = readHandoff(handoffPath);
  if (handoff === null) process.exit(0);

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatHandoff(handoff),
    },
  };
  process.stdout.write(JSON.stringify(output));

  // One-shot: a stale handoff re-injected after a SECOND compaction would
  // describe state from before the FIRST, no longer current. Consumed once.
  try {
    unlinkSync(handoffPath);
  } catch {
    // Not fatal — the next PreCompact overwrites it regardless.
  }
  process.exit(0);
}
