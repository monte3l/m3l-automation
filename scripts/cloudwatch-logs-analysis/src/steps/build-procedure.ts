import { Core } from "@m3l-automation/m3l-common";

import {
  extractCorrelationKey,
  extractSignature,
  matchPattern,
  maxNumericField,
} from "./correlation.js";
import { SAFE_QUERY_VALUE } from "./preset.js";
import type {
  AnalysisShape,
  RunbookCase,
  RunbookPreset,
  RunbookTraceLevel,
} from "./preset.js";

/** The error code a step raises when the preset it was compiled from is unusable. */
const PROCEDURE_CODE = "ERR_LOGS_ANALYSIS_PROCEDURE";

/**
 * The token a preset's trace-hop query carries where the extracted
 * correlation key is substituted. A hop query without it queries the whole
 * window, which is almost never what the runbook meant — but that is the
 * author's call, so it is not an error.
 */
export const CORRELATION_TOKEN = "{{key}}";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** Priority of the codified `unsupported` terminal case. */
const PRIORITY_UNSUPPORTED = 3;
/** Priority of the codified `no-correlation-id` terminal case. */
const PRIORITY_NO_CORRELATION = 2;
/** Priority of the codified `no-evidence` terminal case. */
const PRIORITY_NO_EVIDENCE = 1;

/** A step's note when the preset simply does not declare its stage. */
const NOTE_NOT_DECLARED = "skipped: stage not declared";

type Step<
  TId extends AnalysisShape["stepId"],
  TJump extends AnalysisShape["stepId"] = never,
> = Core.M3LProcedureStep<AnalysisShape, TId, TJump>;

type Result<TJump extends AnalysisShape["stepId"] = never> =
  Core.M3LProcedureStepResult<AnalysisShape, TJump>;

/** Whether the preset's severity ladder is active — it needs both a placeholder and rungs. */
function ladderActive(preset: RunbookPreset): boolean {
  return (
    preset.severityPlaceholder !== undefined && preset.severityLadder.length > 0
  );
}

/** `maxRevisits` must be a finite integer above zero even when the stage is inert. */
function revisitsFor(count: number): number {
  return Math.max(1, count - 1);
}

/** Substitutes every occurrence of `token` in `query` with `value`. */
function substitute(query: string, token: string, value: string): string {
  return query.split(token).join(value);
}

/**
 * `resolve-window` — derives the epoch-second window from the alarm's
 * trigger time and the preset's offsets, and short-circuits an alarm the
 * preset declares out of scope.
 */
function resolveWindowStep(preset: RunbookPreset): Step<"resolve-window"> {
  return {
    id: "resolve-window",
    label: "Resolve the analysis window",
    kind: "transform",
    execute: (context): Result => {
      const millis = Date.parse(context.parameters.triggeredAt);
      if (Number.isNaN(millis)) {
        throw new Core.M3LError("'triggeredAt' must be an ISO-8601 timestamp", {
          code: PROCEDURE_CODE,
        });
      }
      const trigger = Math.floor(millis / MS_PER_SECOND);
      const values = {
        windowStart: trigger - preset.window.leadMinutes * SECONDS_PER_MINUTE,
        windowEnd: trigger + preset.window.lagMinutes * SECONDS_PER_MINUTE,
      };
      if (preset.unsupported !== undefined) {
        return {
          flow: "stop",
          values: { ...values, unsupported: true },
          note: "stopped: alarm declared out of scope by its preset",
        };
      }
      return { flow: "continue", values };
    },
  };
}

/**
 * `widen-severity` — selects the ladder rung the next entry query runs at.
 * Execution *n* selects rung *n − 1*, so the first pass uses the preset's
 * own rung and each revisit drops one level.
 */
function widenSeverityStep(preset: RunbookPreset): Step<"widen-severity"> {
  return {
    id: "widen-severity",
    label: "Select the severity rung",
    kind: "control",
    execute: (context): Result => {
      if (!ladderActive(preset)) {
        return {
          flow: "continue",
          values: { ladderRung: 0 },
          note: NOTE_NOT_DECLARED,
        };
      }
      const rung = context.results["widen-severity"]?.attempt ?? 0;
      return {
        flow: "continue",
        output: rung,
        values: { ladderRung: rung },
        note: `severity rung ${preset.severityLadder[rung] ?? "(exhausted)"}`,
      };
    },
  };
}

