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
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * }} deps
 * @returns {{ ok: boolean, payload: Record<string, unknown> | null }}
 */
export function runTelemetry({
  analyzerPath,
  dir,
  since,
  top,
  runAnalyzer,
  reporter,
}) {
  if (analyzerPath === null) {
    reporter.error(
      `No session-report analyzer found under ~/${PLUGIN_CACHE_SUBPATH}. ` +
        `Install or re-enable the session-report plugin, or pass ` +
        `--analyzer <path> explicitly. Not falling back to a wider scan.`,
    );
    reporter.finish({ payload: null, analyzerPath: null, dir, since });
    return { ok: false, payload: null };
  }

  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = parsePayload(
      runAnalyzer(analyzerPath, buildAnalyzerArgs({ dir, since, top })),
    );
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish({ payload: null, analyzerPath, dir, since });
    return { ok: false, payload: null };
  }

  const missing = missingKeys(payload);
  if (missing.length > 0) {
    reporter.error(shapeFailureMessage(missing));
    reporter.finish({ payload: null, analyzerPath, dir, since });
    return { ok: false, payload: null };
  }

  reporter.succeed(
    `Session telemetry for ${dir} since ${since} (analyzer: ${analyzerPath}).`,
  );
  reporter.finish({ payload, analyzerPath, dir, since });
  return { ok: true, payload };
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
  if (!json)
    process.stdout.write(JSON.stringify(outcome.payload, null, 2) + "\n");
}
