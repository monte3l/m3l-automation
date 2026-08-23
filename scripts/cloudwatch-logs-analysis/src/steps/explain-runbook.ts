import type { Core } from "@m3l-automation/m3l-common";

import { buildAnalysisProcedure } from "./build-procedure.js";
import { loadRunbook, PRESET_EXTENSION } from "./load-runbook.js";

/** Resolves an alarm name to its preset path inside the runbook directory. */
export function presetPathFor(runbookDir: string, alarm: string): string {
  return `${runbookDir}/${alarm}${PRESET_EXTENSION}`;
}

/** What {@link explainRunbook} needs. */
export interface ExplainRunbookDeps {
  readonly reader: Core.M3LInputFileReader;
  readonly logger: Core.M3LLogger;
  readonly runbookDir: string;
  readonly alarm: string;
}

/**
 * Builds one alarm's procedure and prints what it would do: every step in
 * execution order with its kind and jump targets, every case in priority
 * order with its condition, the mandatory fallback, and the definition
 * digest.
 *
 * Offline, like `validate` — nothing here executes a step or reaches AWS.
 * Together the two operations are what keeps the deliberate `caseId: string`
 * tradeoff (ADR-0076) discoverable before an incident instead of during one.
 *
 * @param deps - The input-file reader, logger, preset directory, and alarm name.
 * @returns The built procedure's summary, so a caller can assert on it.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { explainRunbook } from "./explain-runbook.js";
 *
 * const paths = new Core.M3LPaths();
 * const summary = await explainRunbook({
 *   reader: new Core.M3LInputFileReader({ paths, code: "ERR_LOGS_ANALYSIS_PRESET" }),
 *   logger: new Core.M3LLogger([]),
 *   runbookDir: "runbooks",
 *   alarm: "example-alarm",
 * });
 * console.log(summary.name);
 * ```
 */
export async function explainRunbook(
  deps: ExplainRunbookDeps,
): Promise<Core.M3LProcedureSummary> {
  const preset = await loadRunbook(
    deps.reader,
    presetPathFor(deps.runbookDir, deps.alarm),
  );
  const procedure = buildAnalysisProcedure(preset);
  const summary = procedure.describe();

  deps.logger.section(`${summary.name} — ${preset.title}`);
  // Rendered as text, not as a `logger.info` data bag: the default console
  // handler prints the message only, and the digest is the whole point of
  // `explain` — it is what makes two runs comparable.
  deps.logger.text(`digest: ${procedure.digest}`);
  deps.logger.text(
    `${String(summary.steps.length)} step(s), ${String(summary.cases.length)} case(s) + fallback`,
  );

  deps.logger.section("Steps, in execution order");
  for (const step of summary.steps) {
    deps.logger.text(
      `- ${step.id} (${step.kind})${step.jumpsTo.length > 0 ? ` -> ${step.jumpsTo.join(", ")}` : ""}${step.loop !== undefined ? ` [loop x${String(step.loop.maxRevisits)}]` : ""}`,
    );
  }

  deps.logger.section("Cases, in priority order");
  for (const entry of [...summary.cases].sort(
    (a, b) => b.priority - a.priority,
  )) {
    deps.logger.text(
      `- ${String(entry.priority)} ${entry.id}: ${entry.description}`,
    );
  }
  deps.logger.text(`- fallback: ${summary.fallback.description}`);
  return summary;
}
