/**
 * `internal/procedure/outcome` — phase 2 (case evaluation) and phase 3 (the
 * concluding action), plus the outcome/telemetry assemblers every exit path
 * of `run()` funnels through.
 *
 * `docs/reference/core/procedure.md` § Outcome: `outcome.trace` retains the
 * given `tracer`'s accumulated entries — empty unless `options.trace` was
 * configured for this run.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { canonicalJsonHash } from "../../core/json/index.js";

import { evaluateCondition } from "./evaluate.js";

import type { M3LOperationAbortedError } from "../../core/errors/index.js";
import type {
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
} from "../../core/procedure/build-types.js";
import type {
  M3LProcedureConditionScope,
  M3LProcedureShape,
} from "../../core/procedure/types.js";
import type {
  M3LProcedureOutcome,
  M3LProcedureTelemetry,
} from "../../core/procedure/run-types.js";
import type { M3LProcedureTracer } from "./trace.js";
import type {
  CaseEvaluationPair,
  CasesPass,
  PhaseOneAccumulated,
  PhaseOneOutcome,
  ProcedureRuntime,
} from "./run-state.js";

/**
 * True when `evaluation`'s own condition was satisfied — the runtime witness
 * that narrows a {@link M3LProcedureCaseEvaluation} into a
 * {@link M3LProcedureCaseMatch}. Reading the bit through a type predicate,
 * rather than asserting it with a bare cast, means a future evaluation built
 * without checking `satisfied` first fails to narrow instead of silently
 * forging a match.
 */
function isCaseMatch<TShape extends M3LProcedureShape>(
  evaluation: M3LProcedureCaseEvaluation<TShape>,
): evaluation is M3LProcedureCaseMatch<TShape> {
  return evaluation.evaluation.satisfied;
}

/**
 * Phase 2: evaluates every declared case against `context` — no
 * short-circuit, so `alsoMatched`/`investigated` always see the full picture
 * — in descending priority order.
 */
export function evaluateCases<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
): CasesPass<TShape> {
  const pairs: CaseEvaluationPair<TShape>[] = runtime.cases.map(
    (caseEntry) => ({
      caseEntry,
      evaluation: {
        caseId: caseEntry.id,
        description: caseEntry.description,
        prose: caseEntry.prose,
        priority: caseEntry.priority,
        evaluation: evaluateCondition(caseEntry.condition, scope),
      },
    }),
  );

  const evaluations = pairs.map((pair) => pair.evaluation);
  const matchedPairs = pairs.filter(
    (pair) => pair.evaluation.evaluation.satisfied,
  );

  return {
    evaluations,
    matches: matchedPairs.map((pair) => pair.evaluation).filter(isCaseMatch),
    primaryCase: matchedPairs[0]?.caseEntry,
  };
}

/**
 * Assembles this run's {@link M3LProcedureTelemetry}. `stepsSkipped` is the
 * declared-step count minus the number of *distinct* ids that actually
 * appear in `executedSteps`, minus `failedStepId` when one is given and it
 * hasn't already produced a record — covering every skip cause (an early
 * `"resolve"`, `"stop"`, a forward `goTo`, or a step that genuinely executed
 * and threw unabsorbed) uniformly, and never double-counting a step that
 * clearly did run. `failedStepId` should be passed only for a `"failed"`
 * phase-one outcome that names a specific step (an unabsorbed `execute`
 * throw or a revisit-ceiling trip) — the overall iteration ceiling names no
 * step (`undefined`), so it excludes nothing here.
 */
