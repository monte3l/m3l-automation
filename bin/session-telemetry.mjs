#!/usr/bin/env node
// The ONLY thing in this repo permitted to read Claude Code's session
// transcripts. A thin adapter over the session-report plugin's bundled
// analyze-sessions.mjs, invoked on demand by /promoting-work-log-lessons —
// never a pre-push gate. ADR-0084.
//
// Why an adapter rather than calling the analyzer directly, three reasons:
//
// 1. THE FORMAT IS OFFICIALLY UNSUPPORTED. Anthropic documents the transcript
//    JSONL as internal to Claude Code and subject to change between versions,
//    and points integrators at the Agent SDK instead. analyze-sessions.mjs
//    parses exactly that. A Claude Code upgrade that renames a field does not
//    error — it silently reports ZEROS, which reads like a healthy answer. So
//    this wrapper ASSERTS the payload's shape and exits non-zero naming the
//    instability. A loud failure is the whole point; without it, the sweep
//    quietly concludes nothing ever happened.
//
// 2. SCOPE. The full transcript store measured 1,759 files / 932 MB on
//    2026-09-01. An unscoped scan is exactly the workload ADR-0080 budgets
//    against, and the `earlyoom kills node first` failure mode it warns about.
//    This always pins --dir to THIS project's directory and bounds --since.
//
// 3. RESOLUTION. The plugin cache holds one directory per installed revision;
//    hardcoding one pins the repo to a version that a plugin update orphans.
//    Resolution is explicit and reported, and absence is a clear error rather
//    than an empty result.
//
// Usage:
//   node bin/session-telemetry.mjs                     # last 30d, this project
//   node bin/session-telemetry.mjs --since 7d
//   node bin/session-telemetry.mjs --analyzer <path>   # pin a revision
//   pnpm telemetry:sessions
import process from "node:process";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeProjectDir } from "./lib/claude-home.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

/** Where the session-report plugin caches its installed revisions. */
export const PLUGIN_CACHE_SUBPATH = join(
  ".claude",
  "plugins",
  "cache",
  "claude-plugins-official",
  "session-report",
);

/** The analyzer's path relative to one cached revision's root. */
export const ANALYZER_SUBPATH = join(
  "skills",
  "session-report",
  "analyze-sessions.mjs",
);

/** Default window. Wide enough to span several work logs, narrow enough to stay cheap. */
export const DEFAULT_SINCE = "30d";

/** The only `--since` shapes the analyzer bounds a scan by: `<n>d` or `<n>h`. */
export const SINCE_PATTERN = /^\d+[dh]$/;

/**
 * Every top-level key `analyze-sessions.mjs --json` is contracted to emit.
 * This list IS the shape assertion — the guard against the unsupported-format
 * risk in the header. Verified against the analyzer's `printJson` at
 * revision ed404106fcd8.
 */
export const REQUIRED_KEYS = Object.freeze([
  "overall",
  "by_project",
  "by_subagent_type",
  "by_skill",
  "cache_breaks",
  "top_prompts",
  "by_day",
]);

// --- Session-naming compliance (ADR-0087) --------------------------------
//
// The rest of this file never reads a transcript directly — it only ever
// shells out to the analyzer above. This section is the one exception ADR-
// 0084 grants: `analyze-sessions.mjs`'s payload carries no session name or
// title (its keys are project/subagent/skill/day/prompt aggregates), so
// measuring compliance with the naming convention needs a direct, bounded
// read of the transcripts themselves.
//
// Every constraint from this file's header applies here too:
//   1. UNSUPPORTED FORMAT — a zero-records result across a non-empty file
//      set throws rather than reporting zeros (see computeNamingCompliance).
//   2. SCOPE — only ever reads a fixed-size PREFIX of each file (never the
//      whole thing, however large), and only files inside the caller's own
//      --since window under the already-scoped project directory.
//   3. RESOLUTION — an unlistable project directory or an empty file set is
//      a clear thrown error, never a silently empty report.

/**
 * How many bytes of a transcript's start this scan reads. Never the whole
 * file — transcripts in this project's store range from tens of KB to
 * several MB. Claude Code writes the `agent-name`/`ai-title` record early
 * (observed within the first ~200 lines / few KB across this project's own
 * store), so 64 KiB is generous headroom while keeping the scan cheap
 * regardless of how large the rest of the file grows — the exact ADR-0080
 * concern reason 2 in this file's header names. A session renamed only
 * after this window is, as a documented approximation, attributed to
 * whatever name (or absence of one) appears within it.
 */
