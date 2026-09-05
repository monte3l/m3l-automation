#!/usr/bin/env node
// Fetches Anthropic's undocumented `/api/oauth/usage` endpoint out-of-band
// and writes a normalized per-model weekly-usage snapshot to
// `tmp/usage-weekly.json` — the harness's first network call (ADR-0092).
// `.claude/hooks/statusline-context-pressure.mjs` only ever reads that file
// via a bounded `readFileSync`; ADR-0080's "no subprocess, no network"
// invariant for a *wired statusline script* is unaffected because this file
// is not one — `bin/check-hooks.mjs`'s `FORBIDDEN_STATUSLINE_PATTERNS` scan
// is scoped to `STATUSLINE_SETTINGS_KEYS` scripts only.
//
// Usage:
//   node bin/usage-cache.mjs           # fetch + write tmp/usage-weekly.json
//   node bin/usage-cache.mjs --json    # diagnostic mode: credential source,
//                                      # HTTP status, model count — never the
//                                      # credential value itself
//   pnpm usage:refresh
//
// Credential precedence (never accepted as a CLI flag: a token living in
// argv is readable from any local account via /proc/<pid>/cmdline for the
// life of the process — the same leak ADR-0085 closed for the CLI wizard):
//   1. CLAUDE_CODE_OAUTH_TOKEN env var
//   2. ~/.claude/.credentials.json -> claudeAiOauth.accessToken
// No credential found -> exit 0, write nothing. The statusline's weekly-usage
// segments then simply do not render (fail-soft, not fail-loud).
//
// Fail-soft throughout: a missing credential, a non-200 response, a timeout,
// or an unparseable body all leave any existing cache file untouched rather
// than truncating it — a stale widget beats a missing one, and a missing one
// beats a crash.
//
// The response is undocumented; its real shape was confirmed with a live
// authenticated call during this file's implementation (2026-09-05) and
// differs from the flat top-level `models` array a pre-verification guess
// assumed — see `extractModelCandidates` and
// docs/adr/0092-out-of-band-usage-cache.md for the confirmed shape.
// `normalizeUsageResponse` stays defensive regardless: every field is
// optional, several plausible key spellings are accepted per field, and
// anything unrecognized is dropped rather than thrown on — an undocumented
// endpoint can still change shape without notice even once observed once.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
export const USAGE_CACHE_REL_PATH = "tmp/usage-weekly.json";
export const USAGE_CACHE_TTL_MS = 15 * 60 * 1000;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT =
  "m3l-automation-usage-cache/1 (+https://github.com/monte3l/m3l-automation)";

/**
 * Writes `contents` to `finalPath` atomically: a same-directory temp file
 * plus `renameSync`, never a direct `writeFileSync` on the live path.
 * `renameSync` replaces whatever inode currently sits at `finalPath` —
 * including a symlink — without ever opening or following it, closing off
 * a pre-planted-symlink write redirect. It also means a concurrent
 * statusline render never observes a partially-written (torn) file: it sees
 * either the previous complete cache or the new complete one, never
 * something in between (security-review finding).
 *
 * @param {string} finalPath
 * @param {string} contents
 */
function writeCacheAtomically(finalPath, contents) {
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmpPath, contents);
  renameSync(tmpPath, finalPath);
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

/**
 * Resolves the OAuth token to authenticate the usage fetch with, or null
 * when neither source has one. Pure with respect to actual I/O — env and
 * file reads are injected — matching `resolveBranch`'s DI shape so this is
 * directly unit-testable.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => string | null} readFile
 * @param {string} homeDir
 * @returns {{ source: "env" | "credentials-file", token: string } | null}
 */
export function resolveCredential(env, readFile, homeDir) {
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof envToken === "string" && envToken.length > 0) {
    return { source: "env", token: envToken };
  }

  const raw = readFile(join(homeDir, ".claude", ".credentials.json"));
  if (raw === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauth = /** @type {{ claudeAiOauth?: unknown }} */ (parsed)
    .claudeAiOauth;
  const token =
    oauth && typeof oauth === "object"
      ? /** @type {{ accessToken?: unknown }} */ (oauth).accessToken
      : undefined;
  return typeof token === "string" && token.length > 0
    ? { source: "credentials-file", token }
    : null;
}

/**
 * @param {unknown} mtimeMs the cache file's mtime in ms, or null when absent.
 * @param {number} now ms epoch.
 * @param {number} ttlMs
 * @returns {boolean}
 */
