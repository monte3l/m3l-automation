import type { Core } from "@m3l-automation/m3l-common";

/**
 * The closed verdict vocabulary `cloudwatch-logs-analysis` concludes with.
 *
 * Five verdicts are authored per known-case row in a preset
 * (`known-no-action`, `known-open-issue`, `known-closed-issue`,
 * `transient-downstream`, `unrecognised`); the remaining three are reached
 * only through the codified terminal cases and are rejected in a preset's
 * `cases[].verdict` by {@link parseRunbookPreset}'s trust-boundary check, so
 * an author cannot claim "no evidence" for a row that only matches when
 * evidence exists.
 */
export const ANALYSIS_VERDICTS = [
  "known-no-action",
  "known-open-issue",
  "known-closed-issue",
  "transient-downstream",
  "no-correlation-id",
  "no-evidence",
  "unsupported",
  "unrecognised",
] as const;

/** One member of {@link ANALYSIS_VERDICTS}. */
export type AnalysisVerdict = (typeof ANALYSIS_VERDICTS)[number];

/**
 * The subset of {@link ANALYSIS_VERDICTS} a preset's own known-case rows may
 * declare. The three terminal verdicts are reserved for the codified cases
 * in `build-procedure.ts`.
 */
export const AUTHORABLE_VERDICTS = [
  "known-no-action",
  "known-open-issue",
  "known-closed-issue",
  "transient-downstream",
  "unrecognised",
] as const satisfies readonly AnalysisVerdict[];

/**
 * Priorities `1`–`RESERVED_PRIORITY_CEILING` belong to the codified terminal
 * cases (`unsupported`, `no-correlation-id`, `no-evidence`). A preset row
 * claiming one of them is rejected at the trust boundary rather than
 * colliding as an `ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY` at build time,
 * because the message an operator reads should name the preset field, not
 * the engine's internal case table.
 */
export const RESERVED_PRIORITY_CEILING = 9;

/** One normalized Logs Insights result row: field name to field value. */
export type AnalysisRow = Readonly<Record<string, string>>;

/** A Logs Insights query a preset stage declares, with its target log groups. */
export interface RunbookQueryStage {
  /** The log groups the stage queries. Non-empty; AWS caps the array at 50. */
  readonly logGroups: readonly string[];
  /** The Logs Insights query string, passed verbatim to `StartQuery`. */
  readonly query: string;
  /** Row cap for this stage's query; `undefined` leaves the AWS default. */
  readonly limit: number | undefined;
}

/**
 * The optional authorizer hop: queried only when the entry evidence reports
 * an authorizer latency above {@link RunbookAuthorizerStage.latencyThresholdMs}.
 */
export interface RunbookAuthorizerStage extends RunbookQueryStage {
  /** The entry-row field carrying the observed authorizer latency, in ms. */
  readonly latencyField: string;
  /** Above this observed latency (ms), the hop runs. */
  readonly latencyThresholdMs: number;
}

/** One rung of the optional trace chain, queried by the extracted correlation key. */
export interface RunbookTraceLevel extends RunbookQueryStage {
  /** Operator-facing name for this hop, e.g. `"downstream-worker"`. */
  readonly label: string;
  /**
   * A capture-group pattern that reads a **rewritten** key out of this hop's
   * rows, which the next hop then queries by. `undefined` carries the
   * incoming key forward unchanged.
   */
  readonly rekeyPattern: string | undefined;
}

/** How the correlation key is pulled out of the entry evidence. */
export interface RunbookCorrelation {
  /** The row field the pattern is applied to, e.g. `"@message"`. */
  readonly field: string;
  /** A pattern whose first capture group is the key. */
  readonly pattern: string;
  /** Operator-facing name for the key, e.g. `"correlation id"`. */
  readonly label: string;
}

/** How the value the known cases match on is derived from the evidence. */
export interface RunbookSignature {
  /** The row field the signature is read from. */
  readonly field: string;
  /**
   * A capture-group pattern narrowing the field to the signature. When
   * `undefined`, the whole field value is the signature.
   */
  readonly pattern: string | undefined;
  /** The row field carrying the severity level a case row may pin. */
  readonly levelField: string | undefined;
  /** The row field carrying the emitting service a case row may pin. */
  readonly serviceField: string | undefined;
}

/** One row of a preset's known-cases table. */
export interface RunbookCase {
  /** Unique within the preset; becomes the procedure's `caseId`. */
  readonly id: string;
  /** What this row means, for a maintainer. */
  readonly description: string;
  /** Operator-facing prose — what a human reads when this row wins. */
  readonly prose: string;
  /**
   * Unique within the preset and above {@link RESERVED_PRIORITY_CEILING};
   * higher wins. Encodes specificity, so a narrow row beats a broad one
   * regardless of authoring order.
   */
  readonly priority: number;
  /** Matched against the derived error signature. */
  readonly pattern: string;
  /** When set, the row also requires this severity level. */
  readonly level: string | undefined;
  /** When set, the row also requires this emitting service. */
  readonly service: string | undefined;
  /** The verdict this row concludes; one of {@link AUTHORABLE_VERDICTS}. */
  readonly verdict: AnalysisVerdict;
  /** The runbook's ticket reference for this known error, when it has one. */
  readonly ticket: string | undefined;
  /** The runbook's recorded resolution for this known error. */
  readonly resolution: string | undefined;
  /** Who to escalate to; `undefined` falls back to the preset's owner. */
  readonly escalateTo: string | undefined;
  /** Checks the runbook prescribes that this script does not execute. */
  readonly followUps: readonly string[];
}