export const SESSION_NAME_SCAN_BYTE_CAP = 64 * 1024;

/**
 * The repo's Claude Code session-naming convention (ADR-0087,
 * `docs/contributing/contributing.md` § Session naming) — mirrored from
 * `.claude/hooks/statusline-context-pressure.mjs`'s `SESSION_NAME_PATTERN`.
 * No shared module exists between `.claude/hooks/` and `bin/` today, so
 * keep the two definitions in sync by hand; ADR-0087 is the single source
 * of truth for the grammar both copies encode.
 */
export const SESSION_NAME_PATTERN =
  /^(feat|fix|audit|research|docs|review|ci|merge)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SESSION_NAME_MAX_LENGTH = 40;

/**
 * Read up to {@link SESSION_NAME_SCAN_BYTE_CAP} bytes from the START of one
 * transcript file — a fixed synchronous read (matching this file's existing
 * `execFileSync`/`readdirSync`/`statSync` style) rather than a streaming
 * read, since this is an on-demand tool (ADR-0084), not a hot path, and a
 * bounded `readSync` call is simpler than introducing async control flow
 * for one scan.
 *
 * @param {string} path
 * @param {{
 *   open: (path: string, flags: string) => number,
 *   read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number,
 *   close: (fd: number) => void,
 * }} fs injected filesystem seam
 * @returns {string | null} the decoded prefix, or null when the file could
 *   not be opened at all (permission error, vanished mid-scan) — distinct
 *   from a prefix that was read but carries no name record
 */
