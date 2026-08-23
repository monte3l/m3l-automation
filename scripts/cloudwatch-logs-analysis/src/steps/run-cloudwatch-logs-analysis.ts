import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  ANALYSIS_OPERATIONS,
  MAX_DEPTH_DEFAULT,
  RUNBOOK_DIR_DEFAULT,
} from "../config.js";
import type { AnalysisOperation } from "../config.js";
import { analyzeAlarm } from "./analyze-alarm.js";
import { convertRunbook } from "./convert-runbook.js";
import { explainRunbook } from "./explain-runbook.js";
import { PRESET_CODE } from "./load-runbook.js";
import { reportValidation, validateRunbooks } from "./validate-runbooks.js";
import { writeJsonArtifact } from "./write-artifact.js";
import type { AnalysisReport } from "./report.js";
import type { ConversionResult } from "./convert-runbook.js";
import type { ValidationSummary } from "./validate-runbooks.js";

/** The error code every config/guard failure in this script carries. */
export const CONFIG_CODE = "ERR_LOGS_ANALYSIS_CONFIG";

/** The per-operation-optional config values the pipeline resolves once, up front. */
interface RawSettings {
  readonly alarm: string | undefined;
  readonly triggeredAt: string | undefined;
  readonly source: string | undefined;
  readonly output: string | undefined;
  readonly runbookDir: string;
  readonly leadMinutes: number | undefined;
  readonly lagMinutes: number | undefined;
  readonly severityLadder: readonly string[] | undefined;
  readonly maxDepth: number;
  readonly interactive: boolean;
}

/** The full dependency bag the pipeline threads through to every handler. */
export interface RunAnalysisDeps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly correlationId: string;
  /**
   * Provisioned only when `aws.profile` resolved, i.e. in practice only for
   * `analyze`. `validate`, `explain` and `convert` never touch it, which is
   * what keeps them runnable in CI with no credentials.
   */
  readonly client: AWS.M3LLogsInsightsClient | undefined;
  /** `script.signal` — threaded into the Logs Insights poller (ADR-0049). */
  readonly signal: AbortSignal | undefined;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | AnalysisReport
  | ValidationSummary
  | Core.M3LProcedureSummary
  | ConversionResult;

/** Builds a fresh `M3LInputFileReader` over the run's paths, coded for presets. */
function buildReader(deps: RunAnalysisDeps): Core.M3LInputFileReader {
  return new Core.M3LInputFileReader({
    paths: deps.paths,
    code: PRESET_CODE,
  });
}

/**
 * Narrows an already-guarded optional settings field. The pipeline's
 * `requiredFields` phase has enforced presence before any handler runs —
 * this is a type-narrowing safety net, not an expected path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: CONFIG_CODE,
    });
  }
  return value;
}

/** Resolves the raw config values once. Must not re-read `operation`. */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    alarm: accessor.optionalString("alarm"),
    triggeredAt: accessor.optionalString("triggeredAt"),
    source: accessor.optionalString("source"),
    output: accessor.optionalString("output"),
    runbookDir: accessor.optionalString("runbookDir") ?? RUNBOOK_DIR_DEFAULT,
    leadMinutes: accessor.optionalNumber("leadMinutes"),
    lagMinutes: accessor.optionalNumber("lagMinutes"),
    severityLadder: accessor.optionalStringArray("severityLadder"),
    maxDepth: accessor.numberWithDefault("maxDepth", MAX_DEPTH_DEFAULT),
    interactive: accessor.booleanWithDefault("interactive", false),
  };
}

/**
 * Which settings each operation cannot run without, checked by the engine's
 * Guards phase. Duplicates `config.ts`'s cross-parameter validator on
 * purpose: that one fails at config load with an operator-facing message,
 * this one keeps the handler signatures honest if a value ever arrives by
 * another route.
 */
const REQUIRED_FIELDS: Record<
  AnalysisOperation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  analyze: ["alarm", "triggeredAt"],
  validate: [],
  explain: ["alarm"],
  convert: ["source"],
};

