/**
 * `core/procedure/M3LProcedure` — the immutable, reusable engine produced by
 * {@link M3LProcedureBuilder.build}: a multi-step procedure whose control
 * flow and conclusions are data rather than hand-written branching.
 *
 * @packageDocumentation
 */

import { canonicalJsonHash } from "../json/index.js";
import { serializeErrorChain } from "../diagnostics/index.js";
import {
  createInitialContext,
  deriveContext,
} from "../../internal/procedure/context.js";
import { evaluateCondition } from "../../internal/procedure/evaluate.js";

import type { M3LRunRecoveryEntry } from "../diagnostics/index.js";
import type { M3LProcedureBuiltDefinition } from "../../internal/procedure/definition.js";
import type {
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureConditionScope,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureFlow,
  M3LProcedureOutcome,
  M3LProcedureRunOptions,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureStepRecord,
  M3LProcedureSummary,
  M3LProcedureTelemetry,
} from "./types.js";

/**
 * Narrows an evaluation already filtered on `evaluation.satisfied === true`
 * into a {@link M3LProcedureCaseMatch}. The cast is the same "`boolean & true`
 * collapses" narrowing the public type declares — it is safe only because
 * every call site below constructs `evaluation` and checks `satisfied` in the
 * same pass before calling this.
 */
function toCaseMatch<TShape extends M3LProcedureShape>(
  evaluation: M3LProcedureCaseEvaluation<TShape>,
): M3LProcedureCaseMatch<TShape> {
  return evaluation as M3LProcedureCaseMatch<TShape>;
}

/** One case, paired with the evaluation its `condition` produced this pass. */
interface CaseEvaluationPair<TShape extends M3LProcedureShape> {
  readonly caseEntry: M3LProcedureCase<TShape, TShape["caseId"]>;
  readonly evaluation: M3LProcedureCaseEvaluation<TShape>;
}

/**
 * The result of one full, no-short-circuit pass over every declared case:
 * every evaluation (for `investigated`/telemetry), every match in descending
 * priority (for `alsoMatched`), and the highest-priority matched case's own
 * declaration (so its `action` can be invoked without a second lookup).
 */
interface CasesPass<TShape extends M3LProcedureShape> {
  readonly evaluations: readonly M3LProcedureCaseEvaluation<TShape>[];
  readonly matches: readonly M3LProcedureCaseMatch<TShape>[];
  readonly primaryCase: M3LProcedureCase<TShape, TShape["caseId"]> | undefined;
}

/**
 * What phase 1 accumulated by the time it stopped, regardless of how —
 * `#runPhaseOne` builds this from its own local bindings and returns it
 * (never mutating a shared object other helpers hold), so every downstream
 * assembler (`#conclude`, `#buildFailedOutcome`, `#buildTelemetry`) reads it
 * as plain data.
 */
interface PhaseOneAccumulated<TShape extends M3LProcedureShape> {
  readonly context: M3LProcedureContext<TShape>;
  readonly executedSteps: readonly M3LProcedureStepRecord[];
  readonly resolveChecks: number;
}

/** How phase 1 (the step loop) concluded. */
type PhaseOneOutcome<TShape extends M3LProcedureShape> =
  PhaseOneAccumulated<TShape> &
    (
      | { readonly kind: "ended" }
      | { readonly kind: "matched"; readonly pass: CasesPass<TShape> }
      | {
          readonly kind: "failed";
          readonly stepId: TShape["stepId"];
          readonly error: unknown;
        }
    );

/**
 * How one step execution resolved: the flow directive it returned plus the
 * context/record it produced, or an unabsorbed failure. Pure — the caller
 * folds these into its own local `context`/`executedSteps`, nothing here
 * mutates a parameter.
 */
type StepExecutionOutcome<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "advanced";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
      readonly flow: M3LProcedureFlow<string>;
    }
  | {
      readonly kind: "failed";
      readonly stepId: TShape["stepId"];
      readonly error: unknown;
    };

/** How `#interpretFlow` resolved one step's directive: pure, returning the updated `resolveChecks` rather than mutating a shared counter. */
type FlowDecision<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "advance";
      readonly index: number;
      readonly resolveChecks: number;
    }
  | { readonly kind: "ended"; readonly resolveChecks: number }
  | {
      readonly kind: "matched";
      readonly pass: CasesPass<TShape>;
      readonly resolveChecks: number;
    };

