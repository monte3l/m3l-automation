/**
 * `commands/history` — renders the recorded run history (`commands/run.ts`/
 * `commands/dynamic.ts` append to it after a spawn resolves), oldest first.
 * The human-readable rendering has six columns: TIME, SCRIPT, PARAMETERS,
 * EXIT, OUTCOME, and ATTEMPTS — the latter two render `"-"` for an entry
 * recorded before this addendum shipped, or for a run whose report couldn't
 * be located.
 *
 * @packageDocumentation
 */

import { formatAlignedTable } from "../cli/table.js";
import type { M3LCliCommandContext } from "./context.js";
import { readHistory } from "../history/store.js";
import type { M3LCliHistoryEntry } from "../history/store.js";

/** The human-readable rendering's column headers. */
const HEADER = [
  "TIME",
  "SCRIPT",
  "PARAMETERS",
  "EXIT",
  "OUTCOME",
  "ATTEMPTS",
] as const;

/** Renders a single history entry's cells for {@link formatAlignedTable}. */
function toTableRow(entry: M3LCliHistoryEntry): readonly string[] {
  return [
    entry.timestamp,
    entry.script,
    entry.parameterNames.length > 0 ? entry.parameterNames.join(",") : "-",
    String(entry.exitCode),
    entry.outcome ?? "-",
    // `??` (not `||`): retryAttempts: 0 is a real measurement ("no retries"),
    // not a missing value, and a falsy-based `||` check would render it "-".
    String(entry.retryAttempts ?? "-"),
  ];
}

/**
 * Renders the recorded run history via `context.output`.
 *
 * Every step here — {@link readHistory} and the `context.output` calls — is
 * synchronous; this function stays `async` anyway (rather than dropping to a
 * plain synchronous `0` return) purely so its call shape matches every
 * sibling command handler (`runInspect`/`runPresets`/etc., all
 * `Promise<M3LCliExitCode>`), which callers (`main.ts`, and every test here)
 * already `await` uniformly. The body itself has no `await` — the
 * `no-await`/`require-await` ESLint pair would otherwise want an `await` for
 * its own sake (the exact manufactured `await Promise.resolve(0)` this
 * revision removes), so the rule is disabled narrowly with this rationale
 * rather than reintroducing that no-op.
 *
 * @param context - The command context to run against; `historyFilePath`
 *   joins the shared {@link M3LCliCommandContext} (8f).
 * @returns `0` always — history is a diagnostic convenience, never a
 *   failure surface.
 *
 * @example
 * ```ts
 * const exitCode = await runHistory(context);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async only for call-shape uniformity with sibling command handlers (see TSDoc); no await belongs in the body
export async function runHistory(context: M3LCliCommandContext): Promise<0> {
  const entries = readHistory(context.historyFilePath);

  if (context.jsonOutput) {
    context.output.info(JSON.stringify(entries));
    return 0;
  }

  context.output.heading("History");
  if (entries.length === 0) {
    context.output.info("no history recorded");
    return 0;
  }
  for (const line of formatAlignedTable(HEADER, entries.map(toTableRow))) {
    context.output.info(line);
  }
  return 0;
}
