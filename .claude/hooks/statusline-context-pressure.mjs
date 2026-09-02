#!/usr/bin/env node
/**
 * statusLine: renders live context-window pressure, a small widget set
 * (model/effort, session usage, rate-limit countdowns, cache state, branch,
 * worktree/PR, agent, in-flight spoke count, origin repo, free memory) and,
 * once past a high threshold, a ready-to-run `/compact` suggestion — all
 * built from data already in the same payload (docs/research/harness-refresh.md
 * Outstanding drift #10; broadened for ccstatusline parity per issue #879)
 * plus one local state file for the in-flight-spoke count
 * (`tmp/spoke-lifecycle.jsonl`, written by `track-inflight-spokes.mjs`).
 *
 * The in-flight-spoke segment is this project's answer to a gap an
 * `/auditing` pass on status reporting found: nothing surfaced intermediate
 * progress to the user during a review-spoke fan-out that had stalled
 * 30-60+ min on four recorded occasions. It is deliberately passive — an
 * elapsed-time readout, not a watchdog or alarm — matching the
 * Anthropic-guidance research behind it: prefer a push/passive surface over
 * a polling mechanism.
 *
 * `statusLine` is confirmed as the *only* documented surface exposing live
 * `context_window.used_percentage` — no hook event receives token/context
 * data (`docs/research/harness-refresh.md`), so this is the one place a
 * "when to compact" signal can live at all. It composes with, rather than
 * replaces, the existing `PreCompact`/`SessionStart(compact)` handoff pair
 * (`write-compact-handoff.mjs` / `reinject-compact-handoff.mjs`): this tells
 * the user *when*, those hooks handle *what survives* once `/compact` runs.
 *
 * Invariant: **no subprocess, no network** (not "no git calls" — this file
 * reads `.git/HEAD` directly via `node:fs`, a local synchronous file read,
 * not a `git` shell-out). The statusLine script runs on every new assistant
 * message (debounced 300ms, a new trigger cancels an in-flight run —
 * code.claude.com/docs/en/statusline "How status lines work"), so a
 * subprocess spawn here would add latency to the most frequent hook trigger
 * in the whole harness; a synchronous local read has none of that cost, so a
 * raw file read is fine where a `git` shell-out wasn't. `os.freemem()` /
 * `os.totalmem()` are the same class of exception: both are local syscalls,
 * not network or subprocess calls. Reading `tmp/spoke-lifecycle.jsonl` is the
 * same class again — bounded, synchronous, local, and rotated at every
 * `SessionStart(startup|clear)` so it never grows unbounded across sessions.
 * Every other field this script needs
 * (`context_window.*`, `pr.number`, `workspace.git_worktree`, `model`,
 * `effort`, `cost`, `rate_limits`, `prompt_cache`, `agent`) already arrives
 * on stdin. This also sidesteps the pinned-`statusLine` resource lesson in
 * `docs/adr/0080-host-resource-budgeting.md` — that incident was an
 * `npx`-resolved third-party script re-hitting the npm registry every
 * render; this is a plain local `node` invocation plus two syscalls and a
 * bounded local file read, identical in cost class to every other hook
 * already wired in `.claude/settings.json`.
 *
 * Threshold values (70 / 90) match Anthropic's own documented multi-line
 * status-line example (green under 70, yellow 70-89, red 90+) rather than
 * inventing repo-specific numbers.
 *
 * Advisory-only: any parse or read failure falls back to a minimal
 * `ctx --%` segment rather than an empty or broken status line.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SPOKE_LIFECYCLE_REL_PATH } from "./track-inflight-spokes.mjs";

export const WARN_THRESHOLD_PERCENT = 70;
export const HIGH_THRESHOLD_PERCENT = 90;

export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const RESET = "\x1b[0m";
export const BLUE = "\x1b[34m";
export const CYAN = "\x1b[36m";
export const BRIGHT_WHITE = "\x1b[97m";
export const BRIGHT_RED = "\x1b[91m";
export const BRIGHT_BLUE = "\x1b[94m";
export const BRIGHT_CYAN = "\x1b[96m";
export const BRIGHT_GREEN = "\x1b[92m";
export const DIM = "\x1b[2m";
export const SEGMENT_JOIN = "  ";

/**
 * @param {unknown} payload the parsed statusLine stdin JSON
 * @returns {number | null} `context_window.used_percentage`, rounded and
 *   clamped to `[0, 100]`, or null when the session has no context-window
 *   data yet (before the first API response, or immediately after
 *   `/compact`).
 */