/**
 * A built, validated procedure: "gather evidence, then conclude". Every
 * guarantee this engine makes holds for every instance that exists, because
 * there is deliberately no public constructor and no public definition
 * type — {@link M3LProcedureBuilder.build} is the only way to obtain one.
 *
 * A procedure is inert and reusable: one instance may be `run` repeatedly
 * and concurrently. Everything run-scoped lives in the `run()` call frame;
 * only the digest and the built step/case/fallback tables are instance
 * state, both immutable after `build()`.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: { readonly logs: { query(q: string): Promise<number> } };
 *   values: { errorCount: number };
 *   parameters: Record<never, never>;
 *   conclusion: { readonly verdict: string };
 *   stepId: "count-errors";
 *   caseId: "quiet";
 * }
 *
 * declare const procedure: Core.M3LProcedure<Triage>;
 * declare const logs: Triage["deps"]["logs"];
 *
 * const outcome = await procedure.run({ deps: { logs } });
 *
 * if (outcome.status === "matched") {
 *   console.log(outcome.primary.prose, outcome.digest);
 * }
 * ```
 */
export class M3LProcedure<TShape extends M3LProcedureShape> {
  /** Computed once at build; copied onto every outcome. */
  readonly digest: string;

  readonly #summary: M3LProcedureSummary;
  readonly #steps: readonly M3LProcedureStep<
    TShape,
    TShape["stepId"],
    TShape["stepId"]
  >[];
  /** Sorted once, descending priority — safe because `build()` proved every priority unique. */
  readonly #cases: readonly M3LProcedureCase<TShape, TShape["caseId"]>[];
  readonly #fallback: M3LProcedureFallback<TShape>;
  readonly #stepIndexById: ReadonlyMap<string, number>;