export function isCacheFresh(mtimeMs, now, ttlMs) {
  return typeof mtimeMs === "number" && now - mtimeMs < ttlMs;
}

/**
 * @param {...unknown} candidates
 * @returns {string | null} the first non-empty string candidate.
 */
function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

const MAX_MODEL_TEXT_LENGTH = 40;

/**
 * Strips C0/C1 control characters (including ESC, CR/LF) and clamps length.
 * The `/api/oauth/usage` response is undocumented and unversioned — this
 * file's own header notes it "can change shape without notice" — so a
 * model's `id`/`display_name` must never be trusted to reach a rendered
 * statusline segment verbatim: an embedded newline or ANSI escape sequence
 * would break `renderStatusLine`'s always-exactly-five-line guarantee and
 * could inject terminal control sequences (security-reviewer finding,
 * demonstrated live against `formatWeeklyModelSegments`).
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeDisplayText(text) {
  const CONTROL_CHARS_PATTERN = new RegExp(
    "[" +
      String.fromCharCode(0) +
      "-" +
      String.fromCharCode(0x1f) +
      String.fromCharCode(0x7f) +
      "-" +
      String.fromCharCode(0x9f) +
      "]",
    "g",
  );
  return text
    .replace(CONTROL_CHARS_PATTERN, "")
    .trim()
    .slice(0, MAX_MODEL_TEXT_LENGTH);
}

/**
 * @param {...unknown} candidates
 * @returns {number | null} the first finite-number candidate.
 */
function firstFiniteNumber(...candidates) {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * @param {unknown} value an ISO-8601 string or epoch (seconds or ms).
 * @returns {number | null} epoch seconds, or null when unparseable.
 */
function normalizeResetsAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // A millisecond epoch is 13 digits at today's dates; a seconds epoch is
    // 10. Treat anything over 10^12 as milliseconds.
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string} lowercase, hyphenated, alnum-only slug (e.g. "Fable" ->
 *   "fable") — used only when a `limits[]` entry's `scope.model.id` is null
 *   (observed live: it is for at least one real model) and no other
 *   id-shaped field is present, so a per-model segment still gets a stable,
 *   non-empty id derived from its display name.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {unknown} json the parsed `/api/oauth/usage` response body.
 * @returns {unknown[]} the best-effort array of per-model entry candidates,
 *   or `[]` when no recognizable array is found.
 *
 * Confirmed live 2026-09-05 (docs/adr/0092-out-of-band-usage-cache.md): the
 * real response has NO flat `models` array anywhere. Per-model weekly data
 * lives in a top-level `limits[]` array alongside session/aggregate entries,
 * distinguished by `group === "weekly"` and a non-null `scope.model` object
 * (an aggregate weekly entry, e.g. `kind: "weekly_all"`, has `scope: null`
 * and must NOT be treated as a per-model entry). The `models`/`seven_day.models`
 * shapes below are kept as a fallback only, in case a future response
 * revision introduces one — normalizeModelEntry's field-spelling flexibility
 * was written pre-verification and is deliberately kept defensive rather
 * than narrowed to exactly today's shape.
 */
