/**
 * `commands/inspect` — prints a single script's declared parameter table (or
 * suggests near-miss names for an unknown script), reading through the
 * discovery cache via the shared `loadParametersCached` helper (8d dedup
 * refactor, 8b review CR#4) and rendering through the shared
 * `formatAlignedTable` helper (8d dedup refactor, 8b review CR#5).
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliExitCode } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import { formatAlignedTable } from "../cli/table.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";

/** The human-readable rendering's column headers. */
const HEADER = [
  "NAME",
  "ALIASES",
  "TYPE",
  "REQUIRED",
  "DEFAULT",
  "DESCRIPTION",
] as const;

/** Renders a single parameter's cells for {@link formatAlignedTable}. */
function toTableRow(parameter: M3LCliParameterDescriptor): readonly string[] {
  return [
    parameter.name,
    parameter.aliases.join(","),
    parameter.type,
    String(parameter.required),
    parameter.defaultValue ?? "",
    parameter.description,
  ];
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
  for (const line of formatAlignedTable(HEADER, parameters.map(toTableRow))) {
    context.output.info(line);
  }
}

/**
 * Prints `scriptName`'s declared parameter table (name, aliases, type,
 * required, default, description), reading through the discovery cache via
 * {@link loadParametersCached}.
 *
 * @param context - The command context to run against.
 * @param scriptName - The script name to inspect.
 * @returns `0` on success.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   Damerau-Levenshtein `suggestions` over the known script names — when
 *   `scriptName` does not match a discovered script.
 * @throws Whatever {@link loadParametersCached} throws, unwrapped — an
 *   already-typed `M3LCliError` propagates unchanged.
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
      {
        suggestions: suggestNames(
          scriptName,
          candidates.map((entry) => entry.name),
        ),
      },
    );
  }

  const parameters = await loadParametersCached(
    candidate.name,
    candidate.directory,
    context.cacheFilePath,
  );
  renderParameters(context, parameters);
  return 0;
}