  /**
   * @internal Constructed only by {@link M3LProcedureBuilder.build}. The
   * parameter type lives in `internal/procedure` and is never exported
   * publicly, so no caller outside this package can supply one.
   */
  constructor(definition: M3LProcedureBuiltDefinition<TShape>) {
    this.digest = definition.digest;
    this.#summary = definition.summary;
    this.#steps = definition.steps;
    this.#cases = [...definition.cases].sort((a, b) => b.priority - a.priority);
    this.#fallback = definition.fallback;
    this.#stepIndexById = new Map(
      definition.steps.map((step, index) => [step.id, index]),
    );
  }

  /**
   * Returns the exact serialisable projection `digest` hashes: the
   * procedure name and `revision`, every step's id/label/kind/etc., every
   * case's id/description/prose/priority/condition, the fallback's
   * description/prose, and the declared parameter names.
   *
   * @returns The definition summary.
   */
  describe(): M3LProcedureSummary {
    return this.#summary;
  }

  /**
   * Runs the three-phase contract — steps, cases, conclusion — over
   * `options` and resolves the outcome. `run()` resolves for all four
   * outcome arms (`matched`, `unrecognized`, `failed`, `aborted`); only a
   * contract violation (a malformed run option) throws. A throw from a case
   * action or the fallback action propagates unmodified — it is a caller bug
   * in the conclusion, not a run conclusion — so `run()`'s returned promise
   * rejects in that case rather than resolving a `failed` outcome.
   *
   * @param options - The dependency bag, optional signal, iteration ceiling,
   *   progress guard, tracing, logger, and initial values.
   * @returns The resolved outcome.
   */
  async run(
    options: M3LProcedureRunOptions<TShape>,
  ): Promise<M3LProcedureOutcome<TShape>> {
    const startedAtMs = performance.now();
    const startedAt = new Date().toISOString();

    const initialContext = createInitialContext<TShape>({
      deps: options.deps,
      parameters: options.parameters ?? {},
      initialValues: (options.initialValues ?? {}) as Readonly<
        Partial<TShape["values"]>
      >,
      signal: options.signal,
    });

    const phaseOne = await this.#runPhaseOne(initialContext);

    if (phaseOne.kind === "failed") {
      return this.#buildFailedOutcome(phaseOne, startedAt, startedAtMs);
    }

    const pass =
      phaseOne.kind === "matched"
        ? phaseOne.pass
        : this.#evaluateCases(phaseOne.context);
    const earlyResolved = phaseOne.kind === "matched";

    return this.#conclude(
      phaseOne,
      pass,
      earlyResolved,
      startedAt,
      startedAtMs,
    );
  }

  /**
   * Phase 1: walks the declared steps starting at index 0, interpreting each
   * returned flow directive as {@link https://en.wikipedia.org/wiki/N/A |
   * the contract's Flow directives} section defines. Ends the run early
   * (`"failed"`) on an unabsorbed step throw; concludes early (`"matched"`)
   * on a `"resolve"` pass that matched; otherwise ends ordinarily
   * (`"ended"`) once `"stop"` fires or the last declared step returns
   * `"continue"` — the caller then runs the final, concluding case pass.
   */
  async #runPhaseOne(
    initialContext: M3LProcedureContext<TShape>,
  ): Promise<PhaseOneOutcome<TShape>> {
    let context = initialContext;
    const executedSteps: M3LProcedureStepRecord[] = [];
    let resolveChecks = 0;
    let index = 0;

    for (;;) {
      const step = this.#steps[index];
      // Unreachable for a `build()`-validated procedure: `index` only ever
      // holds 0, `index + 1` bounded by the loop's own check below, or a
      // `goTo` target resolved through `#stepIndexById` (which only ever
      // contains declared step ids). Kept so the loop stays total under
      // `noUncheckedIndexedAccess` rather than asserting the lookup.
      if (step === undefined) {
        return { kind: "ended", context, executedSteps, resolveChecks };
      }

      const executed = await this.#executeOneStep(context, step);
      if (executed.kind === "failed") {
        return { ...executed, context, executedSteps, resolveChecks };
      }

      context = executed.context;
      executedSteps.push(executed.record);

      const isLast = index === this.#steps.length - 1;
      const decision = this.#interpretFlow(
        context,
        executed.flow,
        index,
        isLast,
        resolveChecks,
      );
      resolveChecks = decision.resolveChecks;
      if (decision.kind === "ended") {
        return { kind: "ended", context, executedSteps, resolveChecks };
      }
      if (decision.kind === "matched") {
        return {
          kind: "matched",
          pass: decision.pass,
          context,
          executedSteps,
          resolveChecks,
        };
      }
      index = decision.index;
    }
  }

  /**
   * Interprets one step's flow directive: `{ goTo }` resolves to a declared
   * index; `"stop"` or a `"continue"` from the last step ends phase 1; a
   * matching `"resolve"` concludes the run early; anything else advances to
   * the next declared step. Pure — returns the (possibly incremented)
   * `resolveChecks` rather than mutating a shared counter.
   */
  #interpretFlow(
    context: M3LProcedureContext<TShape>,
    flow: M3LProcedureFlow<string>,
    index: number,
    isLast: boolean,
    resolveChecks: number,
  ): FlowDecision<TShape> {
    if (typeof flow === "object") {
      const target = this.#stepIndexById.get(flow.goTo);
      return { kind: "advance", index: target ?? index + 1, resolveChecks };
    }
    if (flow === "stop") return { kind: "ended", resolveChecks };

    let checks = resolveChecks;
    if (flow === "resolve") {
      checks += 1;
      const pass = this.#evaluateCases(context);
      if (pass.matches.length > 0) {
        return { kind: "matched", pass, resolveChecks: checks };
      }
    }
    if (isLast) return { kind: "ended", resolveChecks: checks };
    return { kind: "advance", index: index + 1, resolveChecks: checks };
  }

  /**
   * Executes one step against `context`, returning the derived next context
   * and its record on success (or `continueOnFailure`-absorbed failure) —
   * never mutating `context` itself. An unabsorbed throw is reported, not
   * folded — no context transition and no step record, matching
   * {@link M3LProcedureStepRecord}'s two statuses (`"succeeded"` /
   * `"recovered"`), neither of which describes a hard failure.
   */
  async #executeOneStep(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  ): Promise<StepExecutionOutcome<TShape>> {
    const attempt = (context.results[step.id]?.attempt ?? 0) + 1;
    const start = performance.now();
    try {
      const result = await step.execute(context);
      const record = this.#buildRecord(
        step,
        attempt,
        "succeeded",
        result.output,
        result.note,
        performance.now() - start,
      );
      const nextContext = deriveContext(context, {
        stepId: step.id,
        record,
        ...(result.values !== undefined ? { values: result.values } : {}),
      });
      return {
        kind: "advanced",
        context: nextContext,
        record,
        flow: result.flow,
      };
    } catch (error) {
      if (step.continueOnFailure !== true) {
        return { kind: "failed", stepId: step.id, error };
      }
      const record = this.#buildRecord(
        step,
        attempt,
        "recovered",
        undefined,
        undefined,
        performance.now() - start,
      );
      const recoveryEntry: M3LRunRecoveryEntry = {
        item: step.id,
        error: serializeErrorChain(error),
        recordedAt: new Date().toISOString(),
      };
      const nextContext = deriveContext(context, {
        stepId: step.id,
        record,
        recoveryEntry,
      });
      return {
        kind: "advanced",
        context: nextContext,
        record,
        flow: "continue",
      };
    }
  }

  #buildRecord(
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    attempt: number,
    status: M3LProcedureStepRecord["status"],
    output: M3LProcedureStepRecord["output"],
    note: M3LProcedureStepRecord["note"],
    durationMs: number,
  ): M3LProcedureStepRecord {
    return {
      id: step.id,
      label: step.label,
      kind: step.kind,
      status,
      attempt,
      output,
      note,
      durationMs,
    };
  }

  /**
   * Phase 2: evaluates every declared case against `context` — no
   * short-circuit, so `alsoMatched`/`investigated` always see the full
   * picture — in descending priority order.
   */
  #evaluateCases(context: M3LProcedureContext<TShape>): CasesPass<TShape> {
    const scope: M3LProcedureConditionScope<TShape> = {
      results: context.results,
      values: context.values,
      parameters: context.parameters,
    };

    const pairs: CaseEvaluationPair<TShape>[] = this.#cases.map(
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
      matches: matchedPairs.map((pair) => toCaseMatch(pair.evaluation)),
      primaryCase: matchedPairs[0]?.caseEntry,
    };
  }

  /**
   * Phase 3: runs the primary case's `action` (or the fallback's, when
   * nothing matched) over the concluding context, then assembles the
   * `matched`/`unrecognized` outcome. A throw here propagates unmodified —
   * `run()`'s returned promise rejects rather than folding it into an
   * outcome.
   */
  async #conclude(
    phaseOne: PhaseOneAccumulated<TShape>,
    pass: CasesPass<TShape>,
    earlyResolved: boolean,
    startedAt: string,
    startedAtMs: number,
  ): Promise<M3LProcedureOutcome<TShape>> {
    const telemetry = this.#buildTelemetry(
      phaseOne,
      earlyResolved,
      startedAt,
      startedAtMs,
    );
    const base = {
      digest: this.digest,
      parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
      trace: [],
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

    const conclusion = await this.#fallback.action(
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

  /** Assembles the resolved `failed` outcome for an unabsorbed step throw. */
  #buildFailedOutcome(
    phaseOne: Extract<PhaseOneOutcome<TShape>, { kind: "failed" }>,
    startedAt: string,
    startedAtMs: number,
  ): M3LProcedureOutcome<TShape> {
    return {
      digest: this.digest,
      parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
      trace: [],
      telemetry: this.#buildTelemetry(phaseOne, false, startedAt, startedAtMs),
      status: "failed",
      failedStep: phaseOne.stepId,
      alsoMatched: [],
      error: phaseOne.error,
    };
  }

  /**
   * Assembles this run's {@link M3LProcedureTelemetry}. `stepsSkipped` is
   * the declared-step count minus the number of *distinct* ids that
   * actually appear in `executedSteps` — covering every skip cause (an
   * early `"resolve"`, `"stop"`, or a forward `goTo`) uniformly, since none
   * of them ever add an entry for the steps they bypass.
   */
  #buildTelemetry(
    phaseOne: PhaseOneAccumulated<TShape>,
    earlyResolved: boolean,
    startedAt: string,
    startedAtMs: number,
  ): M3LProcedureTelemetry<TShape> {
    const executedIds = new Set(
      phaseOne.executedSteps.map((record) => record.id),
    );
    const lastStep = phaseOne.executedSteps[phaseOne.executedSteps.length - 1];

    return {
      steps: phaseOne.executedSteps,
      iterations: phaseOne.context.iteration,
      stepsSkipped: this.#steps.length - executedIds.size,
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
}