export function readTranscriptPrefix(path, fs) {
  /** @type {number} */
  let fd;
  try {
    fd = fs.open(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(SESSION_NAME_SCAN_BYTE_CAP);
    const bytesRead = fs.read(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    // A read failure on a file that vanished between open and stat/readdir
    // (a concurrent Claude Code session still writing) is exactly the
    // non-fatal-per-file case listRecentTranscripts already handles for its
    // own stat call — skip this one file, don't abort the whole scan.
    return null;
  } finally {
    fs.close(fd);
  }
}

/**
 * Extract the session's name from an already-read transcript prefix. An
 * explicit `/rename`/`-n` name (`type: "agent-name"`) takes precedence over
 * the AI-generated first-prompt title (`type: "ai-title"`), mirroring the
 * statusLine payload's own `session_name` precedence (ADR-0087) — a session
 * renamed after being auto-titled shows its rename, not its title. A line
 * that isn't valid JSON (including a final line truncated by the byte cap)
 * is skipped, not fatal: the transcript format is officially unsupported,
 * and one malformed line is not evidence the whole file is unreadable.
 *
 * @param {string} prefix
 * @returns {string | null} the resolved name, or null when neither record
 *   type appears in the scanned prefix
 */
export function extractSessionName(prefix) {
  /** @type {string | null} */
  let lastAgentName = null;
  /** @type {string | null} */
  let lastAiTitle = null;

  for (const line of prefix.split("\n")) {
    if (line.length === 0) continue;
    /** @type {unknown} */
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const type = /** @type {{ type?: unknown }} */ (record).type;
    if (type === "agent-name") {
      const name = /** @type {{ agentName?: unknown }} */ (record).agentName;
      if (typeof name === "string" && name.length > 0) lastAgentName = name;
    } else if (type === "ai-title") {
      const title = /** @type {{ aiTitle?: unknown }} */ (record).aiTitle;
      if (typeof title === "string" && title.length > 0) lastAiTitle = title;
    }
  }

  return lastAgentName ?? lastAiTitle;
}

/**
 * @param {string | null} name
 * @returns {"unnamed" | "conforming" | "non_conforming"}
 */
export function classifySessionName(name) {
  if (name === null) return "unnamed";
  return name.length <= SESSION_NAME_MAX_LENGTH &&
    SESSION_NAME_PATTERN.test(name)
    ? "conforming"
    : "non_conforming";
}

/**
 * Parse the bounded `<n>d`/`<n>h` window `parseSince` already validates,
 * shared here so the naming-compliance window matches the aggregate
 * telemetry window exactly.
 *
 * @param {string} since already validated by {@link parseSince}
 * @returns {number} milliseconds
 */
export function sinceToMs(since) {
  const amount = Number(since.slice(0, -1));
  return since.endsWith("d") ? amount * 86_400_000 : amount * 3_600_000;
}

/**
 * List every `*.jsonl` transcript directly under `dir` whose mtime falls
 * inside the `[nowMs - sinceMs, nowMs]` window. A file that vanishes between
 * `readdir` and `stat` (a concurrent Claude Code session still writing) is
 * skipped, not fatal — the same non-fatal-per-file discipline as
 * {@link readTranscriptPrefix}.
 *
 * @param {string} dir
 * @param {number} sinceMs
 * @param {number} nowMs
 * @param {{
 *   readdir: (dir: string) => { name: string, isFile: () => boolean }[],
 *   stat: (path: string) => { mtimeMs: number },
 * }} fs injected filesystem seam
 * @returns {string[]} absolute paths, order not guaranteed
 * @throws {Error} when `dir` cannot be listed at all
 */
export function listRecentTranscripts(dir, sinceMs, nowMs, fs) {
  /** @type {{ name: string, isFile: () => boolean }[]} */
  let entries;
  try {
    entries = fs.readdir(dir);
  } catch (cause) {
    throw new Error(
      `Cannot read the Claude Code project directory at ${dir} ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). The ` +
        `session-naming compliance scan needs this directory to exist and ` +
        `be listable.`,
      { cause },
    );
  }

  const cutoff = nowMs - sinceMs;
  const resolvedDir = resolve(dir);
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl") || !entry.isFile()) continue;
    const path = join(dir, entry.name);
    // A real readdir() entry name can never contain a path separator, but an
    // injected test/plugin seam could hand back something like
    // "../../etc/shadow.jsonl" — keep this scan confined to `dir` regardless
    // of what the fs seam returns, rather than relying only on real
    // filesystem semantics.
    if (!resolve(path).startsWith(resolvedDir + sep)) continue;
    try {
      if (fs.stat(path).mtimeMs >= cutoff) files.push(path);
    } catch {
      // Vanished between readdir and stat — skip, don't fail the sweep.
    }
  }
  return files;
}

/**
 * @typedef {{
 *   sessions_scanned: number,
 *   named: number,
 *   conforming: number,
 *   non_conforming: number,
 *   unnamed: number,
 *   non_conforming_names: string[],
 * }} NamingComplianceReport
 */

/**
 * Non-conforming names travel into the report verbatim by default, but they
 * are exactly the strings that FAILED validation — for an unrenamed session
 * that's the AI-generated title, which is derived from the session's first
 * user prompt. A prompt that happened to include a secret or other
 * sensitive text would otherwise appear, uncapped, in this report — and
 * this report's documented consumer (`promoting-work-log-lessons`) can
 * fold it into a work log that gets committed. Bounding the length and
 * stripping control characters reduces, without eliminating, that surface;
 * this is a local, on-demand admin tool reporting on the operator's own
 * sessions, not a service boundary, so a residual risk of a short secret
 * fragment surviving truncation is accepted rather than engineering full
 * secret-pattern redaction for this narrow, advisory read-out.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeNonConformingName(name) {
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL
  const stripped = name.replace(/[\x00-\x1f\x7f]/g, "");
  return stripped.length > SESSION_NAME_MAX_LENGTH
    ? `${stripped.slice(0, SESSION_NAME_MAX_LENGTH)}…`
    : stripped;
}

/**
 * Compute session-naming compliance (ADR-0087) for one project directory's
 * recent transcripts. Throws — rather than returning a zero-filled report —
 * on the two cases this file's header exists to prevent: no transcripts in
 * the window at all, and transcripts present but carrying zero recognizable
 * name records (the unsupported-format-drift signal).
 *
 * Known limitations, both inherent to a presence-only drift check (the same
 * shape as this file's `REQUIRED_KEYS` assertion for the analyzer payload):
 * a Claude Code upgrade that renames ONE of the two record `type` strings
 * (or the `agentName`/`aiTitle` field under a still-recognized type) would
 * not trip the zero-records throw below, since the other type would still
 * be found — those sessions would silently read as "unnamed" rather than
 * as a detected format drift. And `sessions_scanned` counts every file this
 * scan attempted, including ones `readTranscriptPrefix` could not open —
 * such a file contributes to neither `named` nor `unnamed`, so the three
 * counts are not guaranteed to sum to `sessions_scanned`.
 *
 * @param {{
 *   dir: string,
 *   since: string,
 *   now: () => number,
 *   fs: {
 *     readdir: (dir: string) => { name: string, isFile: () => boolean }[],
 *     stat: (path: string) => { mtimeMs: number },
 *     open: (path: string, flags: string) => number,
 *     read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number,
 *     close: (fd: number) => void,
 *   },
 * }} options
 * @returns {NamingComplianceReport}
 * @throws {Error} when no transcripts exist in the window, or when every
 *   transcript found carries zero `agent-name`/`ai-title` records
 */
export function computeNamingCompliance({ dir, since, now, fs }) {
  const files = listRecentTranscripts(dir, sinceToMs(since), now(), fs);

  if (files.length === 0) {
    throw new Error(
      `No transcript files found under ${dir} within the last ${since}. ` +
        `Session-naming compliance cannot be measured over an empty window.`,
    );
  }

  let named = 0;
  let conforming = 0;
  let nonConforming = 0;
  let unnamed = 0;
  /** @type {string[]} */
  const nonConformingNames = [];

  for (const path of files) {
    const prefix = readTranscriptPrefix(path, fs);
    if (prefix === null) continue; // unreadable file — skip, not fatal
    const name = extractSessionName(prefix);

    const classification = classifySessionName(name);
    if (classification === "unnamed") {
      unnamed += 1;
    } else {
      named += 1;
      if (classification === "conforming") conforming += 1;
      else {
        nonConforming += 1;
        nonConformingNames.push(
          sanitizeNonConformingName(/** @type {string} */ (name)),
        );
      }
    }
  }

  if (named === 0) {
    throw new Error(
      `Scanned ${files.length} transcript file(s) under ${dir} within the ` +
        `last ${since} and found ZERO agent-name/ai-title records in their ` +
        `first ${SESSION_NAME_SCAN_BYTE_CAP} bytes. Either every session in ` +
        `this window is genuinely both unnamed AND untitled (very unlikely — ` +
        `Claude Code auto-titles nearly every session), or the transcript's ` +
        `record shape has changed and this scan's field names are stale. ` +
        `The JSONL format is officially unsupported and can change between ` +
        `Claude Code versions (ADR-0084) — refusing to report zeros that ` +
        `would read like a healthy answer. Re-verify readTranscriptPrefix/ ` +
        `extractSessionName against a fresh transcript sample before ` +
        `trusting this number.`,
    );
  }

  return {
    sessions_scanned: files.length,
    named,
    conforming,
    non_conforming: nonConforming,
    unnamed,
    non_conforming_names: nonConformingNames,
  };
}

// --- End session-naming compliance ----------------------------------------

/**
 * Pick the analyzer revision to run: the most recently modified cached
 * revision. Deterministic given the same input, and reported by the caller so
 * a surprising result is attributable to a specific revision rather than to
 * "the plugin".
 *
 * @param {{ name: string, mtimeMs: number }[]} revisions
 * @returns {string | null} the chosen revision's directory name, or null when
 *   there is nothing to choose from
 */
export function pickRevision(revisions) {
  if (revisions.length === 0) return null;
  return [...revisions].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
  )[0].name;
}

