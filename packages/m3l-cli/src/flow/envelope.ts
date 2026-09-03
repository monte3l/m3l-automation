/**
 * `flow/envelope` — the `m3l flow run <name> --json` result envelope: the
 * run's own verdict, plus one NESTED `m3l.run.result` envelope per step
 * execution.
 *
 * The nesting is composition, not re-implementation. Every per-step field a
 * consumer reads — the ISO window, `durationMs`, `exitCodeName`, the
 * report-derived scalars — is produced by `run/envelope.ts`'s
 * {@link buildRunEnvelope}, called once per execution with THAT execution's
 * own observed values. This module therefore owns no reverse exit-code map and
 * no run-report read guards: duplicating either would let the two JSON
 * surfaces drift, and `m3l run --json` is the one that defines their shape.
 *
 * `exitCodeName` is likewise COPIED from the last nested envelope rather than
 * looked up here. A run with zero executions honestly has no name to report,
 * and a local fallback lookup would invent one for a code no step ever
 * produced (a guard trip's `CONFIG_USAGE`, for instance) — which is exactly
 * why a `loop-guard-exceeded` run ALWAYS reports `exitCodeName: null`, even
 * when steps did execute: the guard's forced `CONFIG_USAGE` is the engine's
 * own verdict, not the last step's, and copying that step's name would
 * misattribute a code it never produced.
 *
 * @packageDocumentation
 */

import { buildRunEnvelope } from "../run/envelope.js";
import type {
  M3LCliExitCodeName,
  M3LCliRunEnvelope,
  M3LCliRunReportLookup,
} from "../run/envelope.js";
import type { M3LCliFlowRunResult } from "./run.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowRunStatus,
  M3LCliFlowStepOutcome,
} from "./types.js";

/**
 * One step execution's entry in the flow envelope: which step ran, on which
 * attempt, where its outcome led — and the full `m3l run --json` envelope for
 * that single execution.
 *
 * The flow-level identity fields are spelled here rather than folded into
 * `run`: a flow revisits a step id, so `stepId` + `attempt` is what
 * disambiguates two executions of the same script, and neither is anything
 * `run/envelope.ts` knows about.
 *
 * @example
 * ```ts
 * function isRetry(entry: M3LCliFlowStepEnvelope): boolean {
 *   return entry.attempt > 1;
 * }
 * ```
 */
export interface M3LCliFlowStepEnvelope {
  /** The executed step's id. */
  readonly stepId: string;
  /** The script that step ran. */
  readonly script: string;
  /** Which attempt of this step id this was, 1-based. */
  readonly attempt: number;
  /** The branch this execution's outcome selected. */
  readonly branch: M3LCliFlowBranch;
  /** The composed per-execution run envelope, verbatim. */
  readonly run: M3LCliRunEnvelope;
}

/**
 * The `m3l flow run <name> --json` result envelope: allowlisted scalars and
 * the nested per-execution envelopes, emitted as a single line of JSON.
 *
 * `durationMs` is deliberately NOT clamped: the run's window is what was
 * observed, and a non-monotonic clock reporting a negative span is a fact a
 * consumer should see rather than one this envelope should hide.
 *
 * @example
 * ```ts
 * function isResumable(envelope: M3LCliFlowEnvelope): boolean {
 *   return envelope.resumeStepId !== null;
 * }
 * ```
 */
export interface M3LCliFlowEnvelope {
  /** The envelope's discriminant; always `"m3l.flow.result"`. */
  readonly kind: "m3l.flow.result";
  /** The envelope schema's version; always `1` in U10. */
  readonly schemaVersion: 1;
  /** The flow that ran. */
  readonly flow: string;
  /** The run's own id, shared with its persisted record. */
  readonly runId: string;
  /** The definition hash the record was built with — reused, never recomputed. */
  readonly definitionHash: string;
  /** When the run was observed to start, ISO-8601. */
  readonly startedAt: string;
  /** When the run was observed to finish, ISO-8601. */
  readonly finishedAt: string;
  /** The run's observed span in milliseconds, unclamped. */
  readonly durationMs: number;
  /** How the run ended. */
  readonly status: M3LCliFlowRunStatus;
  /** The run's resolved exit code, verbatim. */
  readonly exitCode: number;
  /** The deciding step's registered exit-code name, or `null` when there is none. */
  readonly exitCodeName: M3LCliExitCodeName | null;
  /** Whether the run was a dry run. */
  readonly dryRun: boolean;
  /** Cumulative step executions across this run AND every earlier run of it. */
  readonly stepExecutionCount: number;
  /** The step the run ended at, or `null`. */
  readonly haltingStepId: string | null;
  /** Where a follow-up run should resume, or `null`. */
  readonly resumeStepId: string | null;
  /** One entry per step execution of THIS run, in order. */
  readonly steps: readonly M3LCliFlowStepEnvelope[];
}

/**
 * What {@link buildFlowEnvelope} needs beyond the run result itself: the run's
 * id, the hash of the definition that produced it, and whether it was a dry
 * run.
 *
 * There is no parallel per-step array here on purpose. Everything a nested
 * envelope needs already lives on `result.stepExecutions`, and a second array
 * of the same executions could only ever drift out of step with the first.
 *
 * @example
 * ```ts
 * const input: M3LCliFlowEnvelopeInput = {
 *   runId,
 *   definitionHash: record.definitionHash,
 *   dryRun: false,
 *   result,
 * };
 * ```
 */
