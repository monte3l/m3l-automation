/**
 * `discovery/cache` — the best-effort, never-throwing discovery cache that
 * lets `list`/`inspect` skip re-importing a script's config module when its
 * `dist`/`src` mtimes haven't changed since the last run.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

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
 * Checks whether `value` is a well-formed cached {@link M3LCliParameterDescriptor}
 * element — every field present with its documented primitive shape,
 * including the 8f-added `secret` boolean. Validated element-wise (rather
 * than trusting the array's shape alone) so a single malformed or stale
 * (pre-8f, missing `secret`) parameter entry drops the whole cache entry it
 * belongs to — this is also how a pre-8f cache gets invalidated exactly once
 * on upgrade, since every entry it wrote lacked `secret`.
 *
 * @param value - The candidate `parameters` array element to check.
 * @returns Whether `value` is a well-formed cached parameter descriptor.
 */
function isValidCachedParameter(
  value: unknown,
): value is M3LCliParameterDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }
  const { name, aliases, type, required, defaultValue, description, secret } =
    value;
  return (
    typeof name === "string" &&
    Array.isArray(aliases) &&
    aliases.every((alias) => typeof alias === "string") &&
    typeof type === "string" &&
    typeof required === "boolean" &&
    (defaultValue === undefined || typeof defaultValue === "string") &&
    typeof description === "string" &&
    typeof secret === "boolean"
  );
}

/**
 * Checks whether `value` has the minimal shape {@link M3LCliDiscoveryCacheEntry}
 * requires — `srcMtimeMs`/`distMtimeMs` each `number | null`, and `parameters`
 * an array whose every element passes {@link isValidCachedParameter} — so a
 * malformed entry in a hand-edited or corrupted cache file (e.g.
 * `{"foo": null}`, an entry missing `parameters`, or one whose parameters
 * lack the 8f `secret` field) is dropped rather than trusted through to a
 * raw `TypeError` in `list`/`inspect`.
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
    Array.isArray(parameters) &&
    parameters.every(isValidCachedParameter)
  );
}

/**
 * Projects a validated {@link M3LCliParameterDescriptor} down to exactly its
 * declared fields, so a hand-added extra field on a parsed cache element
 * cannot pass through into a `list`/`inspect --json` output.
 *
 * @param parameter - An element already confirmed well-formed by
 *   {@link isValidCachedParameter}.
 * @returns A new object carrying only the declared fields.
 */
function projectCachedParameter(
  parameter: M3LCliParameterDescriptor,
): M3LCliParameterDescriptor {
  return {
    name: parameter.name,
    aliases: [...parameter.aliases],
    type: parameter.type,
    required: parameter.required,
    defaultValue: parameter.defaultValue,
    description: parameter.description,
    // `isValidCachedParameter` already proved `secret` is a `boolean` (never
    // `undefined`) on every element reaching this function; the `?? false`
    // only satisfies the public descriptor type's optional `secret?:
    // boolean`, it never actually observes the fallback at runtime.
    secret: parameter.secret ?? false,
  };
}

/**
 * Projects a validated {@link M3LCliDiscoveryCacheEntry} down to exactly its
 * declared fields (see {@link projectCachedParameter} for the same treatment
 * of each `parameters` element), so a hand-added extra top-level field on a
 * parsed cache entry cannot pass through into a `list`/`inspect --json`
 * output.
 *
 * @param entry - An entry already confirmed well-formed by
 *   {@link isValidCacheEntry}.
 * @returns A new object carrying only the declared fields.
 */
function projectCacheEntry(
  entry: M3LCliDiscoveryCacheEntry,
): M3LCliDiscoveryCacheEntry {
  return {
    srcMtimeMs: entry.srcMtimeMs,
    distMtimeMs: entry.distMtimeMs,
    parameters: entry.parameters.map(projectCachedParameter),
  };
}

/**
 * Filters a parsed cache payload down to its well-formed entries (see
 * {@link isValidCacheEntry}), silently dropping any entry that fails the
 * shape guard, skipping a dangerous key (`__proto__`, `constructor`,
 * `prototype` — see `Core.isDangerousKey`) entirely rather than validating
 * it, and projecting every kept entry to exactly its declared fields (see
 * {@link projectCacheEntry}).
 *
 * @param payload - The parsed, already-confirmed-plain-object cache payload.
 * @returns Only the entries that pass the shape guard, each narrowed to its
 *   declared fields.
 */
function filterValidEntries(
  payload: Record<string, unknown>,
): M3LCliDiscoveryCache {
  const validated: Record<string, M3LCliDiscoveryCacheEntry> = {};
  for (const [name, entry] of Object.entries(payload)) {
    if (Core.isDangerousKey(name)) {
      continue;
    }
    if (isValidCacheEntry(entry)) {
      validated[name] = projectCacheEntry(entry);
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