/** The analysis window, expressed as an offset around the alarm trigger time. */
export interface RunbookWindow {
  /** Minutes of history before `triggeredAt` to include. */
  readonly leadMinutes: number;
  /** Minutes after `triggeredAt` to include. */
  readonly lagMinutes: number;
}

/** Why an alarm is out of scope, and what the operator must do by hand instead. */
export interface RunbookUnsupported {
  /** Why the evidence for this alarm is not in a log group at all. */
  readonly reason: string;
  /** The manual steps the runbook prescribes, surfaced as follow-ups. */
  readonly manualSteps: readonly string[];
}

/**
 * One alarm's analysis preset: everything that varies between alarms, as
 * data. The step graph itself is codified in `build-procedure.ts` and is
 * identical for every preset — only which optional stages are declared
 * changes (ADR-0076).
 *
 * @remarks
 * A preset with {@link RunbookPreset.unsupported} set declares that the
 * alarm's evidence does not live in a log group; `entry`, `correlation` and
 * `signature` are then all absent and the procedure short-circuits to the
 * codified `unsupported` case. Every other preset must carry `entry` and
 * `signature` — enforced by {@link parseRunbookPreset}, not by this type,
 * because the JSON reaching that function is untrusted.
 */
export interface RunbookPreset {
  /** The CloudWatch alarm name this preset analyses. Matches the file stem. */
  readonly alarm: string;
  /** A one-line operator-facing title for the alarm. */
  readonly title: string;
  /** Set when the alarm is out of scope; absent for an analysable alarm. */
  readonly unsupported: RunbookUnsupported | undefined;
  /** The aggregate query over the alarm's own log groups. */
  readonly entry: RunbookQueryStage | undefined;
  /** The severity rungs retried, in order, when the entry query finds nothing. */
  readonly severityLadder: readonly string[];
  /**
   * A `printf`-style `%s` slot in the entry query that each ladder rung is
   * substituted into. `undefined` runs the entry query unchanged and makes
   * the ladder inert.
   */
  readonly severityPlaceholder: string | undefined;
  /** The window offsets around the alarm trigger time. */
  readonly window: RunbookWindow;
  /** The optional authorizer hop. */
  readonly authorizer: RunbookAuthorizerStage | undefined;
  /** How the correlation key is extracted; absent only when unsupported. */
  readonly correlation: RunbookCorrelation | undefined;
  /** The optional trace chain, innermost hop last. Empty disables the stage. */
  readonly trace: readonly RunbookTraceLevel[];
  /** How the matched-on error signature is derived; absent only when unsupported. */
  readonly signature: RunbookSignature | undefined;
  /** The known-cases table. May be empty — every alarm still has a fallback. */
  readonly cases: readonly RunbookCase[];
  /** The team an unrecognised error escalates to. */
  readonly escalateTo: string;
  /** Follow-up checks that apply to every verdict for this alarm. */
  readonly followUps: readonly string[];
  /**
   * Unresolved markers left by `convert`. A non-empty list fails `validate`
   * — a partially converted runbook must not silently produce a confident
   * wrong verdict.
   */
  readonly todos: readonly string[];
}

/** One trace hop's gathered rows, kept in hop order. */
export interface AnalysisTraceHop {
  readonly label: string;
  readonly rows: readonly AnalysisRow[];
}

/**
 * The evidence a run accumulates. Held on `deps` — which the engine treats as
 * opaque: never traced, never hashed, never part of the outcome — so gathered
 * log rows stay out of the trace and the definition digest while the
 * procedure's `values` carry only derived scalars.
 *
 * Every field is read-only and every mutation goes through a named method:
 * a step receives its context frozen and must never assign through it, so
 * "record what this stage gathered" is an operation the collector owns rather
 * than a property a step reaches in and overwrites.
 */
export interface AnalysisEvidence {
  /** Rows the entry query returned, at the rung that finally matched. */
  readonly entryRows: readonly AnalysisRow[];
  /** Rows the authorizer hop returned; empty when the hop did not run. */
  readonly authorizerRows: readonly AnalysisRow[];
  /** Rows each trace hop returned, in hop order. */
  readonly traceRows: readonly AnalysisTraceHop[];
  /** The severity rung the entry evidence was finally found at. */
  readonly matchedRung: string | undefined;
  /** Records what the entry query returned, and at which rung. */
  recordEntry(rows: readonly AnalysisRow[], rung: string | undefined): void;
  /** Records what the authorizer hop returned. */
  recordAuthorizer(rows: readonly AnalysisRow[]): void;
  /** Appends one trace hop's rows to the chain. */
  recordTraceHop(label: string, rows: readonly AnalysisRow[]): void;
}

