/**
 * `cli/paths` — resolves the m3l CLI's cache/history file paths, honoring the
 * `M3L_CACHE_DIR` environment override `main.ts` threads through for
 * testability. Extracted out of `main.ts` (a pure move, no behavior change)
 * to keep that composition root under the file-budget ceiling.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

/**
 * The environment variable `@m3l-automation/m3l-common`'s `M3LPaths`
 * honors to redirect its cache directory (see
 * `M3LPathEnvironmentVariables.CACHE_DIR` in `core/utils/M3LPaths.ts`).
 * Consulted directly here — rather
 * than by constructing an `M3LPaths` instance — because `M3LPaths` detects
 * its base via the `M3LExecutionEnvironment` process-global singleton, which
 * would ignore the `cwd` this module already threads through for
 * testability.
 */
const CACHE_DIR_ENV_VAR = "M3L_CACHE_DIR";

/**
 * Resolves the directory the {@link CACHE_DIR_ENV_VAR} override (or the
 * `<workspaceRoot>/data/cache` default) names — shared by
 * {@link resolveCacheFilePath} and {@link resolveHistoryFilePath} so both
 * files sit under the same root.
 */
function resolveCacheDir(
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const cacheDirOverride = env[CACHE_DIR_ENV_VAR];
  return cacheDirOverride !== undefined && cacheDirOverride !== ""
    ? cacheDirOverride
    : join(workspaceRoot, "data", "cache");
}

/**
 * Resolves the discovery cache file's absolute path: under the
 * {@link CACHE_DIR_ENV_VAR} override when set in `env`, otherwise under
 * `<workspaceRoot>/data/cache`.
 */
export function resolveCacheFilePath(
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveCacheDir(workspaceRoot, env), "m3l-cli", "discovery.json");
}

/**
 * Resolves the run-history file's absolute path, mirroring
 * {@link resolveCacheFilePath}'s `M3L_CACHE_DIR`/workspace-root resolution
 * (8f) — the two files sit side by side under the same cache directory.
 */
export function resolveHistoryFilePath(
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveCacheDir(workspaceRoot, env), "m3l-cli", "history.json");
}

/**
 * The environment variable overriding the managed output directory (V2
 * slice 2, #539 / ADR-0063) — distinct from {@link CACHE_DIR_ENV_VAR} and
 * from `@m3l-automation/m3l-common`'s own `M3L_DATA_DIR`: this module never
 * consults either when resolving the output directory.
 *
 * Deliberately the SAME variable name `M3LPathEnvironmentVariables.OUTPUT_DIR`
 * (`core/utils/M3LPaths.ts`) already honors, so a caller setting
 * `M3L_OUTPUT_DIR` redirects both this scan target and every spawned script's
 * own `M3LPaths.outputDir` in agreement — do not rename this without
 * preserving that identity.
 */
const OUTPUT_DIR_ENV_VAR = "M3L_OUTPUT_DIR";

/**
 * Resolves the managed output directory's absolute path: the
 * {@link OUTPUT_DIR_ENV_VAR} override when set and non-empty in `env`,
 * otherwise `<workspaceRoot>/data/output` — a distinct default from
 * {@link resolveCacheDir}'s `data/cache` (deliberately not shared, per this
 * module's own doc: the cache and output directories are unrelated).
 *
 * This is the same env var name `M3LPathEnvironmentVariables.OUTPUT_DIR`
 * (`core/utils/M3LPaths.ts`) already honors — intentionally, so that setting
 * `M3L_OUTPUT_DIR` redirects both the CLI's own report scan (this module) and
 * every spawned script's own `M3LPaths.outputDir`, keeping parent and child
 * pointed at the same directory.
 */
export function resolveOutputDirPath(
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const outputDirOverride = env[OUTPUT_DIR_ENV_VAR];
  return outputDirOverride !== undefined && outputDirOverride !== ""
    ? outputDirOverride
    : join(workspaceRoot, "data", "output");
}
