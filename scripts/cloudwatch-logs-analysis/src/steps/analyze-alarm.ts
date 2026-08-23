import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { buildAnalysisProcedure, INITIAL_VALUES } from "./build-procedure.js";
import { presetPathFor } from "./explain-runbook.js";
import { createLogsInsightsGatherer } from "./gather-logs.js";
import { loadRunbook } from "./load-runbook.js";
import { createEvidence, SAFE_QUERY_VALUE } from "./preset.js";
import { buildReport, logReport } from "./report.js";
import type { AnalysisReport } from "./report.js";
import type { AnalysisDeps, RunbookPreset } from "./preset.js";

/** The error code a run that never reached a verdict fails with. */
export const ANALYZE_CODE = "ERR_LOGS_ANALYSIS_RUN";

/** The per-run overrides config may apply over a preset's authored values. */
export interface RunOverrides {
  readonly leadMinutes: number | undefined;
  readonly lagMinutes: number | undefined;
  readonly severityLadder: readonly string[] | undefined;
}

/**
 * Applies the per-run config overrides over a preset's authored values.
 *
 * An override is applied only when the operator actually supplied one —
 * these parameters carry no default precisely so that "absent" means "the
 * preset decides", rather than silently overwriting every alarm's authored
 * window with a fleet-wide guess.
 *
 * @param preset - The loaded preset.
 * @param overrides - The values config resolved, each possibly absent.
 * @returns The preset with any supplied override applied.
 *
 * @example
 * ```typescript
 * import { applyRunOverrides } from "./analyze-alarm.js";
 * import type { RunbookPreset } from "./preset.js";
 *
 * declare const preset: RunbookPreset;
 * applyRunOverrides(preset, {
 *   leadMinutes: 30,
 *   lagMinutes: undefined,
 *   severityLadder: undefined,
 * });
 * ```
 */
export function applyRunOverrides(
  preset: RunbookPreset,
  overrides: RunOverrides,
): RunbookPreset {
  // A config-supplied rung reaches the same query-substitution boundary a
  // preset-supplied one does, but arrives through the schema's `nonEmpty`
  // validator rather than the preset trust boundary — so it is held to the
  // same allow-list here, or the override would be the one unguarded path
  // into the entry query.
  for (const rung of overrides.severityLadder ?? []) {
    if (!SAFE_QUERY_VALUE.test(rung)) {
      throw new Core.M3LError(
        `severityLadder rung '${rung}' is substituted into the entry query and must contain only word characters, '.', ':', '/', '@', '#', '=', '+' or '-'`,
        { code: ANALYZE_CODE },
      );
    }
  }
  return {
    ...preset,
    window: {
      leadMinutes: overrides.leadMinutes ?? preset.window.leadMinutes,
      lagMinutes: overrides.lagMinutes ?? preset.window.lagMinutes,
    },
    severityLadder: overrides.severityLadder ?? preset.severityLadder,
  };
}

/** What {@link analyzeAlarm} needs. */
export interface AnalyzeAlarmDeps {
  readonly reader: Core.M3LInputFileReader;
  readonly logger: Core.M3LLogger;
  readonly prompt: Core.M3LPrompt;
  readonly client: AWS.M3LLogsInsightsClient;
  readonly runbookDir: string;
  readonly alarm: string;
  readonly triggeredAt: string;
  readonly overrides: RunOverrides;
  readonly maxDepth: number;
  readonly interactive: boolean;
  /** `script.signal` — threaded into every `GetQueryResults` poll (ADR-0049). */
  readonly signal: AbortSignal | undefined;
}

/**
 * The incident-time path: loads the alarm's preset, compiles it into the
 * codified procedure, runs it against CloudWatch Logs Insights, and builds
 * the operator report.
 *
 * @param deps - The reader, logger, prompt, Logs Insights client, preset
 *   location, alarm identity, per-run overrides and cancellation signal.
 * @returns The report for the run, whatever verdict it reached.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_RUN` when the
 *   procedure failed before reaching a verdict — thrown *after* the report
 *   has been logged, so the evidence gathered up to the failure is still in
 *   front of the operator.
 * @throws {@link Core.M3LOperationAbortedError} when `signal` aborted
 *   mid-run, propagated unmodified.
 *
 * @example
 * ```typescript
 * import { analyzeAlarm } from "./analyze-alarm.js";
 *
 * declare const deps: Parameters<typeof analyzeAlarm>[0];
 * const report = await analyzeAlarm(deps);
 * console.log(report.verdict);
 * ```
 */
export async function analyzeAlarm(
  deps: AnalyzeAlarmDeps,
): Promise<AnalysisReport> {
  const preset = applyRunOverrides(
    await loadRunbook(deps.reader, presetPathFor(deps.runbookDir, deps.alarm)),
    deps.overrides,
  );
  const procedure = buildAnalysisProcedure(preset);
  const evidence = createEvidence();

  const runtime: AnalysisDeps = {
    preset,
    gatherer: createLogsInsightsGatherer({
      client: deps.client,
      logger: deps.logger,
    }),
    logger: deps.logger,
    prompt: deps.prompt,
    interactive: deps.interactive,
    maxDepth: deps.maxDepth,
    evidence,
  };

  const outcome = await procedure.run({
    deps: runtime,
    parameters: { alarm: deps.alarm, triggeredAt: deps.triggeredAt },
    initialValues: INITIAL_VALUES,
    ...(deps.signal !== undefined && { signal: deps.signal }),
  });

  const report = buildReport({
    preset,
    outcome,
    evidence,
    triggeredAt: deps.triggeredAt,
  });
  logReport(deps.logger, report);

  if (outcome.status === "aborted") throw outcome.error;
  if (outcome.status === "failed") {
    throw new Core.M3LError(
      `the analysis failed at step '${outcome.failedStep ?? "(guard)"}'`,
      { code: ANALYZE_CODE, cause: outcome.error },
    );
  }
  return report;
}
