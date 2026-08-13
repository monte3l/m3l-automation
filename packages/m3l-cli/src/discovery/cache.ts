/**
 * `discovery/cache` — the best-effort, never-throwing discovery cache that
 * lets `list`/`inspect` skip re-importing a script's config module when its
 * `dist`/`src` mtimes haven't changed since the last run.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { M3LCliParameterDescriptor } from "./load-config.js";

/** Indentation width for the pretty-printed cache file. */
const CACHE_JSON_INDENT = 2;

/**
 * The recorded `src`/`dist` config-module mtimes a cache entry carries, and
 * the shape a fresh {@link configMtimes} probe returns for comparison against
 * one — factored out so both sides of the freshness check
 * ({@link isCacheEntryFresh}) share a single named shape.
 */
export interface M3LCliConfigMtimes {
  /** The `src/config.ts` mtime, or `null` when absent. */
  readonly srcMtimeMs: number | null;
  /** The `dist/config.js` mtime, or `null` when absent. */
  readonly distMtimeMs: number | null;
}

/** A single script's cached discovery result. */
export interface M3LCliDiscoveryCacheEntry extends M3LCliConfigMtimes {
  /** The script's described parameters as of this cache entry. */
  readonly parameters: readonly M3LCliParameterDescriptor[];
}

/** The on-disk discovery cache: one entry per script name. */
export type M3LCliDiscoveryCache = Readonly<
  Record<string, M3LCliDiscoveryCacheEntry>
>;

/**
 * Checks whether `value` is a non-array plain object — the shape a parsed
 * cache payload must have before its entries are trusted.
 *
 * @param value - The parsed JSON payload to check.
 * @returns Whether `value` is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether `value` has the minimal shape {@link M3LCliDiscoveryCacheEntry}
 * requires — `srcMtimeMs`/`distMtimeMs` each `number | null`, and `parameters`
 * an array — so a malformed entry in a hand-edited or corrupted cache file
 * (e.g. `{"foo": null}`, or an entry missing `parameters`) is dropped rather
 * than trusted through to a raw `TypeError` in `list`/`inspect`.
 *
 * @param value - The candidate cache-entry value to check.
 * @returns Whether `value` is a well-formed {@link M3LCliDiscoveryCacheEntry}.
 */
function isValidCacheEntry(value: unknown): value is M3LCliDiscoveryCacheEntry {
  if (!isPlainObject(value)) {
    return false;
  }
  const { srcMtimeMs, distMtimeMs, parameters } = value;
  return (
    (typeof srcMtimeMs === "number" || srcMtimeMs === null) &&
    (typeof distMtimeMs === "number" || distMtimeMs === null) &&
    Array.isArray(parameters)
  );
}

/**
 * Filters a parsed cache payload down to its well-formed entries (see
 * {@link isValidCacheEntry}), silently dropping any entry that fails the
 * shape guard.
 *
 * @param payload - The parsed, already-confirmed-plain-object cache payload.
 * @returns Only the entries that pass the shape guard.
 */
function filterValidEntries(
  payload: Record<string, unknown>,
): M3LCliDiscoveryCache {
  const validated: Record<string, M3LCliDiscoveryCacheEntry> = {};
  for (const [name, entry] of Object.entries(payload)) {
    if (isValidCacheEntry(entry)) {
      validated[name] = entry;
    }
  }
  return validated;
}

/**
 * Reads and parses the discovery cache file, tolerating every failure mode
 * (missing file, unreadable file, invalid JSON, non-object payload, or a
 * malformed individual entry) by falling back to an empty cache — or
 * dropping just the malformed entries — since this cache is a pure
 * performance optimization and must never block discovery.
 *
 * @param cacheFilePath - The absolute path to the cache file.
 * @returns The parsed cache with only its well-formed entries (see
 *   {@link isValidCacheEntry}), or `{}` on any failure.
 *
 * @example
 * ```ts
 * const cache = readDiscoveryCache("/repo/data/cache/m3l-cli/discovery.json");
 * // {} when the file is missing, unreadable, or holds malformed entries
 * ```
 */
export function readDiscoveryCache(
  cacheFilePath: string,
): M3LCliDiscoveryCache {
  try {
    const raw = readFileSync(cacheFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {};
    }
    return filterValidEntries(parsed);
  } catch {
    return {};
  }
}

/**
 * Writes the discovery cache file, creating its parent directory as needed.
 * Never throws — any failure (permission, disk-full, etc.) is reported via
 * the boolean return since the cache is a pure performance optimization.
 *
 * @param cacheFilePath - The absolute path to the cache file.
 * @param cache - The cache contents to persist.
 * @returns Whether the write succeeded.
 *
 * @example
 * ```ts
 * const wrote = writeDiscoveryCache("/repo/data/cache/m3l-cli/discovery.json", {});
 * // true on success; false (never a throw) on any write failure
 * ```
 */
export function writeDiscoveryCache(
  cacheFilePath: string,
  cache: M3LCliDiscoveryCache,
): boolean {
  try {
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify(cache, undefined, CACHE_JSON_INDENT),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether `error` is a Node `ErrnoException` carrying the given
 * `code`.
 *
 * @param error - The caught value to check.
 * @param code - The `errno` code to match, e.g. `"ENOENT"`.
 * @returns Whether `error` is an `ErrnoException` with a matching `code`.
 */
function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Resolves a single file's mtime in milliseconds, or `null` when the file
 * does not exist.
 *
 * @param path - The absolute file path to stat.
 * @returns The file's mtime, or `null` when absent.
 * @throws The underlying error when `statSync` fails for a reason other than
 *   the file being absent (`ENOENT`).
 */
function statMtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/**
 * Resolves the current mtimes of a script's `src/config.ts` and
 * `dist/config.js`, so a cached entry can be checked for freshness.
 *
 * @param scriptDirectory - The script's root directory.
 * @returns Each file's mtime in milliseconds, or `null` when absent.
 *
 * @example
 * ```ts
 * const mtimes = configMtimes("/repo/scripts/foo");
 * // { srcMtimeMs: 1732000000000, distMtimeMs: 1732000005000 }
 * ```
 */
export function configMtimes(scriptDirectory: string): M3LCliConfigMtimes {
  return {
    srcMtimeMs: statMtimeOrNull(join(scriptDirectory, "src", "config.ts")),
    distMtimeMs: statMtimeOrNull(join(scriptDirectory, "dist", "config.js")),
  };
}

/**
 * Checks whether a cached entry is still fresh against the script's current
 * `configMtimes` probe — a strict equality check on both fields.
 *
 * @param entry - The cached entry to check.
 * @param mtimes - The current mtimes probe (see {@link configMtimes}).
 * @returns Whether the entry is fresh.
 *
 * @example
 * ```ts
 * const fresh = isCacheEntryFresh(entry, configMtimes("/repo/scripts/foo"));
 * // true when neither config file has changed since `entry` was cached
 * ```
 */
export function isCacheEntryFresh(
  entry: M3LCliDiscoveryCacheEntry,
  mtimes: M3LCliConfigMtimes,
): boolean {
  return (
    entry.srcMtimeMs === mtimes.srcMtimeMs &&
    entry.distMtimeMs === mtimes.distMtimeMs
  );
}
