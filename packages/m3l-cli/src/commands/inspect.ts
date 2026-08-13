/**
 * `commands/inspect` — prints a single script's declared parameter table (or
 * suggests near-miss names for an unknown script), reading through the
 * discovery cache like `commands/list`.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliExitCode } from "../cli/errors.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadScriptParameters } from "../discovery/load-config.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../discovery/cache.js";

/**
 * Ranks `scriptName` against every known script name via
 * {@link Core.M3LUnknownParameterDetector}'s Damerau-Levenshtein suggestion
 * ranking, treating the known names as a throwaway `Core.M3LConfigSchema`'s
 * declared parameter names purely to reuse that ranking logic.
 */
function suggestScriptNames(
  scriptName: string,
  candidates: readonly M3LCliScriptCandidate[],
): readonly string[] {
  const schema = new Core.M3LConfigSchema(
    candidates.map(
      (candidate) =>
        new Core.M3LConfigParameter({
          name: candidate.name,
          type: Core.M3LConfigParameterType.STRING,
        }),
    ),
  );
  const detector = new Core.M3LUnknownParameterDetector(schema);
  return detector
    .detectWithSuggestions([scriptName])
    .flatMap((entry) => entry.suggestions);
}

/** Formats the aligned header + row lines for the human-readable rendering. */
function formatParameterLines(
  parameters: readonly M3LCliParameterDescriptor[],
): readonly string[] {
  const header = [
    "NAME",
    "ALIASES",
    "TYPE",
    "REQUIRED",
    "DEFAULT",
    "DESCRIPTION",
  ].join("  ");
  const body = parameters.map((parameter) =>
    [
      parameter.name,
      parameter.aliases.join(","),
      parameter.type,
      String(parameter.required),
      parameter.defaultValue ?? "",
      parameter.description,
    ].join("  "),
  );
  return [header, ...body];
}

/** Renders the resolved parameters through `context.output`, JSON or human-readable. */
function renderParameters(
  context: M3LCliCommandContext,
  parameters: readonly M3LCliParameterDescriptor[],
): void {
  if (context.jsonOutput) {
    context.output.info(JSON.stringify(parameters));
    return;
  }

  context.output.heading("Parameters");
  for (const line of formatParameterLines(parameters)) {
    context.output.info(line);
  }
}

/**
 * Resolves `scriptName`'s parameters, reusing a fresh cache entry when
 * available and otherwise loading (and best-effort persisting) them.
 */
async function resolveParameters(
  context: M3LCliCommandContext,
  candidate: M3LCliScriptCandidate,
): Promise<readonly M3LCliParameterDescriptor[]> {
  try {
    const cache = readDiscoveryCache(context.cacheFilePath);
    const mtimes = configMtimes(candidate.directory);
    const cached = cache[candidate.name];

    if (cached !== undefined && isCacheEntryFresh(cached, mtimes)) {
      return cached.parameters;
    }

    const parameters = await loadScriptParameters(candidate.directory);
    writeDiscoveryCache(context.cacheFilePath, {
      ...cache,
      [candidate.name]: { ...mtimes, parameters },
    });
    return parameters;
  } catch (error) {
    // A raw non-M3LCliError failure here (e.g. an EACCES from the
    // configMtimes freshness probe) is wrapped rather than propagated
    // unwrapped, so every caller of runInspect only ever observes an
    // M3LCliError; an already-typed M3LCliError (e.g. from
    // loadScriptParameters) is re-thrown unchanged, never double-wrapped.
    if (error instanceof M3LCliError) {
      throw error;
    }
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `failed to resolve parameters for script '${candidate.name}'`,
      { cause: error },
    );
  }
}

/**
 * Prints `scriptName`'s declared parameter table (name, aliases, type,
 * required, default, description), reading through the discovery cache the
 * same way `commands/list`'s `runList` does.
 *
 * @param context - The command context to run against.
 * @param scriptName - The script name to inspect.
 * @returns `0` on success.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   Damerau-Levenshtein `suggestions` over the known script names — when
 *   `scriptName` does not match a discovered script.
 * @throws {@link M3LCliError} coded `ERR_CLI_CONFIG_IMPORT` when the matched
 *   script's config module fails to load or its freshness probe fails; an
 *   already-typed `M3LCliError` (e.g. from {@link loadScriptParameters})
 *   propagates unchanged, and any other failure is wrapped into one.
 *
 * @example
 * ```ts
 * const exitCode = await runInspect(context, "exporter");
 * // 0 on success; throws M3LCliError on an unknown script or a config-load failure
 * ```
 */
export async function runInspect(
  context: M3LCliCommandContext,
  scriptName: string,
): Promise<M3LCliExitCode> {
  const candidates = discoverScripts(context.workspaceRoot);
  const candidate = candidates.find((entry) => entry.name === scriptName);

  if (candidate === undefined) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_SCRIPT",
      `unknown script '${scriptName}'`,
      { suggestions: suggestScriptNames(scriptName, candidates) },
    );
  }

  const parameters = await resolveParameters(context, candidate);
  renderParameters(context, parameters);
  return 0;
}