function extractModelCandidates(json) {
  const j = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(j.limits)) {
    return j.limits.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = /** @type {Record<string, unknown>} */ (entry);
      const scope = /** @type {{ model?: unknown } | null} */ (
        typeof e.scope === "object" ? e.scope : null
      );
      return (
        e.group === "weekly" &&
        scope !== null &&
        typeof scope.model === "object" &&
        scope.model !== null
      );
    });
  }
  if (Array.isArray(j.models)) return j.models;
  const sevenDay = j.seven_day;
  if (typeof sevenDay === "object" && sevenDay !== null) {
    const nested = /** @type {{ models?: unknown }} */ (sevenDay).models;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

/**
 * @param {unknown} entry one raw candidate from {@link extractModelCandidates}.
 * @returns {{ id: string, display_name: string, used_percentage: number, resets_at: number | null } | null}
 */
function normalizeModelEntry(entry) {
  if (typeof entry !== "object" || entry === null) return null;
  const e = /** @type {Record<string, unknown>} */ (entry);

  // Real `limits[]` shape: the model lives under `scope.model.{id,display_name}`,
  // and `id` is nullable there even when `display_name` is present.
  const scope =
    e.scope && typeof e.scope === "object"
      ? /** @type {{ model?: unknown }} */ (e.scope).model
      : null;
  const scopeModel =
    scope && typeof scope === "object"
      ? /** @type {{ id?: unknown; display_name?: unknown }} */ (scope)
      : null;

  // The response is untrusted (undocumented, unversioned endpoint): a
  // control character or ANSI escape in `id`/`display_name` must never reach
  // a rendered statusline segment (security-reviewer finding, demonstrated
  // live against formatWeeklyModelSegments) — sanitize before any other use,
  // including feeding `slugify`.
  const rawDisplayName = firstString(
    scopeModel?.display_name,
    e.display_name,
    e.name,
    e.label,
  );
  const displayName =
    rawDisplayName !== null ? sanitizeDisplayText(rawDisplayName) : null;
  const rawId = firstString(scopeModel?.id, e.id, e.model, e.model_id, e.slug);
  const sanitizedId = rawId !== null ? sanitizeDisplayText(rawId) : null;
  const id =
    sanitizedId !== null && sanitizedId.length > 0
      ? sanitizedId
      : displayName !== null && displayName.length > 0
        ? slugify(displayName)
        : null;
  if (id === null || id.length === 0) return null;

  const pct = firstFiniteNumber(
    e.percent,
    e.used_percentage,
    e.utilization,
    e.percentage,
  );
  if (pct === null) return null;

  return {
    id,
    display_name:
      displayName !== null && displayName.length > 0 ? displayName : id,
    used_percentage: Math.min(100, Math.max(0, Math.round(pct))),
    resets_at: normalizeResetsAt(e.resets_at ?? e.reset_at ?? e.resetsAt),
  };
}

/**
 * Normalizes an `/api/oauth/usage` response into the cache's per-model
 * shape, sorted by usage descending. Every field is optional and several key
 * spellings are accepted (the endpoint is undocumented); an unrecognized or
 * malformed body yields `[]` rather than throwing.
 *
 * @param {unknown} json
 * @returns {Array<{ id: string, display_name: string, used_percentage: number, resets_at: number | null }>}
 */
export function normalizeUsageResponse(json) {
  if (typeof json !== "object" || json === null) return [];
  return extractModelCandidates(json)
    .map(normalizeModelEntry)
    .filter((m) => m !== null)
    .sort((a, b) => b.used_percentage - a.used_percentage);
}

/**
 * @param {string} token
 * @param {typeof fetch} [fetchImpl] injectable for testing.
 * @returns {Promise<{ status: number, ok: boolean, json: unknown }>}
 */
export async function fetchUsage(token, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, ok: res.ok, json: body };
  } catch {
    return { status: 0, ok: false, json: null };
  } finally {
    clearTimeout(timer);
  }
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json: jsonMode } = parseJsonFlag();
  const reporter = createReporter(jsonMode);

  const credential = resolveCredential(process.env, safeReadFile, homedir());
  if (credential === null) {
    reporter.info(
      "No CLAUDE_CODE_OAUTH_TOKEN and no ~/.claude/.credentials.json token found; nothing to refresh.",
    );
    reporter.succeed("No credential available; cache left untouched.");
    reporter.finish({
      credentialSource: null,
      httpStatus: null,
      modelCount: 0,
    });
    process.exit(0);
  }

  const { status, ok, json: body } = await fetchUsage(credential.token);
  if (!ok || body === null) {
    reporter.warn(
      `Usage fetch failed (HTTP ${status || "network error"}); cache left untouched.`,
    );
    reporter.finish({
      credentialSource: credential.source,
      httpStatus: status,
      modelCount: 0,
    });
    process.exit(0);
  }

  const models = normalizeUsageResponse(body);
  const entry = { fetched_at: Math.floor(Date.now() / 1000), models };
  try {
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeCacheAtomically(
      join(root, USAGE_CACHE_REL_PATH),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
  } catch (cause) {
    // This CLI normally runs detached with stdio:"ignore" (spawned by
    // refresh-usage-cache.mjs) — a write failure here would otherwise vanish
    // silently on every 15-minute TTL cycle. Report it and exit non-zero so
    // --json diagnostic mode (and a future process-exit-code check on the
    // spawning side) can observe it, unlike every other exit path above
    // which reports success-with-no-data by design.
    reporter.warn(
      `Failed to write ${USAGE_CACHE_REL_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish({
      credentialSource: credential.source,
      httpStatus: status,
      modelCount: 0,
    });
    process.exit(1);
  }
  reporter.change("created", USAGE_CACHE_REL_PATH);
  reporter.succeed(
    `Wrote ${models.length} model usage entr${models.length === 1 ? "y" : "ies"}.`,
  );
  reporter.finish({
    credentialSource: credential.source,
    httpStatus: status,
    modelCount: models.length,
  });
  process.exit(0);
}
