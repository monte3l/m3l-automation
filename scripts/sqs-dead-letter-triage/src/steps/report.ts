import { Core } from "@m3l-automation/m3l-common";

import type { TriageVerdict } from "./preset.js";
import type { MessageOutcome, TriageQueueResult } from "./triage-queue.js";

/**
 * Every {@link TriageVerdict} member, duplicated here (rather than derived
 * from a library export) because `preset.ts` exports only
 * `AUTHORABLE_VERDICTS` (the 5 a preset row may declare) — this report
 * needs every verdict, including the 6 reserved for the codified terminal
 * cases, so {@link TriageVerdictCounts} can report a `0` for a verdict a
 * given run never reached rather than omitting its key entirely.
 */
const ALL_VERDICTS = [
  "remove",
  "reinsert",
  "hold",
  "escalate",
  "known-no-action",
  "not-runbook-managed",
  "unparseable",
  "unrouted",
  "no-key",
  "entity-not-found",
  "unrecognised",
] as const satisfies readonly TriageVerdict[];

/**
 * How many characters of a message's raw body reach the persisted report
 * and any log line. The archive artifact `drain-queue.ts` writes is the
 * only place a body is ever kept whole — this bound exists so an operator
 * scrolling a report, or a screen-shared incident channel, never has an
 * arbitrarily large (or sensitive) payload dumped at them.
 */
export const BODY_EXCERPT_LIMIT = 256;

/**
 * The error code an unreachable verdict-tally switch branch carries. Not
 * exported (unlike this script's other step-level `*_CODE` constants) —
 * nothing outside this module needs to assert on it, and an unused export
 * is a knip finding this module has no other reason to carry.
 */
const REPORT_CODE = "ERR_DLQ_TRIAGE_REPORT";

/** One drained message's row in the persisted report. */
interface TriageReportRow {
  readonly messageId: string;
  /** `"(none)"` when the run never reached a conclusion (`failed`/`aborted`). */
  readonly verdict: TriageVerdict | "(none)";
  readonly caseId: string | undefined;
  readonly description: string;
  readonly ticket: string | undefined;
  /** Set when a prohibition downgraded an executable verdict. */
  readonly prohibited: string | undefined;
  readonly followUps: readonly string[];
  /** The first {@link BODY_EXCERPT_LIMIT} characters of the raw body. */
  readonly bodyExcerpt: string;
  /** The body's true length, in characters, before truncation. */
  readonly bodyLength: number;
  readonly status: string;
  readonly failure: string | undefined;
}

/** The machine-readable artifact one `triage` run writes to `M3L_OUTPUT_DIR`. */
export interface TriageReport {
  readonly queue: string;
  readonly title: string;
  readonly queueUrl: string;
  readonly generatedAt: string;
  readonly depth: number;
  readonly drained: number;
  readonly archivePath: string;
  readonly verdictCounts: TriageVerdictCounts;
  readonly rows: readonly TriageReportRow[];
  /** Preset-level follow-ups plus every row's own, deduplicated. */
  readonly followUps: readonly string[];
  readonly escalateTo: string;
}

/**
 * Every {@link TriageVerdict} plus the `"failed"`/`"aborted"` sentinels,
 * each mapped to how many outcomes concluded it. A closed, literal-keyed
 * mapped type rather than a `Record<string, number>` index signature on
 * purpose: every key is always present (defaulting to `0`), so a caller can
 * both dot-access a known verdict (`counts.remove`) and sum every value
 * with no `undefined` to guard against.
 *
 * Keyed off `MessageOutcome.status` rather than `TriageReportRow.verdict`
 * deliberately: both a `"failed"` (unexpected step throw) and an
 * `"aborted"` (operator cancellation) outcome map to the row-level `"(none)"`
 * verdict, and merging them into one tally count would hide a cancelled run
 * among genuine per-message failures in the exact artifact an operator
 * re-reads to answer "how far did we get".
 */
type TriageVerdictCounts = Readonly<
  Record<TriageVerdict | "failed" | "aborted", number>
>;

/** The input {@link buildTriageReport} joins a `TriageQueueResult` against. */
export interface BuildTriageReportInput {
  readonly result: TriageQueueResult;
  readonly queueUrl: string;
  /** The drained messages' raw bodies, joined back to their outcome by `messageId`. */
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string;
  }[];
  readonly escalateTo: string;
  readonly followUps: readonly string[];
  readonly generatedAt: string;
}

/** Projects one message outcome, plus its raw body, onto its report row. */
function buildRow(outcome: MessageOutcome, body: string): TriageReportRow {
  const conclusion = outcome.conclusion;
  return {
    messageId: outcome.messageId,
    verdict: conclusion?.verdict ?? "(none)",
    caseId: conclusion?.caseId,
    description: conclusion?.description ?? "no conclusion reached",
    ticket: conclusion?.ticket,
    prohibited: conclusion?.prohibited,
    followUps: conclusion?.followUps ?? [],
    // This is the ONLY place a body is narrowed — the archive `drain-queue.ts`
    // writes keeps it whole; a report row and any log line only ever need
    // enough of the body to recognise the message, not reprocess it.
    bodyExcerpt: body.slice(0, BODY_EXCERPT_LIMIT),
    bodyLength: body.length,
    status: outcome.status,
    failure: outcome.failure,
  };
}

