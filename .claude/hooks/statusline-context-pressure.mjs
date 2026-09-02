#!/usr/bin/env node
/**
 * statusLine: renders a fixed five-row layout — session, model, context,
 * quota, work — built entirely from fields already present on the same
 * payload that arrives on stdin (docs/research/harness-refresh.md
 * Outstanding drift #10; broadened for ccstatusline parity per issue #879),
 * plus one local state file for the in-flight-spoke count
 * (`tmp/spoke-lifecycle.jsonl`, written by `track-inflight-spokes.mjs`).
 *
 * Each row is width-fit against the real terminal width via
 * `statusline-layout.mjs`'s `fitRow`/`terminalColumns`/`displayWidth`:
 * Anthropic's own statusLine docs (code.claude.com/docs/en/statusline) state
 * that `COLUMNS`/`LINES` must be read from the environment — `tput cols`
 * does not work inside a statusLine subprocess — and that reading is what
 * lets a narrow terminal drop its lowest-priority segments instead of
 * wrapping mid-line past 80 columns the way the previous line-based layout
 * did.
 *
 * The in-flight-spoke tracking (`resolveInflightSpokes`,
 * `formatInflightSpokesSegment`, and friends) is kept intact but currently
 * uncalled by the five row builders below — this PR is
 * a layout/renderer rewrite only; PR 2 migrates spoke visibility to
 * `subagentStatusLine` and retires `track-inflight-spokes.mjs` in the same
 * change that removes this dead code. Leaving it wired-but-unused here is
 * the deliberate, approved sequencing, not an oversight.
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
import { displayWidth, fitRow, terminalColumns } from "./statusline-layout.mjs";
import { SPOKE_LIFECYCLE_REL_PATH } from "./track-inflight-spokes.mjs";

export const WARN_THRESHOLD_PERCENT = 70;
export const HIGH_THRESHOLD_PERCENT = 90;

export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const SEGMENT_SEPARATOR = `${DIM} · ${RESET}`;
export const PLACEHOLDER = `${DIM}—${RESET}`;
export const GUTTER_WIDTH = 10;
export const CONTEXT_BAR_WIDTH = 20;
export const QUOTA_BAR_WIDTH = 10;

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
 * The repo's Claude Code session-naming convention (ADR-0087,
 * `docs/contributing/contributing.md` § Session naming): `<kind>-<slug>`,
 * `kind` from a closed set reusing the branch-prefix/Conventional-Commit
 * vocabulary.
 */
export const SESSION_NAME_PATTERN =
  /^(feat|fix|audit|research|docs|review|ci|merge)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SESSION_NAME_MAX_LENGTH = 40;

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
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   dim `↳ agent-name` segment, or null when absent.
 */
export function formatAgentSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const agent = /** @type {{ agent?: unknown }} */ (payload).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const name = /** @type {{ name?: unknown }} */ (agent).name;
  if (typeof name !== "string" || name.length === 0) return null;
  return seg("agent", 55, `${DIM}↳ ${name}${RESET}`, 6);
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
 * Builds a `{ id, priority, text, minWidth }` row segment, or `null` when
 * `text` is absent — the shared shape every `format*Segment` function below
 * returns so `fitRow` can budget/drop them uniformly.
 *
 * @param {string} id
 * @param {number} priority
 * @param {string | null | undefined} text
 * @param {number} minWidth
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 */
function seg(id, priority, text, minWidth) {
  return text === null || text === undefined
    ? null
    : { id, priority, text, minWidth };
}

/**
 * @param {string} label
 * @returns {string} the dim, fixed-width row label.
 */
function gutter(label) {
  return `${DIM}${label.padEnd(GUTTER_WIDTH)}${RESET}`;
}

/**
 * @param {string} label
 * @param {ReadonlyArray<{ id: string, priority: number, text: string, minWidth: number } | null>} segments
 * @param {number} columns
 * @returns {string} one rendered row: a fixed gutter label plus the
 *   width-fit, separator-joined segments — `PLACEHOLDER` when every segment
 *   is absent, so every row always renders exactly one non-empty line.
 */
