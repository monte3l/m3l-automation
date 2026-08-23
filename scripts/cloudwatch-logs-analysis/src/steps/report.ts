import type { Core } from "@m3l-automation/m3l-common";

import type {
  AnalysisConclusion,
  AnalysisEvidence,
  AnalysisRow,
  AnalysisShape,
  AnalysisVerdict,
  RunbookPreset,
} from "./preset.js";

/**
 * How many rows of each evidence stage reach the persisted report. An entry
 * query legitimately returns thousands; the operator reads the first
 * handful, and the rest only inflate the artifact.
 */
export const MAX_REPORTED_ROWS = 50;

/** One evidence stage as it appears in the persisted report. */
export interface ReportedStage {
  readonly label: string;
  /** Rows the stage returned, before {@link MAX_REPORTED_ROWS} truncation. */
  readonly rowCount: number;
  readonly rows: readonly AnalysisRow[];
}

/** One case the run evaluated, and whether it was satisfied. */
export interface ReportedCase {
  readonly caseId: string;
  readonly description: string;
  readonly priority: number;
  readonly satisfied: boolean;
  /** The engine's short rendering of the comparison, when it produced one. */
  readonly detail: string | undefined;
}

/** The machine-readable artifact one `analyze` run writes to `M3L_OUTPUT_DIR`. */
export interface AnalysisReport {
  readonly alarm: string;
  readonly title: string;
  readonly triggeredAt: string;
  readonly status: Core.M3LProcedureOutcome<AnalysisShape>["status"];
  readonly verdict: AnalysisVerdict | undefined;
  readonly caseId: string | undefined;
  readonly prose: string;
  readonly ticket: string | undefined;
  readonly resolution: string | undefined;
  readonly escalateTo: string | undefined;
  readonly severityRung: string | undefined;
  readonly evidence: readonly ReportedStage[];
  /**
   * Every case the run evaluated with its verdict. On an `unrecognized`
   * outcome this is the engine's full `investigated` list; on a `matched`
   * one the engine reports only the winner and the other cases that also
   * matched, so that is what appears here.
   */
  readonly casesChecked: readonly ReportedCase[];
  /** Case ids that also matched but lost on priority. */
  readonly alsoMatched: readonly string[];
  /** Checks the runbook prescribes that this script deliberately did not run. */
  readonly followUps: readonly string[];
  /** Identifies the procedure definition; identical across comparable runs. */
  readonly digest: string;
  /** Identifies this run's inputs. */
  readonly parametersDigest: string;
  readonly iterations: number;
  readonly steps: readonly {
    readonly id: string;
    readonly attempt: number;
    readonly note: string | undefined;
  }[];
}

/** Projects one evaluated case into its report row. */
function reportCase(
  evaluated: Core.M3LProcedureCaseEvaluation<AnalysisShape>,
): ReportedCase {
  return {
    caseId: evaluated.caseId,
    description: evaluated.description,
    priority: evaluated.priority,
    satisfied: evaluated.evaluation.satisfied,
    detail: evaluated.evaluation.detail,
  };
}

/** Collects the evidence stages that actually ran, in gather order. */
function reportEvidence(evidence: AnalysisEvidence): readonly ReportedStage[] {
  const stages: ReportedStage[] = [
    {
      label: "entry",
      rowCount: evidence.entryRows.length,
      rows: evidence.entryRows.slice(0, MAX_REPORTED_ROWS),
    },
  ];
  if (evidence.authorizerRows.length > 0) {
    stages.push({
      label: "authorizer",
      rowCount: evidence.authorizerRows.length,
      rows: evidence.authorizerRows.slice(0, MAX_REPORTED_ROWS),
    });
  }
  for (const hop of evidence.traceRows) {
    stages.push({
      label: hop.label,
      rowCount: hop.rows.length,
      rows: hop.rows.slice(0, MAX_REPORTED_ROWS),
    });
  }
  return stages;
}

/** Reads the conclusion off whichever outcome arm carries one. */
function readConclusion(
  outcome: Core.M3LProcedureOutcome<AnalysisShape>,
): AnalysisConclusion | undefined {
  return outcome.status === "matched" || outcome.status === "unrecognized"
    ? outcome.conclusion
    : undefined;
}

/** Collects the cases the outcome reports, per arm. */
function readCasesChecked(
  outcome: Core.M3LProcedureOutcome<AnalysisShape>,
): readonly ReportedCase[] {
  if (outcome.status === "unrecognized") {
    return outcome.investigated.map(reportCase);
  }
  if (outcome.status === "matched") {
    return [outcome.primary, ...outcome.alsoMatched].map(reportCase);
  }
  return [];
}

