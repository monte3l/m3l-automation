#!/usr/bin/env node
/**
 * statusLine: renders live context-window pressure and, once past a high
 * threshold, a ready-to-run `/compact` suggestion built from data already in
 * the same payload (docs/research/harness-refresh.md Outstanding drift #10).
 *
 * `statusLine` is confirmed as the *only* documented surface exposing live
 * `context_window.used_percentage` — no hook event receives token/context
 * data (`docs/research/harness-refresh.md`), so this is the one place a
 * "when to compact" signal can live at all. It composes with, rather than
 * replaces, the existing `PreCompact`/`SessionStart(compact)` handoff pair
 * (`write-compact-handoff.mjs` / `reinject-compact-handoff.mjs`): this tells
 * the user *when*, those hooks handle *what survives* once `/compact` runs.
 *
 * Deliberately pure JSON-in, string-out — no `git`/network calls. The
 * statusLine script runs on every new assistant message (debounced 300ms,
 * a new trigger cancels an in-flight run — code.claude.com/docs/en/statusline
 * "How status lines work"), so a subprocess spawn here would add latency to
 * the most frequent hook trigger in the whole harness; every field this
 * script needs (`context_window.*`, `pr.number`, `workspace.git_worktree`)
 * already arrives on stdin. This also sidesteps the pinned-`statusLine`
 * resource lesson in `docs/adr/0080-host-resource-budgeting.md` — that
 * incident was an `npx`-resolved third-party script re-hitting the npm
 * registry every render; this is a plain local `node` invocation, identical
 * in cost to every other hook already wired in `.claude/settings.json`.
 *
 * Threshold values (70 / 90) match Anthropic's own documented multi-line
 * status-line example (green under 70, yellow 70-89, red 90+) rather than
 * inventing repo-specific numbers.
 *
 * Advisory-only: any parse or read failure falls back to a minimal
 * `ctx --%` segment rather than an empty or broken status line.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

export const WARN_THRESHOLD_PERCENT = 70;
export const HIGH_THRESHOLD_PERCENT = 90;

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * @param {unknown} payload the parsed statusLine stdin JSON
 * @returns {number | null} `context_window.used_percentage`, rounded, or
 *   null when the session has no context-window data yet (before the first
 *   API response, or immediately after `/compact`).
 */
export function resolveUsedPercentage(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const contextWindow = /** @type {{ context_window?: unknown }} */ (payload)
    .context_window;
  if (typeof contextWindow !== "object" || contextWindow === null)
    return null;
  const pct = /** @type {{ used_percentage?: unknown }} */ (contextWindow)
    .used_percentage;
  return typeof pct === "number" && Number.isFinite(pct)
    ? Math.round(pct)
    : null;
}

/**
 * @param {number | null} pct
 * @returns {"unknown" | "ok" | "warn" | "high"}
 */
export function zoneForPercentage(pct) {
  if (pct === null) return "unknown";
  if (pct >= HIGH_THRESHOLD_PERCENT) return "high";
  if (pct >= WARN_THRESHOLD_PERCENT) return "warn";
  return "ok";
}

/**
 * @param {unknown} payload
 * @returns {string} a colorized `ctx NN%` segment, `ctx --%` when unknown.
 */
export function formatContextSegment(payload) {
  const pct = resolveUsedPercentage(payload);
  const zone = zoneForPercentage(pct);
  if (zone === "unknown") return `${GREEN}ctx --%${RESET}`;
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  const icon = zone === "high" ? " ⚠⚠" : zone === "warn" ? " ⚠" : "";
  return `${color}ctx ${pct}%${icon}${RESET}`;
}

/**
 * Best-effort "where am I" clause built only from fields already on the
 * payload — never derived by shelling out (see file header).
 *
 * @param {unknown} payload
 * @returns {string | null}
 */
export function describeContextLocation(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const parts = [];

  const pr = /** @type {{ number?: unknown } | undefined} */ (p.pr);
  if (pr && typeof pr === "object" && typeof pr.number === "number") {
    parts.push(`PR #${pr.number}`);
  }

  const workspace = /** @type {{ git_worktree?: unknown } | undefined} */ (
    p.workspace
  );
  const worktreeName =
    workspace && typeof workspace === "object" ? workspace.git_worktree : undefined;
  if (typeof worktreeName === "string" && worktreeName.length > 0) {
    parts.push(`worktree "${worktreeName}"`);
  }

  return parts.length > 0 ? parts.join(" on ") : null;
}

/**
 * Mirrors CLAUDE.md's `## Compact Instructions` preserve-list dynamically
 * instead of leaving it as static prose the user has to remember. Only
 * offered once the high threshold is crossed — below that, a suggestion
 * would be premature.
 *
 * @param {unknown} payload
 * @returns {string | null}
 */
export function buildCompactSuggestion(payload) {
  const pct = resolveUsedPercentage(payload);
  if (zoneForPercentage(pct) !== "high") return null;
  const location = describeContextLocation(payload);
  const prefix = location ? `${location}, ` : "";
  return `/compact preserve ${prefix}the failing gate's exact error text, and the current plan/ADR step`;
}

/**
 * @param {unknown} payload
 * @returns {string} the full status-line output.
 */
export function renderStatusLine(payload) {
  const segment = formatContextSegment(payload);
  const suggestion = buildCompactSuggestion(payload);
  return suggestion ? `${segment} → ${suggestion}` : segment;
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let output;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    output = renderStatusLine(payload);
  } catch {
    output = `${GREEN}ctx --%${RESET}`;
  }

  process.stdout.write(output);
  process.exit(0);
}