function buildRow(label, segments, columns) {
  const g = gutter(label);
  const nonEmpty = segments.filter((s) => s !== null);
  if (nonEmpty.length === 0) return `${g}${PLACEHOLDER}`;
  const budget = columns - displayWidth(g);
  return `${g}${fitRow(nonEmpty, budget, SEGMENT_SEPARATOR)}`;
}

/**
 * Always renders, unlike most segments here — absence of a conforming name
 * is exactly the signal this segment exists to surface (ADR-0087). No hook
 * can set a session name, so `payload.session_name` carries whatever the
 * session happens to have: the AI-generated first-prompt title when nothing
 * was set explicitly. A present/absent check alone would therefore pass most
 * sessions while conforming to nothing — this validates the *value* against
 * the convention's pattern instead, the same way `formatBranchSegment` flags
 * `main` rather than merely checking a branch name is present.
 *
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number }}
 *   the colorized session name when it conforms to the convention, or a
 *   dim/flagged marker (`unnamed`, or the non-conforming name itself)
 *   otherwise — never null.
 */
export function formatSessionNameSegment(payload) {
  const name =
    typeof payload === "object" && payload !== null
      ? /** @type {{ session_name?: unknown }} */ (payload).session_name
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return /** @type {{ id: string, priority: number, text: string, minWidth: number }} */ (
      seg("session_name", 100, `${DIM}unnamed${RESET}`, 12)
    );
  }
  const conforms =
    name.length <= SESSION_NAME_MAX_LENGTH && SESSION_NAME_PATTERN.test(name);
  const text = conforms
    ? `${GREEN}${name}${RESET}`
    : `${YELLOW}⚠ ${name}${RESET}`;
  return /** @type {{ id: string, priority: number, text: string, minWidth: number }} */ (
    seg("session_name", 100, text, 12)
  );
}

/**
 * @param {string | null} branchName the resolved branch, or null.
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the branch segment; `main` is flagged as a warning since direct commits
 *   there are unusual in this repo's workflow.
 */
