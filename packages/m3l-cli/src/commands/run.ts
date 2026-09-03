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
import { executeScript } from "../run/execute.js";
import { recordHistoryEntry } from "../history/store.js";

/**
 * `M3LCliCommandContext` plus the run-history file's absolute path (8f) —
 * `runRun`'s own parameter type, narrower than the shared base so the
 * best-effort history recording below can read `context.historyFilePath`
 * without a cast.
 */
interface M3LCliRunCommandContext extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

/**
 * Best-effort records a run-history entry after a successful spawn — never
 * throws (any failure, including {@link recordHistoryEntry} itself throwing
 * rather than returning `false`, is swallowed) since history recording must
 * never affect the resolved exit code {@link runRun} already has in hand.
 */
function recordRunHistory(
  historyFilePath: string,
  scriptName: string,
  exitCode: number,
): void {
  try {
    recordHistoryEntry(historyFilePath, {
      timestamp: new Date().toISOString(),
      script: scriptName,
      parameterNames: [],
      exitCode,
    });
  } catch {
    /* best-effort: history recording must never affect the resolved exit code */
  }
}

/**
 * Resolves `scriptName` to a discovered `scripts/*` candidate and spawns its
 * compiled `dist/main.js`, forwarding `passthroughArgs` verbatim. Once the
 * spawn resolves, best-effort records a run-history entry (8f) with an empty
 * `parameterNames` — `run` never parses flags, unlike the dynamic per-script
 * dispatch.
 *
 * @param context - The command context to run against; must carry
 *   `historyFilePath`.
 * @param scriptName - The script name to run.
 * @param passthroughArgs - Arguments forwarded verbatim to the spawned
 *   script (everything after the first bare `--` in the original `argv`).
 * @returns The spawned child's resolved exit code, propagated unchanged
 *   (not clamped to any CLI-originated exit-code range).
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   Damerau-Levenshtein `suggestions` over the known script names — when
 *   `scriptName` does not match a discovered script.
 * @throws {@link M3LCliError} coded `ERR_CLI_SCRIPT_NOT_BUILT` or
 *   `ERR_CLI_SPAWN_FAILED` — propagated unchanged from {@link executeScript}.
 *
 * @example
 * ```ts
 * const exitCode = await runRun(context, "json-etl", ["--limit", "5"]);
 * ```
 */
export async function runRun(
  context: M3LCliRunCommandContext,
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

  const { exitCode } = await executeScript(
    context,
    scriptName,
    candidate.directory,
    passthroughArgs,
  );
  recordRunHistory(context.historyFilePath, scriptName, exitCode);
  return exitCode;
}