/** `gather-entry` — runs the preset's entry query at the selected rung. */
function gatherEntryStep(preset: RunbookPreset): Step<"gather-entry"> {
  return {
    id: "gather-entry",
    label: "Query the alarm's own log groups",
    kind: "gather",
    execute: async (context): Promise<Result> => {
      const entry = preset.entry;
      if (entry === undefined) {
        throw new Core.M3LError("the preset declares no entry query", {
          code: PROCEDURE_CODE,
        });
      }
      const rung = context.values.ladderRung ?? 0;
      const level = preset.severityLadder[rung];
      const placeholder = preset.severityPlaceholder;
      const query =
        placeholder === undefined || level === undefined
          ? entry.query
          : substitute(entry.query, placeholder, level);
      const rows = await context.deps.gatherer.query({
        logGroups: entry.logGroups,
        query,
        startTime: context.values.windowStart ?? 0,
        endTime: context.values.windowEnd ?? 0,
        limit: entry.limit,
        signal: context.signal,
      });
      context.deps.evidence.recordEntry(rows, level);
      return {
        flow: "continue",
        output: rows.length,
        values: { entryRowCount: rows.length },
      };
    },
  };
}

/**
 * `check-entry-evidence` — the ladder's loop head. Evidence continues the
 * run; no evidence retries one rung lower until the ladder is exhausted,
 * then stops so the codified `no-evidence` case can conclude.
 */
function checkEntryEvidenceStep(
  preset: RunbookPreset,
): Step<"check-entry-evidence", "widen-severity"> {
  return {
    id: "check-entry-evidence",
    label: "Check the entry evidence",
    kind: "check",
    jumpsTo: ["widen-severity"],
    loop: {
      reason: "retry the entry query one severity rung lower",
      maxRevisits: revisitsFor(preset.severityLadder.length),
    },
    execute: (context): Result<"widen-severity"> => {
      if ((context.values.entryRowCount ?? 0) > 0) return { flow: "continue" };
      const rung = context.values.ladderRung ?? 0;
      if (ladderActive(preset) && rung < preset.severityLadder.length - 1) {
        return {
          flow: { goTo: "widen-severity" },
          note: "no rows: widening severity",
        };
      }
      return {
        flow: "stop",
        note: "stopped: no evidence at any severity rung",
      };
    },
  };
}

/**
 * `gather-authorizer` — the optional authorizer hop, run only when the
 * preset declares it *and* the observed latency exceeds its threshold.
 */
function gatherAuthorizerStep(
  preset: RunbookPreset,
): Step<"gather-authorizer"> {
  return {
    id: "gather-authorizer",
    label: "Query the authorizer log groups",
    kind: "gather",
    execute: async (context): Promise<Result> => {
      const stage = preset.authorizer;
      if (stage === undefined) {
        return { flow: "continue", note: NOTE_NOT_DECLARED };
      }
      const observed = maxNumericField(
        context.deps.evidence.entryRows,
        stage.latencyField,
      );
      if (observed === undefined || observed <= stage.latencyThresholdMs) {
        return {
          flow: "continue",
          note: "skipped: authorizer latency within threshold",
        };
      }
      const rows = await context.deps.gatherer.query({
        logGroups: stage.logGroups,
        query: stage.query,
        startTime: context.values.windowStart ?? 0,
        endTime: context.values.windowEnd ?? 0,
        limit: stage.limit,
        signal: context.signal,
      });
      context.deps.evidence.recordAuthorizer(rows);
      return { flow: "continue", output: rows.length };
    },
  };
}

/**
 * `extract-correlation` — pulls the correlation key out of the evidence. No
 * key is a terminal state: the analysis stops rather than guessing.
 */
function extractCorrelationStep(
  preset: RunbookPreset,
): Step<"extract-correlation"> {
  return {
    id: "extract-correlation",
    label: "Extract the correlation key",
    kind: "transform",
    execute: (context): Result => {
      const rule = preset.correlation;
      if (rule === undefined) {
        throw new Core.M3LError("the preset declares no correlation rule", {
          code: PROCEDURE_CODE,
        });
      }
      const evidence = context.deps.evidence;
      const key = extractCorrelationKey(
        [...evidence.entryRows, ...evidence.authorizerRows],
        rule,
      );
      if (key === undefined) {
        return {
          flow: "stop",
          note: `stopped: no ${rule.label} in the evidence`,
        };
      }
      if (!SAFE_QUERY_VALUE.test(key)) {
        return {
          flow: "stop",
          note: `stopped: extracted ${rule.label} is not query-safe`,
        };
      }
      return { flow: "continue", values: { correlationKey: key } };
    },
  };
}

/**
 * `decide-trace-depth` — how far down the chain to follow the key. Asks the
 * operator when the run is interactive; otherwise takes the configured
 * ceiling, capped by what the preset actually declares.
 */