export function formatBranchSegment(branchName) {
  if (typeof branchName !== "string" || branchName.length === 0) return null;
  const text =
    branchName === "main" ? `${RED}⚠ main${RESET}` : `🌿 ${branchName}`;
  return seg("branch", 95, text, 6);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the `wt "name"` segment, or null when `workspace.git_worktree` is
 *   absent/empty.
 */
export function formatWorktreeSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const workspace = /** @type {{ workspace?: unknown }} */ (payload).workspace;
  const worktreeName =
    workspace && typeof workspace === "object"
      ? /** @type {{ git_worktree?: unknown }} */ (workspace).git_worktree
      : undefined;
  if (typeof worktreeName !== "string" || worktreeName.length === 0)
    return null;
  return seg("worktree", 85, `wt "${worktreeName}"`, 8);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the colorized, OSC-8-linked `PR #N` segment, or null when
 *   `pr.number` is absent.
 */
export function formatPrSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const pr =
    /**
     * @type {{ number?: unknown; review_state?: unknown; url?: unknown } | undefined}
     */ (/** @type {{ pr?: unknown }} */ (payload).pr);
  if (typeof pr !== "object" || pr === null || typeof pr.number !== "number") {
    return null;
  }
  const color =
    pr.review_state === "approved"
      ? GREEN
      : pr.review_state === "changes_requested"
        ? RED
        : pr.review_state === "draft"
          ? DIM
          : pr.review_state === "pending"
            ? YELLOW
            : null;
  const label = `PR #${pr.number}`;
  const linked =
    typeof pr.url === "string" && pr.url.length > 0
      ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07`
      : label;
  const text = color === null ? linked : `${color}${linked}${RESET}`;
  return seg("pr", 90, text, 8);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain `owner/name` origin repo segment, or null when absent.
 */
export function formatOriginRepoSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const workspace = /** @type {{ workspace?: unknown }} */ (payload).workspace;
  if (typeof workspace !== "object" || workspace === null) return null;
  const repo = /** @type {{ repo?: unknown }} */ (workspace).repo;
  if (typeof repo !== "object" || repo === null) return null;
  const r = /** @type {{ owner?: unknown; name?: unknown }} */ (repo);
  if (
    typeof r.owner !== "string" ||
    r.owner.length === 0 ||
    typeof r.name !== "string" ||
    r.name.length === 0
  ) {
    return null;
  }
  return seg("origin_repo", 40, `${r.owner}/${r.name}`, 10);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the cyan model display-name segment, or null when absent.
 */
export function formatModelSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const model = /** @type {{ model?: unknown }} */ (payload).model;
  if (typeof model !== "object" || model === null) return null;
  const name = /** @type {{ display_name?: unknown }} */ (model).display_name;
  if (typeof name !== "string" || name.length === 0) return null;
  return seg("model", 100, `${CYAN}${name}${RESET}`, 6);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain effort-level segment, or null when absent.
 */
export function formatEffortSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const effort = /** @type {{ effort?: unknown }} */ (payload).effort;
  if (typeof effort !== "object" || effort === null) return null;
  const level = /** @type {{ level?: unknown }} */ (effort).level;
  if (typeof level !== "string" || level.length === 0) return null;
  return seg("effort", 90, level, 4);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   a `thinking` segment when `thinking.enabled === true`, else null.
 */
export function formatThinkingSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const thinking = /** @type {{ thinking?: unknown }} */ (payload).thinking;
  const enabled =
    thinking && typeof thinking === "object"
      ? /** @type {{ enabled?: unknown }} */ (thinking).enabled
      : undefined;
  return enabled === true ? seg("thinking", 70, "thinking", 8) : null;
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   a `fast mode` segment when `fast_mode === true`, else null.
 */
export function formatFastModeSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const fastMode = /** @type {{ fast_mode?: unknown }} */ (payload).fast_mode;
  return fastMode === true ? seg("fast_mode", 65, "fast mode", 10) : null;
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain output-style-name segment, or null when absent or the literal
 *   `"default"` (showing the default adds no information).
 */
export function formatOutputStyleSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const outputStyle = /** @type {{ output_style?: unknown }} */ (payload)
    .output_style;
  const name =
    outputStyle && typeof outputStyle === "object"
      ? /** @type {{ name?: unknown }} */ (outputStyle).name
      : undefined;
  if (typeof name !== "string" || name.length === 0 || name === "default") {
    return null;
  }
  return seg("output_style", 55, name, 6);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the lowercased vim-mode segment, or null when absent.
 */
export function formatVimModeSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const vim = /** @type {{ vim?: unknown }} */ (payload).vim;
  const mode =
    vim && typeof vim === "object"
      ? /** @type {{ mode?: unknown }} */ (vim).mode
      : undefined;
  if (typeof mode !== "string" || mode.length === 0) return null;
  return seg("vim", 50, mode.toLowerCase(), 6);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   a zone-colored block-glyph context-usage bar, or null when the payload
 *   has no context-window data yet.
 */
export function formatContextBarSegment(payload) {
  const pct = resolveUsedPercentage(payload);
  const zone = zoneForPercentage(pct);
  if (zone === "unknown" || pct === null) return null;
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  const filled = Math.min(
    CONTEXT_BAR_WIDTH,
    Math.max(0, Math.round((pct / 100) * CONTEXT_BAR_WIDTH)),
  );
  const text = `${color}${"█".repeat(filled)}${"░".repeat(CONTEXT_BAR_WIDTH - filled)}${RESET}`;
  return seg("context_bar", 100, text, CONTEXT_BAR_WIDTH);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the zone-colored `NN%` context-usage segment, or null when unknown.
 */
export function formatContextPercentSegment(payload) {
  const pct = resolveUsedPercentage(payload);
  const zone = zoneForPercentage(pct);
  if (zone === "unknown" || pct === null) return null;
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  return seg("context_pct", 95, `${color}${pct}%${RESET}`, 4);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain `used/total` token-count segment, or null when either figure
 *   is absent.
 */
export function formatContextDenominatorSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const contextWindow = /** @type {{ context_window?: unknown }} */ (payload)
    .context_window;
  if (typeof contextWindow !== "object" || contextWindow === null) return null;
  const cw =
    /** @type {{ total_input_tokens?: unknown; context_window_size?: unknown }} */ (
      contextWindow
    );
  const numerator = cw.total_input_tokens;
  const denominator = cw.context_window_size;
  if (
    typeof numerator !== "number" ||
    !Number.isFinite(numerator) ||
    numerator <= 0 ||
    typeof denominator !== "number" ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  const text = `${formatTokenCount(numerator)}/${formatTokenCount(denominator)}`;
  return seg("context_denom", 80, text, 10);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain `N headroom` token-count segment, or null when the payload
 *   lacks remaining-percentage or window-size data.
 */
export function formatContextHeadroomSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const contextWindow = /** @type {{ context_window?: unknown }} */ (payload)
    .context_window;
  if (typeof contextWindow !== "object" || contextWindow === null) return null;
  const cw =
    /** @type {{ remaining_percentage?: unknown; context_window_size?: unknown }} */ (
      contextWindow
    );
  const remainingPct = cw.remaining_percentage;
  const windowSize = cw.context_window_size;
  if (
    typeof remainingPct !== "number" ||
    !Number.isFinite(remainingPct) ||
    remainingPct < 0 ||
    typeof windowSize !== "number" ||
    !Number.isFinite(windowSize) ||
    windowSize <= 0
  ) {
    return null;
  }
  const headroomTokens = Math.round((remainingPct / 100) * windowSize);
  return seg(
    "context_headroom",
    70,
    `${formatTokenCount(headroomTokens)} headroom`,
    12,
  );
}

/**
 * Shared renderer for the three `rate_limits.*` quota segments below: a
 * zone-colored bar plus percentage and, when a reset time is available, a
 * dim countdown.
 *
 * @param {string} id
 * @param {number} priority
 * @param {string} label
 * @param {unknown} window the parsed `rate_limits.<key>` object, or
 *   undefined/null.
 * @param {{ now?: unknown } | undefined} env
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 */
function formatQuotaWindowSegment(id, priority, label, window, env) {
  if (typeof window !== "object" || window === null) return null;
  const w = /** @type {{ used_percentage?: unknown; resets_at?: unknown }} */ (
    window
  );
  const pct = w.used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;

  const barPct = Math.min(100, Math.max(0, pct));
  const zone = zoneForPercentage(barPct);
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  const filled = Math.min(
    QUOTA_BAR_WIDTH,
    Math.max(0, Math.round((barPct / 100) * QUOTA_BAR_WIDTH)),
  );
  const bar = `${"█".repeat(filled)}${"░".repeat(QUOTA_BAR_WIDTH - filled)}`;

  const resetsAt = w.resets_at;
  const resetText =
    typeof resetsAt === "number" && Number.isFinite(resetsAt)
      ? ` ${formatDuration(
          Math.floor(
            resetsAt -
              (typeof env?.now === "number" ? env.now : Date.now()) / 1000,
          ),
        )}`
      : "";

  const text = `${color}${label} ${bar} ${Math.round(pct)}%${RESET}${DIM}${resetText}${RESET}`;
  return seg(id, priority, text, 20);
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the five-hour quota segment, or null when absent.
 */
export function formatFiveHourSegment(payload, env) {
  const rateLimits =
    typeof payload === "object" && payload !== null
      ? /** @type {{ rate_limits?: unknown }} */ (payload).rate_limits
      : undefined;
  const window =
    typeof rateLimits === "object" && rateLimits !== null
      ? /** @type {{ five_hour?: unknown }} */ (rateLimits).five_hour
      : undefined;
  return formatQuotaWindowSegment("quota_5h", 100, "5h", window, env);
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the seven-day quota segment, or null when absent.
 */
export function formatSevenDaySegment(payload, env) {
  const rateLimits =
    typeof payload === "object" && payload !== null
      ? /** @type {{ rate_limits?: unknown }} */ (payload).rate_limits
      : undefined;
  const window =
    typeof rateLimits === "object" && rateLimits !== null
      ? /** @type {{ seven_day?: unknown }} */ (rateLimits).seven_day
      : undefined;
  return formatQuotaWindowSegment("quota_7d", 85, "7d", window, env);
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the spend-limit quota segment, or null when absent.
 */
export function formatSpendLimitSegment(payload, env) {
  const rateLimits =
    typeof payload === "object" && payload !== null
      ? /** @type {{ rate_limits?: unknown }} */ (payload).rate_limits
      : undefined;
  const window =
    typeof rateLimits === "object" && rateLimits !== null
      ? /** @type {{ spend_limit?: unknown }} */ (rateLimits).spend_limit
      : undefined;
  return formatQuotaWindowSegment("quota_spend", 60, "spend", window, env);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain `$N.NN` total-cost segment, or null when absent.
 */
export function formatCostSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const cost = /** @type {{ cost?: unknown }} */ (payload).cost;
  if (typeof cost !== "object" || cost === null) return null;
  const totalCost = /** @type {{ total_cost_usd?: unknown }} */ (cost)
    .total_cost_usd;
  if (typeof totalCost !== "number" || !Number.isFinite(totalCost)) return null;
  return seg("cost", 100, `$${totalCost.toFixed(2)}`, 6);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the plain `Nm (Nm api)` duration segment, or null when absent.
 */
export function formatDurationSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const cost = /** @type {{ cost?: unknown }} */ (payload).cost;
  if (typeof cost !== "object" || cost === null) return null;
  const c =
    /** @type {{ total_duration_ms?: unknown; total_api_duration_ms?: unknown }} */ (
      cost
    );
  const totalDurationMs = c.total_duration_ms;
  if (
    typeof totalDurationMs !== "number" ||
    !Number.isFinite(totalDurationMs)
  ) {
    return null;
  }
  const mins = Math.floor(totalDurationMs / 60_000);
  const totalApiDurationMs = c.total_api_duration_ms;
  const text =
    typeof totalApiDurationMs === "number" &&
    Number.isFinite(totalApiDurationMs)
      ? `${mins}m (${Math.floor(totalApiDurationMs / 60_000)}m api)`
      : `${mins}m`;
  return seg("duration", 85, text, 10);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the colorized `+N/-N` lines-changed segment, or null when absent or both
 *   figures are zero (quiet by default when nothing has changed yet).
 */
export function formatLinesChangedSegment(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const cost = /** @type {{ cost?: unknown }} */ (payload).cost;
  if (typeof cost !== "object" || cost === null) return null;
  const c =
    /** @type {{ total_lines_added?: unknown; total_lines_removed?: unknown }} */ (
      cost
    );
  const added = c.total_lines_added;
  const removed = c.total_lines_removed;
  if (
    typeof added !== "number" ||
    !Number.isFinite(added) ||
    typeof removed !== "number" ||
    !Number.isFinite(removed)
  ) {
    return null;
  }
  if (added === 0 && removed === 0) return null;
  const text = `${GREEN}+${added}${RESET}${DIM}/${RESET}${RED}-${removed}${RESET}`;
  return seg("lines", 65, text, 8);
}

/**
 * @param {unknown} payload
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   colorized prompt-cache state, or null when absent/malformed.
 */
export function formatCacheSegment(payload) {
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
    const text =
      typeof hitRatio === "number" && Number.isFinite(hitRatio)
        ? `${GREEN}cache ${Math.round(hitRatio * 100)}%${RESET}`
        : `${GREEN}cache warm${RESET}`;
    return seg("cache", 55, text, 10);
  }

  const recacheTokens = cache.recache_tokens_if_cold;
  const text =
    typeof recacheTokens === "number" && Number.isFinite(recacheTokens)
      ? `${YELLOW}cache cold · ${formatTokenCount(recacheTokens)}${RESET}`
      : `${YELLOW}cache cold${RESET}`;
  return seg("cache", 55, text, 10);
}

/**
 * @param {number} bytes
 * @returns {string} bytes formatted as gigabytes with one decimal place.
 */
function gigabytes(bytes) {
  return (bytes / 1_000_000_000).toFixed(1);
}

/**
 * @param {{ freemem?: unknown; totalmem?: unknown } | undefined} env
 * @returns {{ id: string, priority: number, text: string, minWidth: number } | null}
 *   the zone-colored `N.N/N.NG free` memory segment, or null when the env
 *   doesn't carry memory figures.
 */
export function formatMemorySegment(env) {
  const freemem = env?.freemem;
  const totalmem = env?.totalmem;
  if (
    typeof freemem !== "number" ||
    !Number.isFinite(freemem) ||
    typeof totalmem !== "number" ||
    !Number.isFinite(totalmem) ||
    totalmem <= 0
  ) {
    return null;
  }
  const freePct = (freemem / totalmem) * 100;
  const zone = zoneForPercentage(100 - freePct);
  const color = zone === "high" ? RED : zone === "warn" ? YELLOW : GREEN;
  const text = `${color}${gigabytes(freemem)}/${gigabytes(totalmem)}G free${RESET}`;
  return seg("memory", 50, text, 10);
}

/**
 * @param {unknown} payload
 * @param {{ branch?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the session row: session name, branch, worktree, PR,
 *   agent, origin repo.
 */
export function buildSessionRow(payload, env, columns) {
  return buildRow(
    "session",
    [
      formatSessionNameSegment(payload),
      formatBranchSegment(env?.branch ?? null),
      formatWorktreeSegment(payload),
      formatPrSegment(payload),
      formatAgentSegment(payload),
      formatOriginRepoSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {number} columns
 * @returns {string} the model row: model, effort, thinking, fast mode,
 *   output style, vim mode.
 */
export function buildModelRow(payload, columns) {
  return buildRow(
    "model",
    [
      formatModelSegment(payload),
      formatEffortSegment(payload),
      formatThinkingSegment(payload),
      formatFastModeSegment(payload),
      formatOutputStyleSegment(payload),
      formatVimModeSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {number} columns
 * @returns {string} the context row: usage bar, percent, denominator,
 *   headroom.
 */
export function buildContextRow(payload, columns) {
  return buildRow(
    "context",
    [
      formatContextBarSegment(payload),
      formatContextPercentSegment(payload),
      formatContextDenominatorSegment(payload),
      formatContextHeadroomSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the quota row: five-hour, seven-day, spend-limit
 *   `rate_limits.*` windows.
 */
export function buildQuotaRow(payload, env, columns) {
  return buildRow(
    "quota",
    [
      formatFiveHourSegment(payload, env),
      formatSevenDaySegment(payload, env),
      formatSpendLimitSegment(payload, env),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{ freemem?: unknown; totalmem?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the work row: cost, duration, lines changed, cache
 *   state, free memory.
 */
export function buildWorkRow(payload, env, columns) {
  return buildRow(
    "work",
    [
      formatCostSegment(payload),
      formatDurationSegment(payload),
      formatLinesChangedSegment(payload),
      formatCacheSegment(payload),
      formatMemorySegment(env),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{
 *   now?: unknown;
 *   freemem?: unknown;
 *   totalmem?: unknown;
 *   branch?: unknown;
 *   spokes?: InflightSpoke[];
 *   COLUMNS?: unknown;
 * }} [env] local-only, non-payload context: current time (ms), free/total
 *   memory (bytes), the resolved git branch name, the currently in-flight
 *   spokes (retained but unused, see file header), and the terminal
 *   `COLUMNS` width. Defaults to `{}` so existing single-argument call sites
 *   keep working.
 * @returns {string} the full, always-five-line status-line output.
 */
export function renderStatusLine(payload, env = {}) {
  const columns = terminalColumns(env);
  return [
    buildSessionRow(payload, env, columns),
    buildModelRow(payload, columns),
    buildContextRow(payload, columns),
    buildQuotaRow(payload, env, columns),
    buildWorkRow(payload, env, columns),
  ].join("\n");
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
      COLUMNS: process.env.COLUMNS,
    };
    output = renderStatusLine(payload, env);
  } catch {
    output = `${GREEN}ctx --%${RESET}`;
  }

  process.stdout.write(output);
  process.exit(0);
}