/**
 * Resolve the analyzer beneath the plugin cache.
 *
 * Distinguishes the two failures a single `catch` would collapse into one:
 * a cache directory that is **absent** (the plugin was never installed, or
 * was removed) versus one that is **present but unreadable** — an `EACCES`,
 * or a revision directory that cannot be stat'd. Only the first means
 * "install the plugin"; reporting the second that way sends a maintainer
 * after a plugin that is already there, with the errno thrown away.
 *
 * Absent is a normal outcome and returns `null`. Anything else throws with
 * the original error chained via `cause`.
 *
 * @param {string} cacheDir
 * @param {{
 *   readdir: (dir: string) => { name: string, isDirectory: () => boolean }[],
 *   stat: (path: string) => { mtimeMs: number },
 * }} fs injected filesystem seam
 * @returns {string | null} the analyzer path, or null when no revision is cached
 * @throws {Error} when the cache exists but cannot be walked
 */
export function resolveAnalyzerPath(cacheDir, fs) {
  /** @type {{ name: string, isDirectory: () => boolean }[]} */
  let entries;
  try {
    entries = fs.readdir(cacheDir);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Cannot read the session-report plugin cache at ${cacheDir} ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). The ` +
        `cache directory exists but could not be listed — that is a broken ` +
        `installation, not a missing plugin, and needs a different fix.`,
      { cause },
    );
  }

  /** @type {{ name: string, mtimeMs: number }[]} */
  const revisions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(cacheDir, entry.name);
    try {
      revisions.push({ name: entry.name, mtimeMs: fs.stat(path).mtimeMs });
    } catch (cause) {
      throw new Error(
        `Cannot stat the cached session-report revision at ${path} ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). ` +
          `Refusing to pick a revision from a partially readable cache — ` +
          `the result would silently depend on which entries happened to be ` +
          `readable.`,
        { cause },
      );
    }
  }

  const revision = pickRevision(revisions);
  return revision === null ? null : join(cacheDir, revision, ANALYZER_SUBPATH);
}

/**
 * `--since` accepts only the analyzer's own bounded forms: a whole number of
 * days or hours. Validated here rather than passed through, because an
 * unparseable value does not error downstream — the analyzer falls back to
 * scanning everything, which is precisely the unbounded scan reason 2 in this
 * file's header exists to prevent.
 *
 * @param {string} value
 * @returns {string}
 * @throws {Error} on anything but `<digits>d` or `<digits>h`
 */
export function parseSince(value) {
  if (!SINCE_PATTERN.test(value)) {
    throw new Error(
      `--since "${value}" is not a bounded window. Use <n>d or <n>h ` +
        `(e.g. 7d, 48h). Refusing to forward it: an unrecognised value makes ` +
        `the analyzer scan the whole store.`,
    );
  }
  return value;
}

/**
 * `--top` must be a positive integer. A bare `Number()` would turn `abc` into
 * `NaN`, which {@link buildAnalyzerArgs} then stringifies into the literal
 * argument `--top NaN`.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 * @throws {Error} on a non-positive-integer value
 */
export function parseTop(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `--top "${value}" is not a positive integer. Refusing to forward it: ` +
        `it would reach the analyzer as a literal "${String(parsed)}".`,
    );
  }
  return parsed;
}

/**
 * The argv handed to the analyzer. Always carries `--json`, always pins
 * `--dir` and `--since`; a caller cannot widen the scan by omission.
 *
 * @param {{ dir: string, since: string, top?: number }} options
 * @returns {string[]}
 */
export function buildAnalyzerArgs({ dir, since, top }) {
  const args = ["--json", "--dir", dir, "--since", since];
  if (top !== undefined) args.push("--top", String(top));
  return args;
}

/**
 * Parse the analyzer's stdout, failing with a message that names the
 * unsupported-format risk rather than a bare SyntaxError.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown>}
 */
export function parsePayload(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new TypeError(`expected a JSON object, got ${typeof parsed}`);
    }
    return parsed;
  } catch (cause) {
    throw new Error(
      `analyze-sessions.mjs did not emit a JSON object ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). The ` +
        `transcript format and this analyzer are both internal to Claude ` +
        `Code and change between versions — re-check the plugin against the ` +
        `installed Claude Code before trusting any telemetry-derived finding.`,
      { cause },
    );
  }
}

/**
 * The shape assertion. Returns the missing keys rather than throwing, so the
 * caller decides between reporting and exiting — and so every branch is
 * assertable.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string[]} the required keys absent from `payload`
 */
export function missingKeys(payload) {
  return REQUIRED_KEYS.filter((key) => !Object.hasOwn(payload, key));
}

/**
 * The message a missing key produces. Kept separate so the test asserting it
 * names the instability cannot drift from the message a maintainer sees.
 *
 * @param {string[]} missing
 * @returns {string}
 */
export function shapeFailureMessage(missing) {
  return (
    `analyze-sessions.mjs --json is missing ${missing.length} required ` +
    `top-level key(s): ${missing.join(", ")}. The transcript JSONL format is ` +
    `INTERNAL to Claude Code and officially unsupported to parse — a version ` +
    `upgrade very likely changed it. Refusing to report telemetry that would ` +
    `otherwise degrade silently to zeros. Re-verify bin/session-telemetry.mjs ` +
    `against the installed session-report plugin (ADR-0084).`
  );
}

/** Real filesystem seam for {@link computeNamingCompliance}'s default. */
const REAL_NAMING_FS = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  stat: (path) => statSync(path),
  open: (path, flags) => openSync(path, flags),
  read: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

/**
 * Run the adapter against injected seams.
 *
 * @param {{
 *   analyzerPath: string | null,
 *   dir: string,
 *   since: string,
 *   top?: number,
 *   runAnalyzer: (analyzerPath: string, args: string[]) => string,
 *   reporter: ReturnType<typeof createReporter>,
 *   computeNaming?: (options: {
 *     dir: string,
 *     since: string,
 *     now: () => number,
 *     fs: typeof REAL_NAMING_FS,
 *   }) => NamingComplianceReport,
 *   now?: () => number,
 * }} deps
 * @returns {{
 *   ok: boolean,
 *   payload: Record<string, unknown> | null,
 *   naming: NamingComplianceReport | null,
 * }}
 */
export function runTelemetry({
  analyzerPath,
  dir,
  since,
  top,
  runAnalyzer,
  reporter,
  computeNaming = computeNamingCompliance,
  now = Date.now,
}) {
  /** @type {NamingComplianceReport | null} */
  let naming = null;
  try {
    naming = computeNaming({ dir, since, now, fs: REAL_NAMING_FS });
  } catch (cause) {
    reporter.error(
      `Session-naming compliance scan failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (analyzerPath === null) {
    reporter.error(
      `No session-report analyzer found under ~/${PLUGIN_CACHE_SUBPATH}. ` +
        `Install or re-enable the session-report plugin, or pass ` +
        `--analyzer <path> explicitly. Not falling back to a wider scan.`,
    );
    reporter.finish({ payload: null, analyzerPath: null, dir, since, naming });
    return { ok: false, payload: null, naming };
  }

  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = parsePayload(
      runAnalyzer(analyzerPath, buildAnalyzerArgs({ dir, since, top })),
    );
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish({ payload: null, analyzerPath, dir, since, naming });
    return { ok: false, payload: null, naming };
  }

  const missing = missingKeys(payload);
  if (missing.length > 0) {
    reporter.error(shapeFailureMessage(missing));
    reporter.finish({ payload: null, analyzerPath, dir, since, naming });
    return { ok: false, payload: null, naming };
  }

  reporter.succeed(
    naming !== null
      ? `Session telemetry for ${dir} since ${since} (analyzer: ` +
          `${analyzerPath}). ${naming.conforming}/${naming.named} named ` +
          `session(s) conform to ADR-0087.`
      : `Session telemetry for ${dir} since ${since} (analyzer: ${analyzerPath}).`,
  );
  const finished = reporter.finish({
    payload,
    analyzerPath,
    dir,
    since,
    naming,
  });
  return { ok: finished.ok, payload, naming };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  /** @param {string} name @param {string | undefined} fallback */
  const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
  };

  const home = homedir();
  const cacheDir = join(home, PLUGIN_CACHE_SUBPATH);

  /** @type {string | null} */
  let analyzerPath;
  /** @type {string} */
  let since;
  /** @type {number | undefined} */
  let top;
  try {
    analyzerPath =
      flag("--analyzer", undefined) ??
      resolveAnalyzerPath(cacheDir, {
        readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
        stat: (path) => statSync(path),
      });
    since = parseSince(flag("--since", DEFAULT_SINCE));
    top = parseTop(flag("--top", undefined));
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish({
      payload: null,
      analyzerPath: null,
      dir: null,
      since: null,
    });
    process.exit(1);
  }

  const outcome = runTelemetry({
    analyzerPath,
    dir: resolveClaudeProjectDir(
      (args) => execFileSync("git", args, { encoding: "utf8" }),
      home,
    ),
    since,
    top,
    runAnalyzer: (path, args) =>
      execFileSync(process.execPath, [path, ...args], {
        encoding: "utf8",
        // A bounded window's payload measured ~240 KB. 16 MiB matches the
        // other bin/ scripts that capture a child's --json output and leaves
        // three orders of magnitude of headroom; 256 MiB of buffered string
        // plus its JSON.parse would roughly double peak RSS, against the very
        // ADR-0080 budget reason 2 above cites.
        maxBuffer: 16 * 1024 * 1024,
      }),
    reporter,
  });

  // Unlike check:retrospective, this one DOES exit non-zero — it is on-demand,
  // never a pre-push gate, and a silent zero-filled report is the exact
  // failure this adapter exists to prevent.
  if (!outcome.ok) process.exit(1);
  if (!json) {
    process.stdout.write(JSON.stringify(outcome.payload, null, 2) + "\n");
    if (outcome.naming !== null) {
      process.stdout.write(JSON.stringify(outcome.naming, null, 2) + "\n");
    }
  }
}