/**
 * Tallies every outcome's verdict — or its `"failed"`/`"aborted"` status,
 * for the two outcome kinds that never reach a conclusion — for the
 * operator-facing summary. Keyed off {@link MessageOutcome.status} rather
 * than the row's own `"(none)"` verdict; see {@link TriageVerdictCounts}'s
 * TSDoc for why the two must stay distinguishable in the tally.
 */
function countVerdicts(
  outcomes: readonly MessageOutcome[],
): TriageVerdictCounts {
  // Every key seeded to 0 up front — see `TriageVerdictCounts`'s own TSDoc
  // for why a closed, always-fully-populated record is preferable to a
  // sparse index signature here.
  const counts = Object.fromEntries(
    [...ALL_VERDICTS, "failed" as const, "aborted" as const].map((key) => [
      key,
      0,
    ]),
  ) as Record<TriageVerdict | "failed" | "aborted", number>;
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "matched":
      case "unrecognized":
        counts[outcome.conclusion.verdict] += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "aborted":
        counts.aborted += 1;
        break;
      default: {
        const exhaustive: never = outcome;
        throw new Core.M3LError(
          "unreachable message outcome status in verdict tally",
          { code: REPORT_CODE, cause: exhaustive },
        );
      }
    }
  }
  return counts;
}

/** Dedupes the preset-level follow-ups against every row's own, preserving first-seen order. */
function collectFollowUps(
  presetFollowUps: readonly string[],
  rows: readonly TriageReportRow[],
): readonly string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  for (const followUp of [
    ...presetFollowUps,
    ...rows.flatMap((row) => row.followUps),
  ]) {
    if (seen.has(followUp)) continue;
    seen.add(followUp);
    collected.push(followUp);
  }
  return collected;
}

/**
 * Builds the persisted report for one `triage` run: one row per drained
 * message (joining `result.outcomes` back to `messages` by `messageId` for
 * the body excerpt), the verdict tally, and the deduplicated follow-ups.
 *
 * @param input - The queue's `triageQueue` result, its real queue URL, the
 *   drained messages' raw bodies, the preset's `escalateTo`/`followUps`, and
 *   the run's generation timestamp.
 * @returns The report, ready to serialise.
 *
 * @example
 * ```typescript
 * import { buildTriageReport } from "./report.js";
 *
 * declare const input: Parameters<typeof buildTriageReport>[0];
 * const report = buildTriageReport(input);
 * console.log(report.verdictCounts);
 * ```
 */
export function buildTriageReport(input: BuildTriageReportInput): TriageReport {
  const bodyByMessageId = new Map(
    input.messages.map((message) => [message.messageId, message.body]),
  );
  const rows = input.result.outcomes.map((outcome) =>
    buildRow(outcome, bodyByMessageId.get(outcome.messageId) ?? ""),
  );
  return {
    queue: input.result.queue,
    title: input.result.title,
    queueUrl: input.queueUrl,
    generatedAt: input.generatedAt,
    depth: input.result.depth,
    drained: input.result.drained,
    archivePath: input.result.archivePath,
    verdictCounts: countVerdicts(input.result.outcomes),
    rows,
    followUps: collectFollowUps(input.followUps, rows),
    escalateTo: input.escalateTo,
  };
}

/**
 * Writes the operator-facing summary to the logger: per-queue counts, the
 * verdict tally, one line per row, and any follow-up checks this script
 * does not execute.
 *
 * Deliberately never prints `TriageReportRow.bodyExcerpt` — the excerpt
 * exists for the persisted artifact only, and the logger is the surface a
 * PR 2 review flagged as an unintended sink for message content.
 *
 * @param logger - The run's logger.
 * @param report - The report to summarise.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { logTriageReport } from "./report.js";
 *
 * declare const report: import("./report.js").TriageReport;
 * logTriageReport(new Core.M3LLogger([]), report);
 * ```
 */
export function logTriageReport(
  logger: Core.M3LLogger,
  report: TriageReport,
): void {
  logger.section(`${report.queue} — ${report.title}`);
  logger.text(
    `depth=${String(report.depth)} drained=${String(report.drained)} archive=${report.archivePath}`,
  );
  const counts = Object.entries(report.verdictCounts)
    .map(([verdict, count]) => `${verdict}=${String(count)}`)
    .join(" ");
  logger.text(`verdicts: ${counts}`);
  for (const row of report.rows) {
    if (row.failure !== undefined) {
      logger.text(`- ${row.messageId}: ${row.status} — ${row.failure}`);
      continue;
    }
    logger.text(
      `- ${row.messageId}: ${row.verdict}${row.caseId === undefined ? "" : ` (${row.caseId})`}`,
    );
  }
  if (report.followUps.length === 0) return;
  logger.section("Follow-up checks this script does not execute");
  for (const followUp of report.followUps) logger.text(`- ${followUp}`);
}