/**
 * Creates an empty {@link AnalysisEvidence} collector for one run.
 *
 * @returns A collector whose stages are all empty.
 *
 * @example
 * ```typescript
 * import { createEvidence } from "./preset.js";
 *
 * const evidence = createEvidence();
 * evidence.recordEntry([{ "@message": "boom" }], "ERROR");
 * console.log(evidence.entryRows.length); // 1
 * ```
 */
export function createEvidence(): AnalysisEvidence {
  let entryRows: readonly AnalysisRow[] = [];
  let authorizerRows: readonly AnalysisRow[] = [];
  let traceRows: readonly AnalysisTraceHop[] = [];
  let matchedRung: string | undefined;
  return {
    get entryRows() {
      return entryRows;
    },
    get authorizerRows() {
      return authorizerRows;
    },
    get traceRows() {
      return traceRows;
    },
    get matchedRung() {
      return matchedRung;
    },
    recordEntry(rows, rung) {
      entryRows = rows;
      matchedRung = rung;
    },
    recordAuthorizer(rows) {
      authorizerRows = rows;
    },
    recordTraceHop(label, rows) {
      traceRows = [...traceRows, { label, rows }];
    },
  };
}

/** One Logs Insights query the procedure asks its injected gatherer to run. */
export interface AnalysisQueryRequest {
  readonly logGroups: readonly string[];
  readonly query: string;
  /** Inclusive range start, epoch **seconds**. */
  readonly startTime: number;
  /** Inclusive range end, epoch **seconds**. */
  readonly endTime: number;
  readonly limit: number | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * The log-query seam the procedure's `gather` steps run through. Narrow by
 * design: a unit test supplies a fake implementation and exercises the whole
 * step graph with no AWS client and no network.
 */
export interface AnalysisGatherer {
  query(request: AnalysisQueryRequest): Promise<readonly AnalysisRow[]>;
}

/** What `cloudwatch-logs-analysis` concludes, for one alarm, in one run. */
export interface AnalysisConclusion {
  readonly verdict: AnalysisVerdict;
  /** The winning case's id, or `undefined` when the fallback concluded. */
  readonly caseId: string | undefined;
  /** The operator-facing prose the winning case (or the fallback) carries. */
  readonly prose: string;
  readonly ticket: string | undefined;
  readonly resolution: string | undefined;
  readonly escalateTo: string | undefined;
  /** Checks the runbook prescribes that this script deliberately did not run. */
  readonly followUps: readonly string[];
}

/** The dependency bag the procedure's steps read. Opaque to the engine. */
export interface AnalysisDeps {
  readonly preset: RunbookPreset;
  readonly gatherer: AnalysisGatherer;
  readonly logger: Core.M3LLogger;
  readonly prompt: Core.M3LPrompt;
  /** Whether `decide-trace-depth` may ask the operator. */
  readonly interactive: boolean;
  /** The configured ceiling on trace depth, capping the preset's own. */
  readonly maxDepth: number;
  readonly evidence: AnalysisEvidence;
}

/**
 * The declared shape of the alarm-analysis procedure. `stepId` is a closed
 * literal union so the step graph, every `jumpsTo` target, and build-time
 * cycle detection stay compile-checked; `caseId` is deliberately `string`
 * so `.case()` can be called in a loop over a preset's known-case rows
 * (ADR-0076).
 */
export interface AnalysisShape extends Core.M3LProcedureShape {
  deps: AnalysisDeps;
  values: {
    /** Inclusive window start, epoch seconds. */
    windowStart: number;
    /** Inclusive window end, epoch seconds. */
    windowEnd: number;
    /** Index into `preset.severityLadder` of the rung currently being tried. */
    ladderRung: number;
    /** Rows the entry query returned at the current rung. */
    entryRowCount: number;
    /** Set only when the alarm is declared out of scope. */
    unsupported: boolean;
    /** The extracted correlation key. Absent when extraction found none. */
    correlationKey: string;
    /** Trace hops actually walked. */
    traceDepth: number;
    /** The value the known cases match on. */
    errorSignature: string;
    /** The severity level a case row may additionally pin. */
    matchedLevel: string;
    /** The emitting service a case row may additionally pin. */
    matchedService: string;
  };
  parameters: { alarm: string; triggeredAt: string };
  conclusion: AnalysisConclusion;
  stepId:
    | "resolve-window"
    | "widen-severity"
    | "gather-entry"
    | "check-entry-evidence"
    | "gather-authorizer"
    | "extract-correlation"
    | "decide-trace-depth"
    | "gather-trace-level"
    | "extract-error-signature"
    | "match-known-cases";
  caseId: string;
}