export function resolveUsedPercentage(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const contextWindow = /** @type {{ context_window?: unknown }} */ (payload)
    .context_window;
  if (typeof contextWindow !== "object" || contextWindow === null) return null;
  const pct = /** @type {{ used_percentage?: unknown }} */ (contextWindow)
    .used_percentage;
  return typeof pct === "number" && Number.isFinite(pct)
    ? Math.min(100, Math.max(0, Math.round(pct)))
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
    workspace && typeof workspace === "object"
      ? workspace.git_worktree
      : undefined;
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
 * A small `[▓▓▓░░░░░░░]`-style bar mirroring `formatContextSegment`'s zone
 * coloring, for a denser at-a-glance read.
 *
 * @param {unknown} payload
 * @returns {string | null} colorized 10-cell bar, or null when the payload
 *   has no context-window data yet.
 */
export function formatContextBar(payload) {
  const pct = resolveUsedPercentage(payload);
  if (pct === null) return null;
  const zone = zoneForPercentage(pct);
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  const filled = Math.round(pct / 10);
  return `${color}[${"▓".repeat(filled)}${"░".repeat(10 - filled)}]${RESET}`;
}

/**
 * The repo's Claude Code session-naming convention (ADR-0087,
 * `docs/contributing/contributing.md` § Session naming): `<kind>-<slug>`,
 * `kind` from a closed set reusing the branch-prefix/Conventional-Commit
 * vocabulary.
 */
export const SESSION_NAME_PATTERN =
  /^(feat|fix|audit|research|docs|review|ci|merge)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SESSION_NAME_MAX_LENGTH = 40;

/**
 * Always renders, unlike most segments here — absence of a conforming name
 * is exactly the signal this segment exists to surface (ADR-0087). No hook
 * can set a session name, so `payload.session_name` carries whatever the
 * session happens to have: the AI-generated first-prompt title when nothing
 * was set explicitly. A present/absent check alone would therefore pass most
 * sessions while conforming to nothing — this validates the *value* against
 * the convention's pattern instead, the same way `formatBranch` flags `main`
 * rather than merely checking a branch name is present.
 *
 * @param {unknown} payload
 * @returns {string} the colorized session name when it conforms to the
 *   convention, or a dim/flagged marker (`unnamed`, or the non-conforming
 *   name itself) otherwise — never null.
 */
export function formatSessionNameSegment(payload) {
  const name =
    typeof payload === "object" && payload !== null
      ? /** @type {{ session_name?: unknown }} */ (payload).session_name
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return `${DIM}unnamed${RESET}`;
  }
  const conforms =
    name.length <= SESSION_NAME_MAX_LENGTH && SESSION_NAME_PATTERN.test(name);
  return conforms ? `${GREEN}${name}${RESET}` : `${YELLOW}⚠ ${name}${RESET}`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized model display name, or null when
 *   absent.
 */
export function formatModelSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const model = /** @type {{ model?: unknown }} */ (payload).model;
  if (typeof model !== "object" || model === null) return null;
  const name = /** @type {{ display_name?: unknown }} */ (model).display_name;
  return typeof name === "string" && name.length > 0
    ? `${BLUE}${name}${RESET}`
    : null;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized effort level, or null when absent.
 */
export function formatEffortSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const effort = /** @type {{ effort?: unknown }} */ (payload).effort;
  if (typeof effort !== "object" || effort === null) return null;
  const level = /** @type {{ level?: unknown }} */ (effort).level;
  return typeof level === "string" && level.length > 0
    ? `${CYAN}${level}${RESET}`
    : null;
}

/**
 * Compact token-count formatter (`45000` -> `"45k"`, `15500` -> `"15.5k"`).
 *
 * @param {number} n always finite when called.
 * @returns {string}
 */