function decideTraceDepthStep(
  preset: RunbookPreset,
): Step<"decide-trace-depth"> {
  return {
    id: "decide-trace-depth",
    label: "Decide the trace depth",
    kind: "decide",
    execute: async (context): Promise<Result> => {
      if (preset.trace.length === 0) {
        return {
          flow: "continue",
          values: { traceDepth: 0 },
          note: NOTE_NOT_DECLARED,
        };
      }
      const available = Math.min(preset.trace.length, context.deps.maxDepth);
      if (!context.deps.interactive) {
        return {
          flow: "continue",
          output: available,
          values: { traceDepth: available },
        };
      }
      const choices = Array.from(
        { length: available + 1 },
        (_unused, index) => index,
      );
      const chosen = await context.deps.prompt.select<number>(
        "How many trace hops should the analysis follow?",
        choices,
        { default: available },
      );
      return {
        flow: "continue",
        output: chosen,
        values: { traceDepth: chosen },
      };
    },
  };
}

/**
 * The hop `gather-trace-level` should run on this execution, or `undefined`
 * when the chain is finished (or was never declared). Split out of the
 * step's own `execute` so neither carries the whole stage's branching.
 */
function selectHop(
  preset: RunbookPreset,
  context: Core.M3LProcedureContext<AnalysisShape>,
):
  | {
      readonly hop: RunbookTraceLevel;
      readonly index: number;
      readonly depth: number;
    }
  | undefined {
  const depth = context.values.traceDepth ?? 0;
  const index = context.results["gather-trace-level"]?.attempt ?? 0;
  const hop = preset.trace[index];
  if (depth === 0 || hop === undefined || index >= depth) return undefined;
  return { hop, index, depth };
}

/**
 * `gather-trace-level` — walks the trace chain one hop per execution,
 * self-jumping until the decided depth is reached. A hop may rewrite the key
 * the next hop queries by.
 */
function gatherTraceLevelStep(
  preset: RunbookPreset,
): Step<"gather-trace-level", "gather-trace-level"> {
  return {
    id: "gather-trace-level",
    label: "Follow the trace chain one hop",
    kind: "gather",
    jumpsTo: ["gather-trace-level"],
    loop: {
      reason: "walk one trace hop per execution down to the decided depth",
      maxRevisits: revisitsFor(preset.trace.length),
    },
    execute: async (context): Promise<Result<"gather-trace-level">> => {
      const selected = selectHop(preset, context);
      if (selected === undefined) {
        const declared = preset.trace.length > 0;
        return {
          flow: "continue",
          note: declared ? "trace chain complete" : NOTE_NOT_DECLARED,
        };
      }
      const { hop, index, depth } = selected;
      const key = context.values.correlationKey ?? "";
      const rows = await context.deps.gatherer.query({
        logGroups: hop.logGroups,
        query: substitute(hop.query, CORRELATION_TOKEN, key),
        startTime: context.values.windowStart ?? 0,
        endTime: context.values.windowEnd ?? 0,
        limit: hop.limit,
        signal: context.signal,
      });
      context.deps.evidence.recordTraceHop(hop.label, rows);
      return {
        flow: index + 1 < depth ? { goTo: "gather-trace-level" } : "continue",
        output: rows.length,
        values: { correlationKey: rekey(hop.rekeyPattern, rows, key) },
        note: `hop ${hop.label}`,
      };
    },
  };
}

/** Reads a rewritten key out of a hop's rows, keeping the incoming one when it cannot. */
function rekey(
  pattern: string | undefined,
  rows: readonly Readonly<Record<string, string>>[],
  current: string,
): string {
  if (pattern === undefined) return current;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const next = matchPattern(value, pattern, "trace.rekeyPattern");
      if (next !== undefined && next.length > 0 && SAFE_QUERY_VALUE.test(next))
        return next;
    }
  }
  return current;
}

/** `extract-error-signature` — derives the value the known cases match on. */
function extractSignatureStep(
  preset: RunbookPreset,
): Step<"extract-error-signature"> {
  return {
    id: "extract-error-signature",
    label: "Extract the error signature",
    kind: "transform",
    execute: (context): Result => {
      const rule = preset.signature;
      if (rule === undefined) {
        throw new Core.M3LError("the preset declares no signature rule", {
          code: PROCEDURE_CODE,
        });
      }
      const evidence = context.deps.evidence;
      // Deepest hop first: the innermost service's error is the one the
      // known-cases table is written against.
      const rows = [
        ...[...evidence.traceRows].reverse().flatMap((hop) => hop.rows),
        ...evidence.authorizerRows,
        ...evidence.entryRows,
      ];
      const extracted = extractSignature(rows, rule);
      if (extracted === undefined) {
        return {
          flow: "continue",
          note: "no error signature derived from the evidence",
        };
      }
      return {
        flow: "continue",
        values: {
          errorSignature: extracted.signature,
          matchedLevel: extracted.level,
          matchedService: extracted.service,
        },
      };
    },
  };
}