/** `analyze`: the incident-time path — the only operation that reaches AWS. */
async function dispatchAnalyze(
  _operation: "analyze",
  settings: RawSettings,
  _context: undefined,
  deps: RunAnalysisDeps,
): Promise<DispatchResult> {
  if (deps.client === undefined) {
    throw new Core.M3LError(
      "'analyze' needs an AWS Logs Insights client; declare 'aws.profile'",
      { code: CONFIG_CODE },
    );
  }
  return analyzeAlarm({
    reader: buildReader(deps),
    logger: deps.logger,
    prompt: deps.prompt,
    client: deps.client,
    runbookDir: settings.runbookDir,
    alarm: requireDefined(settings.alarm, "alarm"),
    triggeredAt: requireDefined(settings.triggeredAt, "triggeredAt"),
    overrides: {
      leadMinutes: settings.leadMinutes,
      lagMinutes: settings.lagMinutes,
      severityLadder: settings.severityLadder,
    },
    maxDepth: settings.maxDepth,
    interactive: settings.interactive,
    signal: deps.signal,
  });
}

/** `validate`: builds every preset offline and fails on any problem. */
async function dispatchValidate(
  _operation: "validate",
  settings: RawSettings,
  _context: undefined,
  deps: RunAnalysisDeps,
): Promise<DispatchResult> {
  const summary = await validateRunbooks({
    paths: deps.paths,
    reader: buildReader(deps),
    logger: deps.logger,
    runbookDir: settings.runbookDir,
  });
  reportValidation(deps.logger, summary);
  return summary;
}

/** `explain`: prints one preset's compiled step graph, cases and digest. */
async function dispatchExplain(
  _operation: "explain",
  settings: RawSettings,
  _context: undefined,
  deps: RunAnalysisDeps,
): Promise<DispatchResult> {
  return explainRunbook({
    reader: buildReader(deps),
    logger: deps.logger,
    runbookDir: settings.runbookDir,
    alarm: requireDefined(settings.alarm, "alarm"),
  });
}

/** `convert`: turns one runbook markdown file into a preset skeleton. */
async function dispatchConvert(
  _operation: "convert",
  settings: RawSettings,
  _context: undefined,
  deps: RunAnalysisDeps,
): Promise<DispatchResult> {
  return convertRunbook({
    reader: buildReader(deps),
    paths: deps.paths,
    logger: deps.logger,
    source: requireDefined(settings.source, "source"),
    alarm: settings.alarm,
    output: settings.output,
  });
}

/**
 * The `cloudwatch-logs-analysis` pipeline: resolve settings, guard the
 * operation's required fields, dispatch, and — for `analyze` only — persist
 * the report. No destructive gate is configured: every operation is
 * read-only against AWS, and the only writes are to `M3L_OUTPUT_DIR`.
 */
const pipeline = new Core.M3LOperationPipeline<
  AnalysisOperation,
  RawSettings,
  RunAnalysisDeps,
  DispatchResult
>({
  operations: ANALYSIS_OPERATIONS,
  configCode: CONFIG_CODE,
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  handlers: {
    analyze: dispatchAnalyze,
    validate: dispatchValidate,
    explain: dispatchExplain,
    convert: dispatchConvert,
  },
  persist: async (result, settings, deps, operation) => {
    // `convert` writes its own skeleton, and `validate`/`explain` produce
    // console output only — `analyze` is the one operation with a report to
    // archive.
    if (operation !== "analyze") return;
    const report = result as AnalysisReport;
    const name =
      settings.output ?? `${report.alarm}-${deps.correlationId}.json`;
    await writeJsonArtifact(deps.paths, name, report);
    deps.logger.info(`report written to '${name}'`);
  },
});

/**
 * Composes `cloudwatch-logs-analysis` end to end via
 * `Core.M3LOperationPipeline`: dispatches `analyze`, `validate`, `explain`
 * or `convert`, and archives the `analyze` report to `M3L_OUTPUT_DIR`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, prompt, correlation
 *   id, the optional Logs Insights client, and `script.signal`.
 * @returns A promise that resolves once the operation completes.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_CONFIG` when a
 *   guard-checked per-operation requirement is unmet.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_VALIDATION` when
 *   `validate` found a problem in any preset.
 *
 * @example
 * ```typescript
 * import { runCloudwatchLogsAnalysis } from "./run-cloudwatch-logs-analysis.js";
 *
 * declare const deps: Parameters<typeof runCloudwatchLogsAnalysis>[0];
 * await runCloudwatchLogsAnalysis(deps);
 * ```
 */
export async function runCloudwatchLogsAnalysis(
  deps: RunAnalysisDeps,
): Promise<void> {
  const outcome = await pipeline.run(deps);
  deps.logger.step(
    `cloudwatch-logs-analysis run ${deps.correlationId} complete`,
    {
      operation: outcome.operation,
    },
  );
}
