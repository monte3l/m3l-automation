/**
 * `commands/run` — resolves a script name to its `scripts/*` directory and
 * spawns its compiled `dist/main.js`, propagating the child's exit code
 * verbatim. Unlike `list`/`inspect`, `run` never loads config and never
 * touches the discovery cache.
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import { spawnScript } from "../run/spawn.js";

/**
 * Resolves `scriptName` to a discovered `scripts/*` candidate and spawns its
 * compiled `dist/main.js`, forwarding `passthroughArgs` verbatim.
 *
 * @param context - The command context to run against.
 * @param scriptName - The script name to run.
 * @param passthroughArgs - Arguments forwarded verbatim to the spawned
 *   script (everything after the first bare `--` in the original `argv`).
 * @returns The spawned child's resolved exit code, propagated unchanged
 *   (not clamped to any CLI-originated exit-code range).
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   Damerau-Levenshtein `suggestions` over the known script names — when
 *   `scriptName` does not match a discovered script.
 * @throws {@link M3LCliError} coded `ERR_CLI_SCRIPT_NOT_BUILT` or
 *   `ERR_CLI_SPAWN_FAILED` — propagated unchanged from {@link spawnScript}.
 *
 * @example
 * ```ts
 * const exitCode = await runRun(context, "json-etl", ["--limit", "5"]);
 * ```
 */
export async function runRun(
  context: M3LCliCommandContext,
  scriptName: string,
  passthroughArgs: readonly string[],
): Promise<number> {
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

  return spawnScript(candidate.directory, passthroughArgs);
}
