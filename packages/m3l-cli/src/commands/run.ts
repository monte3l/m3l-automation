/**
 * `commands/run` — resolves a script name to its `scripts/*` directory and
 * spawns its compiled `dist/main.js`, propagating the child's exit code
 * verbatim. Unlike `list`/`inspect`, `run` never loads config and never
 * touches the discovery cache.
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliOutput } from "../cli/output.js";
import { suggestNames } from "../cli/suggest.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import { executeScript } from "../run/execute.js";
import type { M3LCliRunReportSummary } from "../run/envelope.js";
import { historyOutcomeFields, recordHistoryEntry } from "../history/store.js";

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
 * `summary`'s `outcome`/`retryAttempts` (when present) are spread onto the
 * entry via {@link historyOutcomeFields} rather than re-derived here (U11
 * slice 7b). A construction/write failure is still surfaced via
 * `output.error` (matching `run/execute.ts`'s `fetchRunSummary` precedent) so
 * a vanished history row is at least diagnosable — the diagnostic write
 * itself is wrapped in its own best-effort `try`/`catch` (U11 slice 7b
 * review-fix) so a throwing `output.error` can't escape either. Never called
 * on the happy path or for a `recordHistoryEntry` `false` return (that path
 * stays silent, out of scope this round).
 */
function recordRunHistory(
  output: M3LCliOutput,
  historyFilePath: string,
  scriptName: string,
  exitCode: number,
  summary: M3LCliRunReportSummary | undefined,
): void {
  try {
    recordHistoryEntry(historyFilePath, {
      timestamp: new Date().toISOString(),
      script: scriptName,
      parameterNames: [],
      exitCode,
      ...historyOutcomeFields(summary),
    });
  } catch (cause) {
    try {
      output.error(
        `failed to record run history${cause instanceof Error ? `: ${cause.message}` : ""}`,
      );
    } catch {
      /* the diagnostic write itself is best-effort too — it must never alter the resolved exit code */
    }
  }
}

/**
 * Resolves `scriptName` to a discovered `scripts/*` candidate and spawns its
 * compiled `dist/main.js`, forwarding `passthroughArgs` verbatim, opting into
 * {@link executeScript}'s `resolveReportSummary` so the run's report summary
 * (when one was located) is available for history recording regardless of
 * `context.jsonOutput`. Once the spawn resolves, best-effort records a
 * run-history entry (8f) with an empty `parameterNames` — `run` never parses
 * flags, unlike the dynamic per-script dispatch — plus the summary's
 * `outcome`/`retryAttempts`, when present (U11 slice 7b).
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

  const { exitCode, summary } = await executeScript(
    context,
    scriptName,
    candidate.directory,
    passthroughArgs,
    { resolveReportSummary: true },
  );
  recordRunHistory(
    context.output,
    context.historyFilePath,
    scriptName,
    exitCode,
    summary,
  );
  return exitCode;
}
