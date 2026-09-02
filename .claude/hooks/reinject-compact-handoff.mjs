#!/usr/bin/env node
/**
 * SessionStart (matcher `compact|resume|startup`): reads the handoff
 * artifact `write-compact-handoff.mjs` (`PreCompact`) wrote and re-injects
 * it as `additionalContext` — so state reconstruction doesn't depend on the
 * summary having retained it (ADR-0078), whether the next session started
 * because of a compaction, a `--resume`/`--continue`, or a fresh `startup`
 * that inherits a worktree an earlier, since-killed session left dirty.
 *
 * `resume`/`startup` were added because the original `compact`-only
 * registration left a handoff written by a `PreCompact` whose session was
 * then killed (crash, OOM, Ctrl-C) sitting in `tmp/` forever — the next
 * session, on any source, never saw it. Anthropic's docs give `SessionEnd`
 * no guaranteed abnormal-termination signal, so the fix is on this read
 * side, not a new write-side hook.
 *
 * A `resume`/`startup` read has no one-compaction freshness guarantee the
 * way a `compact` read does (it may be reading a handoff several sessions
 * old), so `formatHandoff` flags anything older than 24h as likely stale.
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

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * True when `handoff.capturedAt` parses to a timestamp more than 24h before
 * `nowMs`. A malformed or missing `capturedAt` is never treated as stale —
 * silence here means "no age signal available", not "definitely fresh".
 *
 * @param {Record<string, any>} handoff
 * @param {number} [nowMs] injectable for testing; defaults to `Date.now()`
 * @returns {boolean}
 */
export function isStale(handoff, nowMs = Date.now()) {
  const capturedAt = handoff.capturedAt;
  if (typeof capturedAt !== "string") return false;
  const capturedMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedMs)) return false;
  return nowMs - capturedMs > STALE_THRESHOLD_MS;
}

/**
 * Render a handoff payload (as built by `write-compact-handoff.mjs`) into
 * the `additionalContext` string.
 *
 * @param {Record<string, any>} handoff
 * @param {number} [nowMs] injectable for testing; defaults to `Date.now()`
 * @returns {string}
 */
export function formatHandoff(handoff, nowMs = Date.now()) {
  const lines = [
    "Prior-session handoff (ADR-0078) — state captured just before an " +
      "earlier compaction, possibly from a session that has since ended:",
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

  if (isStale(handoff, nowMs)) {
    lines.push(
      "  ⚠ This handoff is more than 24h old — likely stale, verify " +
        "carefully before trusting it.",
    );
  }

  lines.push(
    "Re-verify this against current `git status` before acting on it — it " +
      "is a snapshot from just before compaction, not necessarily still " +
      "current.",
  );
  return lines.join("\n");
}

/** `SessionStart` `source` values this hook re-injects the handoff for. */
export const REINJECT_SOURCES = new Set(["compact", "resume", "startup"]);

/**
 * Belt-and-suspenders alongside the settings.json
 * `matcher: "compact|resume|startup"` registration — if the harness ever
 * routes an unmatched `SessionStart` here, stay silent rather than
 * injecting a handoff into a `clear`/`fork` session it wasn't meant for.
 * `input` can itself be `null` (valid JSON, e.g. a bare `null` payload) or
 * any other shape — read defensively rather than assume it's an object.
 * Extracted from the CLI entry block so this check is unit-testable without
 * spawning the script as a subprocess.
 *
 * @param {unknown} input the parsed `SessionStart` hook payload
 * @returns {boolean} true when this SessionStart's source is one this hook
 *   should re-inject the handoff for (compaction, resume, or startup)
 */
export function shouldReinject(input) {
  if (typeof input !== "object" || input === null) return false;
  const source = /** @type {{ source?: unknown }} */ (input).source;
  return typeof source === "string" && REINJECT_SOURCES.has(source);
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

  if (!shouldReinject(input)) process.exit(0);

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
