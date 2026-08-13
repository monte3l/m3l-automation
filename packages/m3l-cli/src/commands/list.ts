/**
 * `commands/list` — enumerates every `scripts/*` package with its declared
 * parameter count, reading through the discovery cache.
 *
 * @packageDocumentation
 */

import type { M3LCliCommandContext } from "./context.js";
import { M3LCliError } from "../cli/errors.js";
import type { M3LCliExitCode } from "../cli/errors.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadScriptParameters } from "../discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../discovery/cache.js";
import type {
  M3LCliDiscoveryCache,
  M3LCliDiscoveryCacheEntry,
} from "../discovery/cache.js";

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

/** Result of resolving a single candidate: its row plus a cache update, if any. */
interface M3LCliListRowResolution {
  readonly row: M3LCliListRow;
  readonly freshEntry: M3LCliDiscoveryCacheEntry | undefined;
}

/**
 * Resolves a single script candidate's row, reusing a fresh cache entry when
 * available and otherwise loading (and reporting) its parameters.
 */
async function resolveRow(
  candidate: M3LCliScriptCandidate,
  cache: M3LCliDiscoveryCache,
): Promise<M3LCliListRowResolution> {
  try {
    const mtimes = configMtimes(candidate.directory);
    const cached = cache[candidate.name];

    if (cached !== undefined && isCacheEntryFresh(cached, mtimes)) {
      return {
        row: {
          name: candidate.name,
          description: candidate.description,
          parameterCount: cached.parameters.length,
          loadError: null,
        },
        freshEntry: undefined,
      };
    }

    const parameters = await loadScriptParameters(candidate.directory);
    return {
      row: {
        name: candidate.name,
        description: candidate.description,
        parameterCount: parameters.length,
        loadError: null,
      },
      freshEntry: { ...mtimes, parameters },
    };
  } catch (error) {
    // A raw non-M3LCliError failure here (e.g. an EACCES from the
    // configMtimes freshness probe) is wrapped rather than surfaced
    // unwrapped, so every row's loadError is drawn from a typed failure;
    // the wrapped message mirrors the original failure's own text.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const wrapped =
      error instanceof M3LCliError
        ? error
        : new M3LCliError("ERR_CLI_CONFIG_IMPORT", rawMessage, {
            cause: error,
          });
    return {
      row: {
        name: candidate.name,
        description: candidate.description,
        parameterCount: null,
        loadError: wrapped.message,
      },
      freshEntry: undefined,
    };
  }
}

/** Minimum column width for the `NAME` column (its own header length). */
const MIN_NAME_COLUMN_WIDTH = "NAME".length;

/** Minimum column width for the `DESCRIPTION` column (its own header length). */
const MIN_DESCRIPTION_COLUMN_WIDTH = "DESCRIPTION".length;

/** Formats the aligned header + row lines for the human-readable rendering. */
function formatRowLines(rows: readonly M3LCliListRow[]): readonly string[] {
  const nameWidth = Math.max(
    MIN_NAME_COLUMN_WIDTH,
    ...rows.map((row) => row.name.length),
  );
  const descriptionWidth = Math.max(
    MIN_DESCRIPTION_COLUMN_WIDTH,
    ...rows.map((row) => row.description.length),
  );
  const header = `${"NAME".padEnd(nameWidth)}  ${"DESCRIPTION".padEnd(descriptionWidth)}  PARAMETERS`;
  const body = rows.map((row) => {
    const parameters =
      row.loadError !== null
        ? `ERROR: ${row.loadError}`
        : String(row.parameterCount);
    return `${row.name.padEnd(nameWidth)}  ${row.description.padEnd(descriptionWidth)}  ${parameters}`;
  });
  return [header, ...body];
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
  for (const line of formatRowLines(rows)) {
    context.output.info(line);
  }
}

/**
 * Discovers every `scripts/*` package under `context.workspaceRoot` and
 * renders one row per script (name/description/parameter count/load error).
 *
 * Reads through the discovery cache: a script whose cached entry is still
 * fresh (see {@link isCacheEntryFresh}) reuses its cached parameter count
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
  const cache = readDiscoveryCache(context.cacheFilePath);

  const rows: M3LCliListRow[] = [];
  const updates: Record<string, M3LCliDiscoveryCacheEntry> = {};

  for (const candidate of candidates) {
    const { row, freshEntry } = await resolveRow(candidate, cache);
    rows.push(row);
    if (freshEntry !== undefined) {
      updates[candidate.name] = freshEntry;
    }
  }

  if (Object.keys(updates).length > 0) {
    writeDiscoveryCache(context.cacheFilePath, { ...cache, ...updates });
  }

  renderRows(context, rows);
  return 0;
}
