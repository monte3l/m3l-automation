/**
 * `commands/list` — enumerates every `scripts/*` package with its declared
 * parameter count, reading through the discovery cache via the shared
 * `loadParametersCached` helper (8d dedup refactor, 8b review CR#4).
 *
 * @packageDocumentation
 */

import type { M3LCliCommandContext } from "./context.js";
import type { M3LCliExitCode } from "../cli/errors.js";
import { formatAlignedTable } from "../cli/table.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";

/**
 * One rendered row of `m3l list` output: one per discovered script. A
 * discriminated union on `loadError` — a successfully loaded script always
 * carries a `number` `parameterCount` and a `null` `loadError`; a script
 * whose config failed to load always carries a `null` `parameterCount` and
 * the failure message — so the render site can never observe the
 * unreachable "both present" or "both absent" combinations.
 */
export type M3LCliListRow = {
  /** The script's name (its directory basename). */
  readonly name: string;
  /** The script's manifest description, or `""` when absent. */
  readonly description: string;
} & (
  | {
      /** The script's declared parameter count. */
      readonly parameterCount: number;
      /** `null` — the script's config loaded successfully. */
      readonly loadError: null;
    }
  | {
      /** `null` — the script's config failed to load. */
      readonly parameterCount: null;
      /** The config-load failure message. */
      readonly loadError: string;
    }
);

/** The human-readable rendering's column headers. */
const HEADER = ["NAME", "DESCRIPTION", "PARAMETERS"] as const;

/** Renders a single row's cells for {@link formatAlignedTable}. */
function toTableRow(row: M3LCliListRow): readonly string[] {
  const parameters =
    row.loadError !== null
      ? `ERROR: ${row.loadError}`
      : String(row.parameterCount);
  return [row.name, row.description, parameters];
}

/**
 * Resolves a single script candidate's row, reading through
 * {@link loadParametersCached}; a load failure annotates the row rather than
 * aborting the whole listing.
 */
async function resolveRow(
  candidate: M3LCliScriptCandidate,
  context: M3LCliCommandContext,
): Promise<M3LCliListRow> {
  try {
    const parameters = await loadParametersCached(
      candidate.name,
      candidate.directory,
      context.cacheFilePath,
    );
    return {
      name: candidate.name,
      description: candidate.description,
      parameterCount: parameters.length,
      loadError: null,
    };
  } catch (error) {
    return {
      name: candidate.name,
      description: candidate.description,
      parameterCount: null,
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Renders the resolved rows through `context.output`, JSON or human-readable. */
function renderRows(
  context: M3LCliCommandContext,
  rows: readonly M3LCliListRow[],
): void {
  if (context.jsonOutput) {
    context.output.info(JSON.stringify(rows));
    return;
  }

  context.output.heading("Scripts");
  for (const line of formatAlignedTable(HEADER, rows.map(toTableRow))) {
    context.output.info(line);
  }
}

/**
 * Discovers every `scripts/*` package under `context.workspaceRoot` and
 * renders one row per script (name/description/parameter count/load error).
 *
 * Reads through the discovery cache via {@link loadParametersCached}: a
 * script whose cached entry is still fresh reuses its cached parameter count
 * without importing the script's config module; a stale or missing entry
 * loads the config module and best-effort persists the refreshed cache. A
 * single script's config-load failure is recorded on its row
 * (`parameterCount: null`, `loadError` set) rather than aborting the
 * listing — only a `discoverScripts` failure (e.g. no workspace root)
 * propagates.
 *
 * @param context - The command context to run against.
 * @returns `0` always — partial per-script load failures are included in the
 *   rendered output, not surfaced as a non-zero exit.
 * @throws Whatever {@link discoverScripts} throws (e.g. `M3LCliError` coded
 *   `ERR_CLI_WORKSPACE_NOT_FOUND`), unwrapped.
 *
 * @example
 * ```ts
 * const exitCode = await runList(context);
 * // 0 — partial per-script load failures are annotated on their row, not a
 * // non-zero exit
 * ```
 */
export async function runList(
  context: M3LCliCommandContext,
): Promise<M3LCliExitCode> {
  const candidates = discoverScripts(context.workspaceRoot);

  const rows: M3LCliListRow[] = [];
  for (const candidate of candidates) {
    rows.push(await resolveRow(candidate, context));
  }

  renderRows(context, rows);
  return 0;
}
