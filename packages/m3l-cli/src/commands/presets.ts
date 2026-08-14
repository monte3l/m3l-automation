/**
 * `commands/presets` — lists a script's declared preset files, rendering one
 * row per preset (name, format, declared parameter *names* — never values —
 * and a validity status), reading through the discovery cache for the
 * script's declared parameters.
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
import { listPresetFiles, readPresetRecord } from "../presets/store.js";
import type { M3LCliPresetFile } from "../presets/store.js";

/** One preset file's resolved rendering: its keys (never values) or a load-error summary. */
interface M3LCliResolvedPreset {
  readonly file: M3LCliPresetFile;
  readonly keys: readonly string[] | undefined;
  readonly error: string | undefined;
}

/** Resolves a single preset file's keys, or its load-error summary — never its values. */
function resolvePreset(
  file: M3LCliPresetFile,
  descriptors: Parameters<typeof readPresetRecord>[1],
): M3LCliResolvedPreset {
  try {
    const record = readPresetRecord(file.filePath, descriptors);
    return { file, keys: Object.keys(record), error: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { file, keys: undefined, error: message };
  }
}

/** The human-readable rendering's column headers. */
const HEADER = ["NAME", "FORMAT", "PARAMETERS", "STATUS"] as const;

/** Renders a single resolved preset's cells for {@link formatAlignedTable}. */
function toTableRow(resolved: M3LCliResolvedPreset): readonly string[] {
  return [
    resolved.file.name,
    resolved.file.format,
    (resolved.keys ?? []).join(","),
    resolved.error ?? "ok",
  ];
}

/** Renders the resolved presets through `context.output`, JSON or human-readable. */
function renderPresets(
  context: M3LCliCommandContext,
  resolved: readonly M3LCliResolvedPreset[],
): void {
  if (context.jsonOutput) {
    context.output.info(
      JSON.stringify(
        resolved.map((entry) =>
          entry.error === undefined
            ? {
                name: entry.file.name,
                filePath: entry.file.filePath,
                format: entry.file.format,
                keys: entry.keys,
              }
            : {
                name: entry.file.name,
                filePath: entry.file.filePath,
                format: entry.file.format,
                error: entry.error,
              },
        ),
      ),
    );
    return;
  }

  context.output.heading("Presets");
  if (resolved.length === 0) {
    context.output.info("no presets found");
    return;
  }
  for (const line of formatAlignedTable(HEADER, resolved.map(toTableRow))) {
    context.output.info(line);
  }
}

/**
 * Lists `scriptName`'s declared preset files, rendering one row per preset —
 * its name, format, declared parameter names (never their values), and a
 * validity status ("ok", or the load-error summary for an invalid preset,
 * which is rendered as a row rather than aborting the whole listing).
 *
 * @param context - The command context to run against.
 * @param scriptName - The script whose presets to list.
 * @returns `0` always (an invalid individual preset is a rendered row, not a
 *   failure).
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   Damerau-Levenshtein `suggestions` over the known script names — when
 *   `scriptName` does not match a discovered script.
 * @throws Whatever {@link loadParametersCached} throws, unwrapped — an
 *   already-typed `M3LCliError` propagates unchanged.
 *
 * @example
 * ```ts
 * const exitCode = await runPresets(context, "exporter");
 * ```
 */
export async function runPresets(
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

  const descriptors = await loadParametersCached(
    candidate.name,
    candidate.directory,
    context.cacheFilePath,
  );
  const files = listPresetFiles(context.workspaceRoot);
  const resolved = files.map((file) => resolvePreset(file, descriptors));

  renderPresets(context, resolved);
  return 0;
}