/** `match-known-cases` — resolves every case now; the run ends on the first match. */
function matchKnownCasesStep(): Step<"match-known-cases"> {
  return {
    id: "match-known-cases",
    label: "Match the known-cases table",
    kind: "check",
    execute: (): Result => ({ flow: "resolve" }),
  };
}

type Condition = Core.M3LProcedureCondition<AnalysisShape>;

/** Pins a case row to one exact value of a derived scalar. */
function pin(key: "matchedLevel" | "matchedService", value: string): Condition {
  return {
    kind: "compare",
    left: { source: "value", key },
    operator: "==",
    right: { source: "literal", literal: value },
  };
}

/**
 * The condition one known-case row evaluates: the signature pattern, `and`ed
 * with the level and service the row optionally also pins.
 */
function caseCondition(row: RunbookCase): Condition {
  const signature: Condition = {
    kind: "matches",
    subject: { source: "value", key: "errorSignature" },
    pattern: row.pattern,
  };
  const pinned: Condition[] = [];
  if (row.level !== undefined) pinned.push(pin("matchedLevel", row.level));
  if (row.service !== undefined)
    pinned.push(pin("matchedService", row.service));
  if (pinned.length === 0) return signature;
  return { kind: "and", operands: [signature, ...pinned] };
}

/** Compiles one preset known-case row into a procedure case. */
function presetCase(
  preset: RunbookPreset,
  row: RunbookCase,
): Core.M3LProcedureCase<AnalysisShape, string> {
  return {
    id: row.id,
    description: row.description,
    prose: row.prose,
    priority: row.priority,
    condition: caseCondition(row),
    action: () => ({
      verdict: row.verdict,
      caseId: row.id,
      prose: row.prose,
      ticket: row.ticket,
      resolution: row.resolution,
      escalateTo: row.escalateTo ?? preset.escalateTo,
      followUps: [...row.followUps, ...preset.followUps],
    }),
  };
}

/**
 * The codified `unsupported` terminal case. Declared for every preset, not
 * just an out-of-scope one: its condition reads a value only
 * `resolve-window` ever sets, so `describe()` shows the same terminal set
 * for every alarm and `explain` stays comparable across presets.
 */
function unsupportedCase(
  preset: RunbookPreset,
): Core.M3LProcedureCase<AnalysisShape, string> {
  return {
    id: "unsupported",
    description: "the alarm's evidence is not in a log group at all",
    prose:
      preset.unsupported?.reason ??
      "This alarm is out of scope for log analysis.",
    priority: PRIORITY_UNSUPPORTED,
    condition: {
      kind: "compare",
      left: { source: "value", key: "unsupported" },
      operator: "==",
      right: { source: "literal", literal: true },
    },
    action: () => ({
      verdict: "unsupported",
      caseId: "unsupported",
      prose:
        preset.unsupported?.reason ??
        "This alarm is out of scope for log analysis.",
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [
        ...(preset.unsupported?.manualSteps ?? []),
        ...preset.followUps,
      ],
    }),
  };
}

/** The codified `no-correlation-id` terminal case: evidence found, no key in it. */
function noCorrelationCase(
  preset: RunbookPreset,
): Core.M3LProcedureCase<AnalysisShape, string> {
  const label = preset.correlation?.label ?? "correlation key";
  const prose = `Evidence was found, but no ${label} could be extracted from it, so the chain could not be followed. Analyse the entry evidence by hand.`;
  return {
    id: "no-correlation-id",
    description: "entry evidence carried no correlation key",
    prose,
    priority: PRIORITY_NO_CORRELATION,
    condition: {
      kind: "and",
      operands: [
        {
          kind: "compare",
          left: { source: "value", key: "entryRowCount" },
          operator: ">",
          right: { source: "literal", literal: 0 },
        },
        {
          kind: "not",
          operand: {
            kind: "exists",
            subject: { source: "value", key: "correlationKey" },
          },
        },
      ],
    },
    action: () => ({
      verdict: "no-correlation-id",
      caseId: "no-correlation-id",
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
    }),
  };
}