export function formatTokenCount(n) {
  if (Math.abs(n) < 1000) return String(Math.round(n));
  const kk = n / 1000;
  const rounded = Math.round(kk * 10) / 10;
  return Number.isInteger(rounded)
    ? `${rounded.toFixed(0)}k`
    : `${rounded.toFixed(1)}k`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized `$cost` and/or `in↑ out↓` token totals,
 *   or null when neither is available.
 */
export function formatSessionUsage(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const parts = [];

  const cost = /** @type {{ total_cost_usd?: unknown } | undefined} */ (p.cost);
  const totalCost =
    cost && typeof cost === "object" ? cost.total_cost_usd : undefined;
  if (typeof totalCost === "number" && Number.isFinite(totalCost)) {
    parts.push(`$${totalCost.toFixed(2)}`);
  }

  const contextWindow =
    /**
     * @type {{ total_input_tokens?: unknown; total_output_tokens?: unknown } | undefined}
     */ (p.context_window);
  if (contextWindow && typeof contextWindow === "object") {
    const tin = contextWindow.total_input_tokens;
    const tout = contextWindow.total_output_tokens;
    if (
      typeof tin === "number" &&
      Number.isFinite(tin) &&
      typeof tout === "number" &&
      Number.isFinite(tout)
    ) {
      parts.push(`${formatTokenCount(tin)}↑ ${formatTokenCount(tout)}↓`);
    }
  }

  return parts.length > 0
    ? `${BRIGHT_WHITE}${parts.join(" · ")}${RESET}`
    : null;
}

/**
 * @param {number} deltaSec seconds remaining, may be negative/zero.
 * @returns {string} `"now"`, `"NNm"`, or `"NhMMm"`.
 */
export function formatDuration(deltaSec) {
  if (deltaSec <= 0) return "now";
  const h = Math.floor(deltaSec / 3600);
  const m = Math.floor((deltaSec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env `now` overrides `Date.now()`
 *   for deterministic tests.
 * @returns {string | null} colorized five-hour rate-limit countdown, or
 *   null when absent.
 */
export function formatResetCountdown(payload, env) {
  if (typeof payload !== "object" || payload === null) return null;
  const rateLimits = /** @type {{ rate_limits?: unknown }} */ (payload)
    .rate_limits;
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const fiveHour = /** @type {{ five_hour?: unknown }} */ (rateLimits)
    .five_hour;
  if (typeof fiveHour !== "object" || fiveHour === null) return null;
  const resetsAt = /** @type {{ resets_at?: unknown }} */ (fiveHour).resets_at;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const nowMs = typeof env?.now === "number" ? env.now : Date.now();
  const deltaSec = Math.floor(resetsAt - nowMs / 1000);
  return `${BRIGHT_RED}reset ${formatDuration(deltaSec)}${RESET}`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized seven-day (weekly) rate-limit reset
 *   date/time in UTC, or null when absent.
 */
export function formatWeeklyReset(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const rateLimits = /** @type {{ rate_limits?: unknown }} */ (payload)
    .rate_limits;
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const sevenDay = /** @type {{ seven_day?: unknown }} */ (rateLimits)
    .seven_day;
  if (typeof sevenDay !== "object" || sevenDay === null) return null;
  const resetsAt = /** @type {{ resets_at?: unknown }} */ (sevenDay).resets_at;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const HH = String(date.getUTCHours()).padStart(2, "0");
  const MM = String(date.getUTCMinutes()).padStart(2, "0");
  return `${BRIGHT_BLUE}week ${mm}-${dd} ${HH}:${MM}Z${RESET}`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized prompt-cache state, or null when
 *   absent/malformed.
 */
export function formatCacheWidget(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const pc = /** @type {{ prompt_cache?: unknown }} */ (payload).prompt_cache;
  if (typeof pc !== "object" || pc === null) return null;
  const cache =
    /**
     * @type {{ warm?: unknown; hit_ratio?: unknown; recache_tokens_if_cold?: unknown }}
     */ (pc);
  if (typeof cache.warm !== "boolean") return null;

  if (cache.warm === true) {
    const hitRatio = cache.hit_ratio;
    return typeof hitRatio === "number" && Number.isFinite(hitRatio)
      ? `${GREEN}cache ${Math.round(hitRatio * 100)}%${RESET}`
      : `${GREEN}cache warm${RESET}`;
  }

  const recacheTokens = cache.recache_tokens_if_cold;
  return typeof recacheTokens === "number" && Number.isFinite(recacheTokens)
    ? `${YELLOW}cache cold · ${formatTokenCount(recacheTokens)}${RESET}`
    : `${YELLOW}cache cold${RESET}`;
}

/**
 * @param {unknown} headContent raw `.git/HEAD` file content.
 * @returns {string | null} the branch name, or null for detached HEAD / a
 *   raw SHA / garbage.
 */
export function parseHeadRef(headContent) {
  if (typeof headContent !== "string") return null;
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(headContent.trim());
  return match ? match[1].trim() : null;
}

/**
 * @param {unknown} content raw `.git` file content (linked worktree /
 *   submodule case).
 * @returns {string | null} the pointed-to gitdir path, or null.
 */
export function parseGitdirPointer(content) {
  if (typeof content !== "string") return null;
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  return match ? match[1].trim() : null;
}

/**
 * Walks upward from `startDir` looking for `.git` (a directory, the normal
 * case, or a file pointing at the real gitdir, the linked-worktree /
 * submodule case) and resolves the current branch from its `HEAD` file.
 * Pure with respect to actual disk I/O — all reads go through the injected
 * `readFile`, so this is directly unit-testable without touching a real
 * filesystem.
 *
 * @param {(path: string) => string | null} readFile injected file reader;
 *   returns the file content or null when unreadable/absent.
 * @param {unknown} startDir directory to start the upward walk from; a
 *   non-string or empty value returns null rather than throwing.
 * @returns {string | null} the branch name, or null when it can't be
 *   resolved.
 */
export function resolveBranch(readFile, startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return null;

  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    const headContent = readFile(join(dir, ".git", "HEAD"));
    if (typeof headContent === "string") {
      return parseHeadRef(headContent);
    }

    const gitEntry = readFile(join(dir, ".git"));
    if (typeof gitEntry === "string") {
      const pointer = parseGitdirPointer(gitEntry);
      if (pointer === null || pointer.length === 0) return null;
      const resolvedGitDir = isAbsolute(pointer) ? pointer : join(dir, pointer);
      const linkedHead = readFile(join(resolvedGitDir, "HEAD"));
      return typeof linkedHead === "string" ? parseHeadRef(linkedHead) : null;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * @param {string | null} branchName
 * @returns {string | null} colorized branch segment; `main` is flagged as a
 *   warning since direct commits there are unusual in this repo's workflow.
 */
export function formatBranch(branchName) {
  if (typeof branchName !== "string" || branchName.length === 0) return null;
  return branchName === "main"
    ? `${RED}⚠ main${RESET}`
    : `${GREEN}${branchName}${RESET}`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} worktree name and/or a colorized, OSC-8-linked
 *   PR reference, or null when neither is present.
 */
export function formatWorktreeAndPr(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const parts = [];

  const workspace = /** @type {{ git_worktree?: unknown } | undefined} */ (
    p.workspace
  );
  const worktreeName =
    workspace && typeof workspace === "object"
      ? workspace.git_worktree
      : undefined;
  if (typeof worktreeName === "string" && worktreeName.length > 0) {
    parts.push(`worktree "${worktreeName}"`);
  }

  const pr =
    /**
     * @type {{ number?: unknown; review_state?: unknown; url?: unknown } | undefined}
     */ (p.pr);
  if (pr && typeof pr === "object" && typeof pr.number === "number") {
    const color =
      pr.review_state === "approved"
        ? GREEN
        : pr.review_state === "changes_requested"
          ? RED
          : pr.review_state === "draft"
            ? DIM
            : pr.review_state === "pending"
              ? YELLOW
              : RESET;
    const label = `PR #${pr.number}`;
    const linked =
      typeof pr.url === "string" && pr.url.length > 0
        ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07`
        : label;
    parts.push(`${color}${linked}${RESET}`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * @param {unknown} payload
 * @returns {string | null} dim `↳ agent-name` segment, or null when absent.
 */
export function formatAgentSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const agent = /** @type {{ agent?: unknown }} */ (payload).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const name = /** @type {{ name?: unknown }} */ (agent).name;
  return typeof name === "string" && name.length > 0
    ? `${DIM}↳ ${name}${RESET}`
    : null;
}

/** Elapsed-time threshold, in seconds, past which the in-flight-spoke
 * segment turns yellow — the point a fan-out is worth a glance. */
export const SPOKE_WARN_THRESHOLD_SEC = 15 * 60;
/** Elapsed-time threshold, in seconds, past which it turns red — the
 * documented athena/s3/subagent-stall-integration 30-60+ min pattern. */
export const SPOKE_HIGH_THRESHOLD_SEC = 30 * 60;
/** A `start` record older than this, with no matching `stop`, is treated as
 * a lost event (the spoke's `SubagentStop` hook never fired — the harness
 * killed the process, the dispatch was cancelled, or the advisory hook's own
 * write failed) rather than a still-running spoke, so it doesn't pin the
 * segment red forever. Two hours is well past the longest recorded stall in
 * this repo's own incident history (~60 min) with headroom to spare. */
export const MAX_INFLIGHT_AGE_SEC = 2 * 60 * 60;

/**
 * @typedef {{ agentId: string, agentType: string, startTs: string }} InflightSpoke
 */

/**
 * Reduces `tmp/spoke-lifecycle.jsonl` to the spokes that have a `start`
 * record with no matching `stop` yet. A record without a string `agentId`
 * can't be correlated to its counterpart, so it's excluded from both the
 * start and stop maps rather than guessed at — degrading gracefully (one
 * untracked spoke) instead of risking a false "still running" entry that
 * never clears.
 *
 * @param {(path: string) => string | null} readFile injected file reader,
 *   mirroring `resolveBranch`'s pattern — directly unit-testable without
 *   touching a real filesystem.
 * @param {string} cwd project root to resolve `tmp/spoke-lifecycle.jsonl`
 *   against.
 * @returns {InflightSpoke[]} spokes currently in flight, oldest-first order
 *   not guaranteed.
 */
export function resolveInflightSpokes(readFile, cwd) {
  const content = readFile(join(cwd, SPOKE_LIFECYCLE_REL_PATH));
  if (typeof content !== "string") return [];

  /** @type {Map<string, InflightSpoke>} */
  const started = new Map();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { event, agentId, agentType, ts } = record;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    if (event === "start") {
      if (typeof agentType === "string" && typeof ts === "string") {
        started.set(agentId, { agentId, agentType, startTs: ts });
      }
    } else if (event === "stop") {
      started.delete(agentId);
    }
  }
  return [...started.values()];
}

/**
 * @param {number} elapsedSec seconds elapsed, always non-negative when
 *   called from `formatInflightSpokesSegment`.
 * @returns {string} `"0m"`, `"NNm"`, or `"NhMMm"`.
 */
export function formatElapsed(elapsedSec) {
  const clamped = Math.max(0, Math.floor(elapsedSec));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * A spoke older than `MAX_INFLIGHT_AGE_SEC` with no matching `stop` is
 * treated as a lost event and excluded here, not in `resolveInflightSpokes`
 * — `resolveInflightSpokes` stays a pure, timeless reducer over what the
 * file says (and is tested against fixed timestamps accordingly); "is this
 * plausibly still running" is a judgment that needs `now`, which only this
 * function's `env` already carries. Otherwise a single lost `SubagentStop`
 * event (the harness killed the process, the dispatch was cancelled, or
 * `track-inflight-spokes.mjs`'s own advisory write failed) would pin the
 * segment red for the rest of the session instead of self-healing.
 *
 * @param {InflightSpoke[]} spokes
 * @param {{ now?: unknown } | undefined} env `now` overrides `Date.now()`
 *   for deterministic tests, mirroring `formatResetCountdown`'s convention.
 * @returns {string | null} colorized `N spoke(s) · oldest NNm` segment, or
 *   null when nothing is genuinely in flight — the "prove it quiet" case:
 *   this segment vanishes entirely on an idle session (or one with only
 *   stale/lost records) rather than rendering an empty, zeroed, or stuck
 *   widget.
 */
export function formatInflightSpokesSegment(spokes, env) {
  if (!Array.isArray(spokes) || spokes.length === 0) return null;

  const nowMs = typeof env?.now === "number" ? env.now : Date.now();
  const cutoffMs = nowMs - MAX_INFLIGHT_AGE_SEC * 1000;

  let oldestMs = Number.POSITIVE_INFINITY;
  let liveCount = 0;
  for (const spoke of spokes) {
    const t = Date.parse(spoke.startTs);
    if (Number.isNaN(t) || t < cutoffMs) continue;
    liveCount += 1;
    if (t < oldestMs) oldestMs = t;
  }
  if (liveCount === 0 || !Number.isFinite(oldestMs)) return null;

  const elapsedSec = Math.max(0, (nowMs - oldestMs) / 1000);
  const color =
    elapsedSec >= SPOKE_HIGH_THRESHOLD_SEC
      ? RED
      : elapsedSec >= SPOKE_WARN_THRESHOLD_SEC
        ? YELLOW
        : GREEN;
  const icon = elapsedSec >= SPOKE_HIGH_THRESHOLD_SEC ? " ⚠" : "";
  const noun = liveCount === 1 ? "spoke" : "spokes";
  return `${color}${liveCount} ${noun} · oldest ${formatElapsed(elapsedSec)}${icon}${RESET}`;
}

/**
 * @param {unknown} payload
 * @returns {string | null} colorized `owner/name` origin repo segment, or
 *   null when absent.
 */
export function formatOriginRepo(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const workspace = /** @type {{ workspace?: unknown }} */ (payload).workspace;
  if (typeof workspace !== "object" || workspace === null) return null;
  const repo = /** @type {{ repo?: unknown }} */ (workspace).repo;
  if (typeof repo !== "object" || repo === null) return null;
  const r = /** @type {{ owner?: unknown; name?: unknown }} */ (repo);
  return typeof r.owner === "string" &&
    r.owner.length > 0 &&
    typeof r.name === "string" &&
    r.name.length > 0
    ? `${BRIGHT_CYAN}${r.owner}/${r.name}${RESET}`
    : null;
}

/**
 * @param {{ freemem?: unknown; totalmem?: unknown } | undefined} env
 * @returns {string | null} colorized `mem NN%free` segment, or null when
 *   the env doesn't carry memory figures.
 */
export function formatFreeMemory(env) {
  const freemem = env?.freemem;
  const totalmem = env?.totalmem;
  if (
    typeof freemem !== "number" ||
    typeof totalmem !== "number" ||
    totalmem <= 0
  ) {
    return null;
  }
  return `${BRIGHT_GREEN}mem ${Math.round((freemem / totalmem) * 100)}%free${RESET}`;
}

/**
 * @param {ReadonlyArray<string | null>} list
 * @returns {string | null}
 */
function joinSegments(list) {
  const nonEmpty = list.filter(
    (segment) => typeof segment === "string" && segment.length > 0,
  );
  return nonEmpty.length > 0 ? nonEmpty.join(SEGMENT_JOIN) : null;
}

/**
 * @param {unknown} payload
 * @returns {string | null} line 1: session name, model, effort, context bar
 *   + segment.
 */
export function buildLine1(payload) {
  return joinSegments([
    formatSessionNameSegment(payload),
    formatModelSegment(payload),
    formatEffortSegment(payload),
    joinSegments([formatContextBar(payload), formatContextSegment(payload)]),
  ]);
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @returns {string | null} line 2: session usage, rate-limit countdowns,
 *   cache state.
 */
export function buildLine2(payload, env) {
  return joinSegments([
    formatSessionUsage(payload),
    formatResetCountdown(payload, env),
    formatWeeklyReset(payload),
    formatCacheWidget(payload),
  ]);
}

/**
 * @param {unknown} payload
 * @param {{ branch?: unknown; freemem?: unknown; totalmem?: unknown; now?: unknown; spokes?: InflightSpoke[] } | undefined} env
 * @returns {string | null} line 3: branch, worktree/PR, agent, in-flight
 *   spokes, origin repo, free memory.
 */
export function buildLine3(payload, env) {
  return joinSegments([
    formatBranch(env?.branch ?? null),
    formatWorktreeAndPr(payload),
    formatAgentSegment(payload),
    formatInflightSpokesSegment(env?.spokes ?? [], env),
    formatOriginRepo(payload),
    formatFreeMemory(env),
  ]);
}

/**
 * @param {unknown} payload
 * @returns {string | null} line 4: the `/compact` suggestion, unchanged.
 */
export function buildLine4(payload) {
  return buildCompactSuggestion(payload);
}

/**
 * @param {unknown} payload
 * @param {{
 *   now?: unknown;
 *   freemem?: unknown;
 *   totalmem?: unknown;
 *   branch?: unknown;
 *   spokes?: InflightSpoke[];
 * }} [env] local-only, non-payload context: current time (ms), free/total
 *   memory (bytes), the resolved git branch name, and the currently
 *   in-flight spokes. Defaults to `{}` so existing single-argument call
 *   sites keep working.
 * @returns {string} the full, possibly multi-line, status-line output.
 */
export function renderStatusLine(payload, env = {}) {
  return [
    buildLine1(payload),
    buildLine2(payload, env),
    buildLine3(payload, env),
    buildLine4(payload),
  ]
    .filter((line) => typeof line === "string" && line.length > 0)
    .join("\n");
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let output;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const startDir =
      typeof payload?.workspace?.current_dir === "string"
        ? payload.workspace.current_dir
        : process.cwd();
    const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const env = {
      now: Date.now(),
      freemem: os.freemem(),
      totalmem: os.totalmem(),
      branch: resolveBranch(safeReadFile, startDir),
      spokes: resolveInflightSpokes(safeReadFile, projectRoot),
    };
    output = renderStatusLine(payload, env);
  } catch {
    output = `${GREEN}ctx --%${RESET}`;
  }

  process.stdout.write(output);
  process.exit(0);
}
