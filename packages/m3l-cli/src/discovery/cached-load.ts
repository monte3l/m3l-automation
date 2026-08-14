/**
 * `discovery/cached-load` — the shared freshness-probe → reuse-or-load →
 * best-effort-persist scaffolding factored out of
 * `commands/list.ts`/`commands/inspect.ts` (8d dedup refactor, 8b review
 * CR#4).
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";
import { loadScriptParameters } from "./load-config.js";
import type { M3LCliParameterDescriptor } from "./load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "./cache.js";

/**
 * Resolves `scriptName`'s parameters, reusing a fresh cache entry (see
 * {@link isCacheEntryFresh}) when available and otherwise loading via
 * {@link loadScriptParameters} and best-effort persisting the refreshed
 * cache entry.
 *
 * @param scriptName - The script's name, used as its cache-entry key.
 * @param scriptDirectory - The script's root directory.
 * @param cacheFilePath - The absolute path to the discovery cache file.
 * @returns The script's described parameters.
 * @throws {@link M3LCliError} coded `ERR_CLI_CONFIG_IMPORT` when the
 *   freshness probe or the load fails; an already-typed `M3LCliError` (e.g.
 *   from {@link loadScriptParameters}) propagates unchanged, and any other
 *   failure is wrapped with the original chained as `cause`.
 *
 * @example
 * ```ts
 * const parameters = await loadParametersCached(
 *   "exporter",
 *   "/repo/scripts/exporter",
 *   "/repo/data/cache/m3l-cli/discovery.json",
 * );
 * ```
 */
export async function loadParametersCached(
  scriptName: string,
  scriptDirectory: string,
  cacheFilePath: string,
): Promise<readonly M3LCliParameterDescriptor[]> {
  try {
    const cache = readDiscoveryCache(cacheFilePath);
    const mtimes = configMtimes(scriptDirectory);
    const cached = Object.hasOwn(cache, scriptName)
      ? cache[scriptName]
      : undefined;

    if (cached !== undefined && isCacheEntryFresh(cached, mtimes)) {
      return cached.parameters;
    }

    const parameters = await loadScriptParameters(scriptDirectory);
    writeDiscoveryCache(cacheFilePath, {
      ...cache,
      [scriptName]: { ...mtimes, parameters },
    });
    return parameters;
  } catch (error) {
    // An already-typed M3LCliError (e.g. from loadScriptParameters)
    // propagates unchanged, never double-wrapped; a raw failure (e.g. an
    // EACCES from the configMtimes freshness probe) is wrapped so every
    // caller only ever observes an M3LCliError.
    if (error instanceof M3LCliError) {
      throw error;
    }
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `failed to resolve parameters for script '${scriptName}'`,
      { cause: error },
    );
  }
}