/** The codified `no-evidence` terminal case: nothing matched at any severity rung. */
function noEvidenceCase(
  preset: RunbookPreset,
): Core.M3LProcedureCase<AnalysisShape, string> {
  const prose =
    "No matching log rows were found in the analysis window at any declared severity rung. Widen the window, or confirm the alarm fired against the log groups this preset declares.";
  return {
    id: "no-evidence",
    description: "the entry query returned nothing at every severity rung",
    prose,
    priority: PRIORITY_NO_EVIDENCE,
    condition: {
      kind: "compare",
      left: { source: "value", key: "entryRowCount" },
      operator: "==",
      right: { source: "literal", literal: 0 },
    },
    action: () => ({
      verdict: "no-evidence",
      caseId: "no-evidence",
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
    }),
  };
}

/** The mandatory fallback: an error no known-case row recognises. */
function unrecognisedFallback(
  preset: RunbookPreset,
): Core.M3LProcedureFallback<AnalysisShape> {
  return {
    description: "no known-case row matched the extracted error signature",
    prose: `This error is not in the runbook's known-cases table. Escalate to ${preset.escalateTo} with the evidence below.`,
    action: (_context, investigated) => ({
      verdict: "unrecognised",
      caseId: undefined,
      prose: `This error is not in the runbook's known-cases table (${String(investigated.length)} known cases were checked). Escalate to ${preset.escalateTo} with the evidence below.`,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
    }),
  };
}

/**
 * The values a run starts from. Declared here rather than left absent so the
 * codified terminal cases evaluate against real scalars: `unsupported` and
 * `no-evidence` both compare a value that no step sets on the paths they
 * exist to catch.
 */
export const INITIAL_VALUES: Readonly<Partial<AnalysisShape["values"]>> = {
  entryRowCount: 0,
  ladderRung: 0,
  traceDepth: 0,
  unsupported: false,
};

/**
 * Compiles one preset into an executable, validated `M3LProcedure`. The step
 * graph is codified and identical for every preset (ADR-0076); only which
 * optional stages do real work, and the known-case table, come from the
 * preset.
 *
 * No AWS call, no I/O: `build()` validates the definition and returns. That
 * is what makes the `validate` and `explain` operations runnable offline —
 * a case-id or priority collision an operator would otherwise meet
 * mid-incident surfaces here instead, as a
 * `Core.M3LProcedureValidationProblem`.
 *
 * @param preset - The validated preset to compile.
 * @returns The built, immutable procedure.
 * @throws {@link Core.M3LError} coded `ERR_PROCEDURE_INVALID_DEFINITION`,
 *   carrying every finding in `context.problems`, when the preset's cases
 *   collide on an id or a priority.
 *
 * @example
 * ```typescript
 * import { buildAnalysisProcedure } from "./build-procedure.js";
 * import type { RunbookPreset } from "./preset.js";
 *
 * declare const preset: RunbookPreset;
 * const procedure = buildAnalysisProcedure(preset);
 * console.log(procedure.describe().cases.length);
 * ```
 */
export function buildAnalysisProcedure(
  preset: RunbookPreset,
): Core.M3LProcedure<AnalysisShape> {
  let builder: Core.M3LProcedureBuilder<AnalysisShape, never, string> =
    Core.createProcedureBuilder<AnalysisShape>(
      `cloudwatch-logs-analysis:${preset.alarm}`,
    )
      .parameters(["alarm", "triggeredAt"])
      .step(resolveWindowStep(preset))
      .step(widenSeverityStep(preset))
      .step(gatherEntryStep(preset))
      .step(checkEntryEvidenceStep(preset))
      .step(gatherAuthorizerStep(preset))
      .step(extractCorrelationStep(preset))
      .step(decideTraceDepthStep(preset))
      .step(gatherTraceLevelStep(preset))
      .step(extractSignatureStep(preset))
      .step(matchKnownCasesStep());

  // Declared one assignment at a time rather than chained: `.case()` narrows
  // its pending-cases union by `Exclude<TPending, TId>`, and with `caseId`
  // typed `string` (ADR-0076) the first call collapses that union to `never`.
  // Re-assigning through the annotated `builder` binding restores it, which
  // is exactly what lets the preset's own rows be declared in a loop.
  const cases = [
    ...preset.cases.map((row) => presetCase(preset, row)),
    unsupportedCase(preset),
    noCorrelationCase(preset),
    noEvidenceCase(preset),
  ];
  for (const entry of cases) {
    builder = builder.case(entry);
  }

  // The digest projection cannot see a step's closure, and every stage's log
  // groups, query text and offsets live in one. Folding the preset's own
  // hash into `revision` is what makes two runs comparable only when the
  // preset they ran from is byte-identical.
  return builder.build(unrecognisedFallback(preset), {
    revision: Core.canonicalJsonHash(preset),
  });
}