function buildTelemetry<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  phaseOne: PhaseOneAccumulated<TShape>,
  earlyResolved: boolean,
  startedAt: string,
  startedAtMs: number,
  failedStepId?: TShape["stepId"],
): M3LProcedureTelemetry<TShape> {
  const executedIds = new Set(
    phaseOne.executedSteps.map((record) => record.id),
  );
  const lastStep = phaseOne.executedSteps[phaseOne.executedSteps.length - 1];
  const declaredButNotExecuted = runtime.steps.filter(
    (step) => !executedIds.has(step.id) && step.id !== failedStepId,
  ).length;

  return {
    steps: phaseOne.executedSteps,
    iterations: phaseOne.context.iteration,
    stepsSkipped: declaredButNotExecuted,
    resolveChecks: phaseOne.resolveChecks,
    recovered: phaseOne.context.recovered,
    recoveredTotal: phaseOne.context.recoveredTotal,
    startedAt,
    durationMs: performance.now() - startedAtMs,
    // `M3LProcedureStepRecord.id` is a plain `string` — the public record
    // shape isn't generic over `TShape` — but every id recorded here came
    // from a declared `step.id: TShape["stepId"]`, so the narrow is safe.
    terminatedAt: lastStep?.id,
    earlyResolved,
  };
}

/**
 * Phase 3: runs the primary case's `action` (or the fallback's, when nothing
 * matched) over the concluding context, then assembles the
 * `matched`/`unrecognized` outcome. A throw here propagates unmodified —
 * `run()`'s returned promise rejects rather than folding it into an outcome.
 */
export async function conclude<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: PhaseOneAccumulated<TShape>,
  pass: CasesPass<TShape>,
  earlyResolved: boolean,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): Promise<M3LProcedureOutcome<TShape>> {
  const telemetry = buildTelemetry(
    runtime,
    phaseOne,
    earlyResolved,
    startedAt,
    startedAtMs,
  );
  const base = {
    digest,
    parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
    trace: tracer.entries(),
    telemetry,
  };

  const primaryMatch = pass.matches[0];
  if (primaryMatch !== undefined && pass.primaryCase !== undefined) {
    const conclusion = await pass.primaryCase.action(
      phaseOne.context,
      primaryMatch,
    );
    return {
      ...base,
      status: "matched",
      primary: primaryMatch,
      alsoMatched: pass.matches.slice(1),
      conclusion,
    };
  }

  const conclusion = await runtime.fallback.action(
    phaseOne.context,
    pass.evaluations,
  );
  return {
    ...base,
    status: "unrecognized",
    investigated: pass.evaluations,
    alsoMatched: [],
    conclusion,
  };
}

/** Assembles the resolved `failed` outcome for an unabsorbed step throw or a guard failure. */
export function buildFailedOutcome<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: Extract<PhaseOneOutcome<TShape>, { kind: "failed" }>,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): M3LProcedureOutcome<TShape> {
  return {
    digest,
    parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
    trace: tracer.entries(),
    telemetry: buildTelemetry(
      runtime,
      phaseOne,
      false,
      startedAt,
      startedAtMs,
      phaseOne.stepId,
    ),
    status: "failed",
    failedStep: phaseOne.stepId,
    alsoMatched: [],
    error: phaseOne.error,
  };
}

/** Assembles the resolved `aborted` outcome for a fired `AbortSignal`. */
export function buildAbortedOutcome<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: Extract<PhaseOneOutcome<TShape>, { kind: "aborted" }>,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): M3LProcedureOutcome<TShape> {
  return {
    digest,
    parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
    trace: tracer.entries(),
    telemetry: buildTelemetry(runtime, phaseOne, false, startedAt, startedAtMs),
    status: "aborted",
    abortedAt: phaseOne.abortedAt,
    alsoMatched: [],
    error: phaseOne.error,
  };
}

/**
 * Projects a not-yet-concluded {@link PhaseOneAccumulated} (phase 1 already
 * ended or matched) into the `"aborted"` arm of {@link PhaseOneOutcome}, for
 * the abort boundaries checked between phase 1 and phase 2, and between
 * phase 2 and phase 3 — both report `abortedAt: undefined`, since no further
 * step boundary exists once phase 1 has concluded.
 */
export function toAbortedPhaseOne<TShape extends M3LProcedureShape>(
  phaseOne: PhaseOneAccumulated<TShape>,
  error: M3LOperationAbortedError,
): Extract<PhaseOneOutcome<TShape>, { kind: "aborted" }> {
  return {
    kind: "aborted",
    abortedAt: undefined,
    error,
    context: phaseOne.context,
    executedSteps: phaseOne.executedSteps,
    resolveChecks: phaseOne.resolveChecks,
  };
}