/**
 * Builds the persisted report for one `analyze` run: the verdict, the
 * evidence that produced it, the cases the engine checked, and the follow-up
 * checks the runbook prescribes but this script does not execute
 * (ADR-0076 § Scope boundary).
 *
 * @param input - The preset, the run outcome, the accumulated evidence, and
 *   the alarm trigger time the run was parameterised with.
 * @returns The report, ready to serialise.
 *
 * @example
 * ```typescript
 * import { buildReport } from "./report.js";
 * import { createEvidence } from "./preset.js";
 *
 * declare const input: Parameters<typeof buildReport>[0];
 * const report = buildReport(input);
 * console.log(report.verdict);
 * ```
 */
export function buildReport(input: {
  readonly preset: RunbookPreset;
  readonly outcome: Core.M3LProcedureOutcome<AnalysisShape>;
  readonly evidence: AnalysisEvidence;
  readonly triggeredAt: string;
}): AnalysisReport {
  const { preset, outcome, evidence } = input;
  return {
    alarm: preset.alarm,
    title: preset.title,
    triggeredAt: input.triggeredAt,
    status: outcome.status,
    ...readVerdict(preset, outcome),
    severityRung: evidence.matchedRung,
    evidence: reportEvidence(evidence),
    casesChecked: readCasesChecked(outcome),
    alsoMatched:
      outcome.status === "matched"
        ? outcome.alsoMatched.map((match) => match.caseId)
        : [],
    digest: outcome.digest,
    parametersDigest: outcome.parametersDigest,
    iterations: outcome.telemetry.iterations,
    steps: outcome.telemetry.steps.map((step) => ({
      id: step.id,
      attempt: step.attempt,
      note: step.note,
    })),
  };
}

/**
 * The verdict half of the report: whatever the concluding arm produced, or
 * the "never reached a verdict" projection for the `failed`/`aborted` arms.
 */
function readVerdict(
  preset: RunbookPreset,
  outcome: Core.M3LProcedureOutcome<AnalysisShape>,
): Pick<
  AnalysisReport,
  | "verdict"
  | "caseId"
  | "prose"
  | "ticket"
  | "resolution"
  | "escalateTo"
  | "followUps"
> {
  const conclusion = readConclusion(outcome);
  if (conclusion === undefined) {
    return {
      verdict: undefined,
      caseId: undefined,
      prose: describeIncomplete(outcome),
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
    };
  }
  return {
    verdict: conclusion.verdict,
    caseId: conclusion.caseId,
    prose: conclusion.prose,
    ticket: conclusion.ticket,
    resolution: conclusion.resolution,
    escalateTo: conclusion.escalateTo ?? preset.escalateTo,
    followUps: conclusion.followUps,
  };
}

/** Prose for the two arms that never reach a conclusion. */
function describeIncomplete(
  outcome: Core.M3LProcedureOutcome<AnalysisShape>,
): string {
  return outcome.status === "aborted"
    ? "The analysis was cancelled before it reached a verdict."
    : "The analysis failed before it reached a verdict; see the logged error.";
}

/**
 * Writes the operator-facing summary to the logger: the verdict prose, the
 * evidence counts that produced it, the cases the engine rejected, and the
 * follow-up checks left to the human.
 *
 * Row **content** is deliberately not logged — it reaches the persisted
 * report only. The console summary carries counts, case ids and the
 * runbook's own prose, so a screen-shared incident channel does not become
 * an unintended log-content sink.
 *
 * @param logger - The run's logger.
 * @param report - The report to summarise.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { logReport } from "./report.js";
 *
 * declare const report: import("./report.js").AnalysisReport;
 * logReport(new Core.M3LLogger([]), report);
 * ```
 */
export function logReport(
  logger: Core.M3LLogger,
  report: AnalysisReport,
): void {
  logger.section(`${report.alarm} — ${report.verdict ?? report.status}`);
  logger.text(report.prose);
  if (report.ticket !== undefined) logger.info(`ticket: ${report.ticket}`);
  if (report.resolution !== undefined) {
    logger.info(`resolution: ${report.resolution}`);
  }
  // Rendered as text rather than as `logger.info` data bags: the default
  // console handler prints the message only, and these counts and rejections
  // are the operator-facing half of the verdict.
  const counts = report.evidence
    .map((stage) => `${stage.label}=${String(stage.rowCount)}`)
    .join(" ");
  logger.text(
    `evidence: ${counts}${report.severityRung === undefined ? "" : ` (severity ${report.severityRung})`}`,
  );
  for (const checked of report.casesChecked) {
    if (checked.satisfied) continue;
    logger.text(
      `rejected ${checked.caseId} (priority ${String(checked.priority)})${checked.detail === undefined ? "" : `: ${checked.detail}`}`,
    );
  }
  if (report.followUps.length === 0) return;
  logger.section("Follow-up checks this script does not execute");
  for (const followUp of report.followUps) logger.text(`- ${followUp}`);
}