export interface M3LCliFlowEnvelopeInput {
  /** The run's own id. */
  readonly runId: string;
  /** The definition hash, taken from the built record rather than recomputed. */
  readonly definitionHash: string;
  /** Whether the run was a dry run. */
  readonly dryRun: boolean;
  /** What `flow/run` reported. */
  readonly result: M3LCliFlowRunResult;
}

/**
 * The reason a step with no located report is reported under when it observed
 * no more specific one — the only reason this module may synthesize.
 */
const DEFAULT_REPORT_UNAVAILABLE_REASON = "no-matching-report";

/**
 * Rebuilds the {@link M3LCliRunReportLookup} that `flow/step` originally
 * resolved, so {@link buildRunEnvelope} can derive the report fields itself
 * instead of this module second-guessing them.
 *
 * `reportPath` is the discriminator, not `reportUnavailable`: a step that DID
 * locate a report is `"found"` even if a stale reason rode along, because
 * demoting it would throw away a path the operator can actually open.
 *
 * The four timeline/recovery scalars are always `null`. The outcome carries
 * the report's verdict and path but not its counts, and inventing a count is
 * strictly worse than admitting the envelope no longer has it — the same
 * discipline `run/envelope.ts` applies to a malformed report.
 *
 * @param outcome - One executed step as the loop observed it.
 * @returns The reconstructed lookup for that execution.
 */
function reconstructLookup(
  outcome: M3LCliFlowStepOutcome,
): M3LCliRunReportLookup {
  if (outcome.reportPath !== null) {
    return {
      status: "found",
      reportPath: outcome.reportPath,
      summary: {
        outcome: outcome.outcome,
        timelineCount: null,
        timelineSourceCount: null,
        recoveryTotal: null,
        retryAttempts: null,
      },
    };
  }
  return {
    status: "unavailable",
    reason: outcome.reportUnavailable ?? DEFAULT_REPORT_UNAVAILABLE_REASON,
  };
}

/**
 * Composes one nested step entry from one observed execution.
 *
 * Field-by-field rather than a spread of `outcome`: a spread would carry the
 * raw `Date`s, the observed unavailable reason, and any hostile extra key on
 * the input straight into the JSON surface, defeating ADR-0063's allowlist.
 *
 * @param outcome - One executed step as the loop observed it.
 * @returns The nested entry, with its own composed run envelope.
 */
function buildStepEnvelope(
  outcome: M3LCliFlowStepOutcome,
): M3LCliFlowStepEnvelope {
  return {
    stepId: outcome.stepId,
    script: outcome.script,
    attempt: outcome.attempt,
    branch:
      typeof outcome.branch === "string"
        ? outcome.branch
        : { goto: outcome.branch.goto },
    run: buildRunEnvelope({
      scriptName: outcome.script,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      exitCode: outcome.exitCode,
      lookup: reconstructLookup(outcome),
    }),
  };
}

/**
 * Assembles the `m3l flow run --json` envelope from a run result.
 *
 * Pure: no I/O, no clock read, no `process` access. Every timestamp comes from
 * the observed windows on the result, and `definitionHash` is the caller's —
 * reusing the record's hash rather than re-hashing the definition, so the
 * envelope and the resume ledger can never disagree about which definition
 * ran.
 *
 * `exitCodeName` is copied from the LAST nested envelope, matching
 * `flow/run`'s own "the last executed step decides" rule. With no executions
 * there is nothing to copy and it is `null`; that is deliberate, since the
 * run's `exitCode` in that case is the engine's own verdict (a guard trip)
 * rather than any step's, and naming it would attribute it to a step that
 * never ran. The same reasoning forces `null` for EVERY `loop-guard-exceeded`
 * run, even one with executions: `flow/run` overrides `exitCode` to the
 * guard's own `CONFIG_USAGE` in that case, so the last step's `exitCodeName`
 * would describe a code that step didn't actually exit with.
 *
 * @param input - The run id, definition hash, dry-run flag and run result.
 * @returns The fully assembled envelope.
 *
 * @example
 * ```ts
 * const envelope = buildFlowEnvelope({
 *   runId,
 *   definitionHash: record.definitionHash,
 *   dryRun: false,
 *   result,
 * });
 * ```
 */
export function buildFlowEnvelope(
  input: M3LCliFlowEnvelopeInput,
): M3LCliFlowEnvelope {
  const { result } = input;
  const steps = result.stepExecutions.map(buildStepEnvelope);
  const deciding = steps.at(-1);

  return {
    kind: "m3l.flow.result",
    schemaVersion: 1,
    flow: result.flowName,
    runId: input.runId,
    definitionHash: input.definitionHash,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
    status: result.status,
    exitCode: result.exitCode,
    exitCodeName:
      result.status === "loop-guard-exceeded"
        ? null
        : (deciding?.run.exitCodeName ?? null),
    dryRun: input.dryRun,
    stepExecutionCount: result.stepExecutionCount,
    haltingStepId: result.haltingStepId,
    resumeStepId: result.resumeStepId,
    steps,
  };
}

/**
 * Serializes an {@link M3LCliFlowEnvelope} as a single line of JSON, with no
 * embedded or trailing newline — the caller (`output.info`) supplies it.
 *
 * @param envelope - The envelope to serialize.
 * @returns The JSON text.
 *
 * @example
 * ```ts
 * output.info(formatFlowEnvelope(envelope));
 * ```
 */
export function formatFlowEnvelope(envelope: M3LCliFlowEnvelope): string {
  return JSON.stringify(envelope);
}
