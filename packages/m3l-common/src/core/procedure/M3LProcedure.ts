/**
 * `core/procedure/M3LProcedure` — the immutable, reusable engine produced by
 * {@link M3LProcedureBuilder.build}: a multi-step procedure whose control
 * flow and conclusions are data rather than hand-written branching.
 *
 * @packageDocumentation
 */

import { canonicalJsonHash } from "../json/index.js";
import { serializeErrorChain } from "../diagnostics/index.js";
import { M3LOperationAbortedError } from "../errors/M3LOperationAbortedError.js";
import {
  createInitialContext,
  deriveContext,
} from "../../internal/procedure/context.js";
import { evaluateCondition } from "../../internal/procedure/evaluate.js";
import {
  M3LProcedureInvalidOptionError,
  M3LProcedureIterationLimitError,
  M3LProcedureNoProgressError,
} from "../../internal/procedure/errors.js";
import {
  createProcedureTracer,
  projectFlowToScalar,
} from "../../internal/procedure/trace.js";
import { M3LPollingInvalidOptionError } from "../../internal/polling/errors.js";
import { ProgressTracker } from "../../internal/polling/progress.js";
import {
  isArray,
  isBigInt,
  isFunction,
  isNumber,
  isPlainObject,
} from "../utils/guards.js";
import { M3L_PROCEDURE_MAX_ITERATIONS } from "./types.js";

import type { M3LRunRecoveryEntry } from "../diagnostics/index.js";
import type { M3LProcedureBuiltDefinition } from "../../internal/procedure/definition.js";
import type {
  M3LProcedureStepTraceClassification,
  M3LProcedureTracer,
} from "../../internal/procedure/trace.js";
import type {
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureConditionScope,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureFlow,
  M3LProcedureOutcome,
  M3LProcedureProgressOptions,
  M3LProcedureProgressWitness,
  M3LProcedureRunOptions,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureStepRecord,
  M3LProcedureStepResult,
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
      | {
          readonly kind: "aborted";
          /** The boundary the abort was observed at; `undefined` once phase 1 has ended. */
          readonly abortedAt: TShape["stepId"] | undefined;
          readonly error: M3LOperationAbortedError;
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
    }
  | {
      readonly kind: "aborted";
      readonly error: M3LOperationAbortedError;
    };

/**
 * A step-boundary guard's failure: shared by every place phase 1 can end a
 * run without a step's own flow directive deciding it — the pre-step guard
 * (`#checkStepBoundary`), a step's own execution outcome folded into a
 * "return now" (`#foldStepExecution`), and the post-advance guard
 * (`#checkAfterAdvance`).
 */
type StepGuardFailure<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "aborted";
      readonly abortedAt: TShape["stepId"] | undefined;
      readonly error: M3LOperationAbortedError;
    }
  | Extract<StepExecutionOutcome<TShape>, { kind: "failed" }>;

/**
 * What `#foldStepExecution` decided for one step's {@link StepExecutionOutcome}:
 * either the loop must return this outcome now (a failure or an abort,
 * neither of which advances phase 1's state), or the step advanced and the
 * caller should fold `context`/`record` into its own local state.
 */
type FoldedStepExecution<TShape extends M3LProcedureShape> =
  | { readonly kind: "return"; readonly result: StepGuardFailure<TShape> }
  | {
      readonly kind: "advanced";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
      readonly flow: M3LProcedureFlow<string>;
    };

/**
 * What `#resolveStepFlow` decided after a step advanced and
 * {@link M3LProcedure.#interpretFlow} classified its directive: either the
 * loop must return this outcome now (an abort, a no-progress trip, an
 * ordinary end, or an early match), or it should keep looping from `index`.
 */
type FlowResolution<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "return";
      readonly result:
        | StepGuardFailure<TShape>
        | { readonly kind: "ended" }
        | { readonly kind: "matched"; readonly pass: CasesPass<TShape> };
    }
  | { readonly kind: "continue"; readonly index: number };

/** The opt-in no-progress guard's `witness`/`maxStalledSteps`, captured by
 * value exactly once from `options.progress` — see {@link captureProgressOptions}. */
interface CapturedProgressConfig<TShape extends M3LProcedureShape> {
  readonly witness: M3LProcedureProgressWitness<TShape>;
  readonly maxStalledSteps: number;
}

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
 * Parameter names that could pollute `Object.prototype` if ever forwarded
 * into an unguarded merge. Rejected outright by {@link M3LProcedure.run}'s
 * option validation, regardless of whether the shape happens to declare
 * them.
 */
const DANGEROUS_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * The floor {@link M3LProcedure.#createProgressTracker} clamps its derived
 * `maxStalledAttempts` to: a single comparison (2 total samples) can never
 * distinguish a genuine stall from coincidence, so the no-progress guard is
 * never eligible to trip before the 3rd continuing step's sample, however
 * aggressively the caller configures `maxStalledSteps`.
 */
const MIN_PROGRESS_STALL_COMPARISONS = 2;

/**
 * True when `value` — recursively, through plain objects and arrays —
 * contains a `BigInt` or a non-finite `number`. Both are rejected by
 * {@link M3LProcedure.run}'s parameter validation: neither survives
 * `canonicalJsonHash` (used to compute `parametersDigest`) or a JSON
 * round-trip.
 */
function containsInvalidNumericValue(value: unknown): boolean {
  if (isBigInt(value)) return true;
  if (isNumber(value)) return !Number.isFinite(value);
  if (isArray(value)) return value.some(containsInvalidNumericValue);
  if (isPlainObject(value)) {
    return Object.values(value).some(containsInvalidNumericValue);
  }
  return false;
}

/**
 * True when `signal` has fired. Routed through a function rather than
 * inlined — TypeScript's narrowing of a mutable external property is unsound
 * across an `await`, so a call site re-checking `signal?.aborted` after one
 * would otherwise report a spurious "no overlap" error; a function call
 * simply cannot be narrowed away.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * True when `error` carries the stable `"ERR_OPERATION_ABORTED"` code.
 * Checked by `code`, never `instanceof M3LOperationAbortedError` — a step
 * that throws a plain `M3LError` (or any object) carrying this code is still
 * recognised as an abort, matching the discrimination rule the rest of the
 * engine's abort handling uses.
 */
function isAbortErrorCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code: unknown }).code === "ERR_OPERATION_ABORTED"
  );
}

/**
 * Classifies a just-settled {@link StepExecutionOutcome} for
 * `internal/procedure/trace.ts`'s tracer: `failed` is `true` whenever this
 * attempt's `execute` threw — whether the throw ended phase 1
 * (`"failed"`/`"aborted"`) or was absorbed into a `"recovered"` step record
 * — with `flow` left `undefined` in every one of those cases; a clean
 * (`"succeeded"`) advance reports `failed: false` and the step's own
 * returned flow, projected to its scalar form.
 */
function classifyStepExecution<TShape extends M3LProcedureShape>(
  executed: StepExecutionOutcome<TShape>,
): M3LProcedureStepTraceClassification {
  switch (executed.kind) {
    case "aborted":
    case "failed":
      return { failed: true, flow: undefined };
    case "advanced":
      if (executed.record.status === "recovered") {
        return { failed: true, flow: undefined };
      }
      return { failed: false, flow: projectFlowToScalar(executed.flow) };
  }
}

/**
 * Reads `parameters` off the caller's run options exactly once, capturing a
 * fresh, frozen, isolated copy that every downstream consumer (validation,
 * then {@link createInitialContext}) reuses — `options.parameters` itself is
 * never read a second time. `parameters` may be a getter- or Proxy-backed
 * object under caller control, and re-reading it later would reproduce the
 * exact "two observations of a mutable caller graph" defect
 * `captureProgressConfig` (`internal/polling/progress.ts`) exists to
 * eliminate for the polling primitives' own `progress` option.
 */
function captureRunParameters<TShape extends M3LProcedureShape>(
  parameters: Readonly<TShape["parameters"]> | undefined,
): Readonly<TShape["parameters"]> | undefined {
  if (!isPlainObject(parameters)) return parameters;
  return Object.freeze({ ...parameters });
}

/**
 * Reads `progress` off the caller's run options exactly once — `witness` and
 * `maxStalledSteps` are each read into a local `const` before being copied
 * into the frozen result — mirroring `captureProgressConfig`'s shape.
 * Returns `undefined` when `progress` is `undefined`.
 */
function captureProgressOptions<TShape extends M3LProcedureShape>(
  progress: M3LProcedureProgressOptions<TShape> | undefined,
): CapturedProgressConfig<TShape> | undefined {
  if (progress === undefined) return undefined;
  const witness = progress.witness;
  const maxStalledSteps = progress.maxStalledSteps;
  return Object.freeze({ witness, maxStalledSteps });
}

/**
 * Projects a not-yet-concluded {@link PhaseOneAccumulated} (phase 1 already
 * ended or matched) into the `"aborted"` arm of {@link PhaseOneOutcome}, for
 * the abort boundaries checked between phase 1 and phase 2, and between
 * phase 2 and phase 3 — both report `abortedAt: undefined`, since no further
 * step boundary exists once phase 1 has concluded.
 */
function toAbortedPhaseOne<TShape extends M3LProcedureShape>(
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
  run(
    options: M3LProcedureRunOptions<TShape>,
  ): Promise<M3LProcedureOutcome<TShape>> {
    // Deliberately not `async`: option validation below must throw
    // *synchronously* out of `run()` itself. An `async` method turns every
    // throw in its body into a rejected promise instead of a synchronous
    // throw, and a caller relying on `try { procedure.run(...) } catch`
    // (or `captureSyncThrow`) around the call — before ever awaiting the
    // result — would observe nothing. Validation runs here, then the rest
    // of the work is delegated to an `async` method whose promise this
    // method returns unchanged.
    const parameters = captureRunParameters<TShape>(options.parameters);
    const progress = captureProgressOptions<TShape>(options.progress);
    const maxIterations = this.#validateRunOptions(
      options.maxIterations,
      parameters,
      progress,
    );
    return this.#runValidated(options, maxIterations, parameters, progress);
  }

  /**
   * Validates `options` synchronously, throwing
   * {@link M3LProcedureInvalidOptionError} on the first problem found —
   * before any step executes: an out-of-range `maxIterations`, a
   * `parameters` key the shape never declared (or a dangerous one, or a
   * value containing a non-finite number or a `BigInt`), or a malformed
   * `progress` guard.
   *
   * @returns The resolved iteration ceiling, so `#runValidated` need not
   *   re-derive it from `options`.
   */
  #validateRunOptions(
    maxIterationsOption: number | undefined,
    parameters: Readonly<TShape["parameters"]> | undefined,
    progress: CapturedProgressConfig<TShape> | undefined,
  ): number {
    const maxIterations = this.#validateMaxIterations(maxIterationsOption);
    this.#validateParameters(parameters);
    this.#validateProgressOptions(progress);
    return maxIterations;
  }

  /**
   * Validates `maxIterations`: when present, it must be a finite integer in
   * `[1, Number.MAX_SAFE_INTEGER]`. Returns the effective ceiling —
   * `maxIterations` itself, or {@link M3L_PROCEDURE_MAX_ITERATIONS} when
   * absent.
   */
  #validateMaxIterations(maxIterations: number | undefined): number {
    if (maxIterations === undefined) return M3L_PROCEDURE_MAX_ITERATIONS;
    if (
      !Number.isInteger(maxIterations) ||
      maxIterations < 1 ||
      maxIterations > Number.MAX_SAFE_INTEGER
    ) {
      throw new M3LProcedureInvalidOptionError(
        `maxIterations must be a finite integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
        { option: "maxIterations", value: maxIterations },
      );
    }
    return maxIterations;
  }

  /**
   * Validates `parameters`: every own key must be declared by this
   * procedure's shape (per {@link M3LProcedure.describe}'s `parameters`
   * list), must not be a dangerous name (`__proto__`, `constructor`,
   * `prototype`), and its value must not contain a non-finite number or a
   * `BigInt`. A `parameters` that isn't a plain object is left for
   * `createInitialContext` — this method only validates the shape it can
   * meaningfully inspect.
   */
  #validateParameters(parameters: unknown): void {
    if (!isPlainObject(parameters)) return;

    const declared = new Set(this.#summary.parameters);
    for (const key of Object.keys(parameters)) {
      if (DANGEROUS_PARAMETER_NAMES.has(key)) {
        throw new M3LProcedureInvalidOptionError(
          `parameter "${key}" is not a permitted parameter name`,
          { option: "parameters", parameter: key },
        );
      }
      if (!declared.has(key)) {
        throw new M3LProcedureInvalidOptionError(
          `parameter "${key}" was not declared by this procedure's shape`,
          { option: "parameters", parameter: key },
        );
      }
      if (containsInvalidNumericValue(parameters[key])) {
        throw new M3LProcedureInvalidOptionError(
          `parameter "${key}" contains a non-finite number or a BigInt`,
          { option: "parameters", parameter: key },
        );
      }
    }
  }

  /**
   * Validates the opt-in `progress` guard's shape: `witness` must be a
   * function and `maxStalledSteps` a finite integer greater than `0`. Only
   * the shape is validated here — the guard's sampling behaviour is a
   * later pass's responsibility. `progress` is already the captured copy
   * {@link captureProgressOptions} produced — reading its fields here never
   * re-reads the caller's original `options.progress`.
   */
  #validateProgressOptions(
    progress: CapturedProgressConfig<TShape> | undefined,
  ): void {
    if (progress === undefined) return;
    if (!isFunction(progress.witness)) {
      throw new M3LProcedureInvalidOptionError(
        "progress.witness must be a function",
        { option: "progress.witness" },
      );
    }
    if (
      !Number.isInteger(progress.maxStalledSteps) ||
      progress.maxStalledSteps <= 0
    ) {
      throw new M3LProcedureInvalidOptionError(
        "progress.maxStalledSteps must be a finite integer greater than 0",
        {
          option: "progress.maxStalledSteps",
          value: progress.maxStalledSteps,
        },
      );
    }
  }

  /**
   * The awaited body of {@link M3LProcedure.run}, invoked only once
   * `#validateRunOptions` has passed. Kept as a separate `async` method so
   * `run()` itself can stay synchronous through its validation step.
   */
  async #runValidated(
    options: M3LProcedureRunOptions<TShape>,
    maxIterations: number,
    parameters: Readonly<TShape["parameters"]> | undefined,
    progress: CapturedProgressConfig<TShape> | undefined,
  ): Promise<M3LProcedureOutcome<TShape>> {
    const startedAtMs = performance.now();
    const startedAt = new Date().toISOString();
    const tracer = createProcedureTracer<TShape>(options.trace, options.logger);

    const initialContext = createInitialContext<TShape>({
      deps: options.deps,
      parameters: parameters ?? {},
      initialValues: (options.initialValues ?? {}) as Readonly<
        Partial<TShape["values"]>
      >,
      signal: options.signal,
    });

    const phaseOne = await this.#runPhaseOne(
      initialContext,
      maxIterations,
      progress,
      tracer,
    );

    if (phaseOne.kind === "failed" || phaseOne.kind === "aborted") {
      return this.#finishEarlyPhaseOne(
        phaseOne,
        tracer,
        startedAt,
        startedAtMs,
      );
    }

    // Boundary check before phase 2 (case evaluation): `abortedAt` is
    // `undefined` here — phase 1 has already concluded, so there is no next
    // step boundary left to name.
    const preCases = this.#checkAbortBeforePhase(
      phaseOne,
      tracer,
      startedAt,
      startedAtMs,
    );
    if (preCases !== undefined) return preCases;

    const pass =
      phaseOne.kind === "matched"
        ? phaseOne.pass
        : this.#evaluateCases(phaseOne.context);
    const earlyResolved = phaseOne.kind === "matched";

    // Boundary check before phase 3 (the concluding action).
    const preConclude = this.#checkAbortBeforePhase(
      phaseOne,
      tracer,
      startedAt,
      startedAtMs,
    );
    if (preConclude !== undefined) return preConclude;

    const concluded = await this.#conclude(
      phaseOne,
      pass,
      earlyResolved,
      startedAt,
      startedAtMs,
    );
    return this.#finishOutcome(tracer, concluded);
  }

  /**
   * Assembles and traces the outcome for phase 1 concluding via an
   * unabsorbed step failure or an already-fired abort — the two
   * `PhaseOneOutcome` arms `#runValidated` handles identically (build the
   * matching outcome, then trace it), extracted purely to stay under that
   * method's line budget.
   */
  #finishEarlyPhaseOne(
    phaseOne: Extract<
      PhaseOneOutcome<TShape>,
      { kind: "failed" } | { kind: "aborted" }
    >,
    tracer: M3LProcedureTracer<TShape>,
    startedAt: string,
    startedAtMs: number,
  ): M3LProcedureOutcome<TShape> {
    const outcome =
      phaseOne.kind === "failed"
        ? this.#buildFailedOutcome(phaseOne, startedAt, startedAtMs)
        : this.#buildAbortedOutcome(phaseOne, startedAt, startedAtMs);
    return this.#finishOutcome(tracer, outcome);
  }

  /**
   * Shared boundary check used both before phase 2 and before phase 3: when
   * `phaseOne.context.signal` has already fired, assembles and traces the
   * `"aborted"` outcome (`abortedAt: undefined` — phase 1 has already
   * concluded, so there is no next step boundary left to name) and returns
   * it; otherwise returns `undefined` so the caller keeps going.
   */
  #checkAbortBeforePhase(
    phaseOne: PhaseOneAccumulated<TShape>,
    tracer: M3LProcedureTracer<TShape>,
    startedAt: string,
    startedAtMs: number,
  ): M3LProcedureOutcome<TShape> | undefined {
    const abortError = this.#checkAbortBoundary(phaseOne.context.signal);
    if (abortError === undefined) return undefined;
    return this.#finishOutcome(
      tracer,
      this.#buildAbortedOutcome(
        toAbortedPhaseOne(phaseOne, abortError),
        startedAt,
        startedAtMs,
      ),
    );
  }

  /**
   * Records the single per-run `"procedure:outcome"` trace entry (a no-op
   * when tracing isn't configured) and returns `outcome` unchanged — the
   * one seam every `#runValidated` exit path funnels through, so the
   * outcome tracer never needs to be invoked from more than this one place.
   */
  #finishOutcome(
    tracer: M3LProcedureTracer<TShape>,
    outcome: M3LProcedureOutcome<TShape>,
  ): M3LProcedureOutcome<TShape> {
    tracer.recordOutcome(outcome);
    return outcome;
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
    maxIterations: number,
    progress: CapturedProgressConfig<TShape> | undefined,
    tracer: M3LProcedureTracer<TShape>,
  ): Promise<PhaseOneOutcome<TShape>> {
    let context = initialContext;
    const executedSteps: M3LProcedureStepRecord[] = [];
    let resolveChecks = 0;
    let index = 0;
    const progressTracker = this.#createProgressTracker(
      progress,
      () => context,
    );

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

      const folded = await this.#advanceOneStep(
        context,
        step,
        maxIterations,
        tracer,
      );
      if (folded.kind === "return") {
        return { ...folded.result, context, executedSteps, resolveChecks };
      }
      context = folded.context;
      executedSteps.push(folded.record);

      const isLast = index === this.#steps.length - 1;
      const decision = this.#interpretFlow(
        context,
        folded.flow,
        index,
        isLast,
        resolveChecks,
      );
      resolveChecks = decision.resolveChecks;

      const flowResolution = this.#resolveStepFlow(
        context,
        decision,
        step.id,
        progressTracker,
        progress,
      );
      if (flowResolution.kind === "return") {
        return {
          ...flowResolution.result,
          context,
          executedSteps,
          resolveChecks,
        };
      }
      index = flowResolution.index;
    }
  }

  /**
   * Builds the opt-in no-progress guard's {@link ProgressTracker}, or
   * `undefined` when the caller declined `options.progress`. `getContext`
   * is read at call time (not at construction time) — the tracker is
   * instantiated once per `run()` call frame, never stored on the instance,
   * per `ProgressTracker`'s own contract, and phase 1's `context` binding is
   * reassigned every step — so the witness must read it through a closure
   * rather than capturing the initial value.
   *
   * `ProgressTracker`'s own `maxStalledAttempts` counts consecutive
   * unchanged samples *after* the first (baseline) one, so it trips on the
   * `maxStalledAttempts + 1`-th sample. `M3LProcedureProgressOptions.maxStalledSteps`
   * is the total number of (mutually unchanged) samples the guard should see
   * before tripping — the `- 1` translates one counting convention into the
   * other so `maxStalledSteps: N` trips on exactly the N-th continuing
   * step's sample. Floored at {@link MIN_PROGRESS_STALL_COMPARISONS}: a
   * single comparison (2 total samples) can never distinguish a genuine
   * stall from coincidence, so the guard is never eligible to trip before
   * the 3rd continuing step's sample regardless of how aggressively
   * `maxStalledSteps` is configured — the same boundary a cooperative-
   * cancellation check at that step also reaches, so an abort observed
   * there always has a chance to win.
   */
  #createProgressTracker(
    progress: CapturedProgressConfig<TShape> | undefined,
    getContext: () => M3LProcedureContext<TShape>,
  ): ProgressTracker | undefined {
    if (progress === undefined) return undefined;
    return new ProgressTracker({
      witness: () => progress.witness(getContext()),
      maxStalledAttempts: Math.max(
        progress.maxStalledSteps - 1,
        MIN_PROGRESS_STALL_COMPARISONS,
      ),
    });
  }

  /**
   * Checked at the top of every phase-1 loop pass, before `step.execute` ever
   * runs: cancellation first — it precedes every other guard at this
   * boundary, including the already-aborted case, which reaches here with
   * zero steps executed — then the iteration/revisit ceilings via
   * {@link M3LProcedure.#checkIterationCeiling}. Returns the failure to fold
   * into the caller's returned state, or `undefined` to let the step run.
   */
  #checkStepBoundary(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    maxIterations: number,
  ): StepGuardFailure<TShape> | undefined {
    const abortError = this.#checkAbortBoundary(context.signal);
    if (abortError !== undefined) {
      return { kind: "aborted", abortedAt: step.id, error: abortError };
    }
    return this.#checkIterationCeiling(context, step, maxIterations);
  }

  /**
   * Runs the pre-step boundary guard, then (only if it passed) traces and
   * executes `step`, folding the result — the whole "one step" unit
   * `#runPhaseOne`'s loop advances by, extracted purely to stay under that
   * method's line budget.
   */
  async #advanceOneStep(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    maxIterations: number,
    tracer: M3LProcedureTracer<TShape>,
  ): Promise<FoldedStepExecution<TShape>> {
    const preStepFailure = this.#checkStepBoundary(
      context,
      step,
      maxIterations,
    );
    if (preStepFailure !== undefined) {
      return { kind: "return", result: preStepFailure };
    }
    const executed = await this.#executeTracedStep(context, step, tracer);
    return this.#foldStepExecution(executed, step);
  }

  /**
   * Computes this attempt's 1-based number and runs `step` through `tracer`
   * — a thin seam kept out of `#runPhaseOne` purely to stay under that
   * method's line budget; `tracer` itself degrades to calling
   * `#executeOneStep` directly with no timing/describeTrace work when
   * tracing isn't configured (see `internal/procedure/trace.ts`).
   */
  #executeTracedStep(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    tracer: M3LProcedureTracer<TShape>,
  ): Promise<StepExecutionOutcome<TShape>> {
    const attempt = (context.results[step.id]?.attempt ?? 0) + 1;
    return tracer.runStep(
      step,
      context,
      attempt,
      () => this.#executeOneStep(context, step, attempt),
      classifyStepExecution,
    );
  }

  /**
   * Folds one step's {@link StepExecutionOutcome} for the phase-1 loop: an
   * unabsorbed failure or an abort become a `"return"` — phase 1 ends here,
   * with no context transition — while an advance is passed through as-is
   * for the caller to fold into its own local `context`/`executedSteps`.
   * Pure — `executed` and `step` are read, never mutated.
   */
  #foldStepExecution(
    executed: StepExecutionOutcome<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  ): FoldedStepExecution<TShape> {
    if (executed.kind === "failed") {
      return { kind: "return", result: executed };
    }
    if (executed.kind === "aborted") {
      return {
        kind: "return",
        result: { kind: "aborted", abortedAt: step.id, error: executed.error },
      };
    }
    return {
      kind: "advanced",
      context: executed.context,
      record: executed.record,
      flow: executed.flow,
    };
  }

  /**
   * Resolves what the phase-1 loop does once a step has advanced and
   * {@link M3LProcedure.#interpretFlow} has classified its directive: the
   * post-advance guard ({@link M3LProcedure.#checkAfterAdvance} — abort,
   * then the no-progress sample) wins first if it fires; otherwise an
   * `"ended"`/`"matched"` decision ends phase 1, and a `"advance"` decision
   * tells the caller which index to continue looping from.
   */
  #resolveStepFlow(
    context: M3LProcedureContext<TShape>,
    decision: FlowDecision<TShape>,
    stepId: TShape["stepId"],
    progressTracker: ProgressTracker | undefined,
    progress: CapturedProgressConfig<TShape> | undefined,
  ): FlowResolution<TShape> {
    const afterAdvance = this.#checkAfterAdvance(
      context,
      decision,
      stepId,
      progressTracker,
      progress,
    );
    if (afterAdvance !== undefined) {
      return { kind: "return", result: afterAdvance };
    }
    if (decision.kind === "ended") {
      return { kind: "return", result: { kind: "ended" } };
    }
    if (decision.kind === "matched") {
      return {
        kind: "return",
        result: { kind: "matched", pass: decision.pass },
      };
    }
    return { kind: "continue", index: decision.index };
  }

  /**
   * Returns a fresh {@link M3LOperationAbortedError} when `signal` has
   * fired, else `undefined`. Called at every abort boundary the engine
   * enforces (before each step, right after a step's context is derived,
   * and before phases 2 and 3) — it precedes every other guard at each of
   * those boundaries, so an aborted signal always wins over the iteration
   * ceiling or a no-progress trip.
   */
  #checkAbortBoundary(
    signal: AbortSignal | undefined,
  ): M3LOperationAbortedError | undefined {
    return isAborted(signal) ? new M3LOperationAbortedError() : undefined;
  }

  /**
   * Runs the checks common to every step that just advanced, in the order
   * the contract requires: the abort boundary right after this step's
   * context was derived (so an abort always wins over a no-progress trip
   * sampled for the same step), then — only if no abort fired — the
   * no-progress guard's sample. Returns the failure to fold into the
   * caller's returned state, or `undefined` to keep going.
   *
   * `decision` is already resolved by the time this runs, so an abort caught
   * here can report the correct `abortedAt`: the id of the step phase 1
   * would run next when `decision.kind === "advance"`, or `undefined` when
   * this step's own flow was already ending phase 1 (`"ended"`/`"matched"`)
   * — there is no further step boundary left to name in that case, matching
   * the `abortedAt: undefined` phase-2/phase-3 boundary checks in
   * `#runValidated`.
   */
  #checkAfterAdvance(
    context: M3LProcedureContext<TShape>,
    decision: FlowDecision<TShape>,
    stepId: TShape["stepId"],
    progressTracker: ProgressTracker | undefined,
    progress: CapturedProgressConfig<TShape> | undefined,
  ): StepGuardFailure<TShape> | undefined {
    const abortError = this.#checkAbortBoundary(context.signal);
    if (abortError !== undefined) {
      const abortedAt =
        decision.kind === "advance"
          ? this.#steps[decision.index]?.id
          : undefined;
      return { kind: "aborted", abortedAt, error: abortError };
    }
    if (progressTracker === undefined || progress === undefined) {
      return undefined;
    }
    return this.#sampleProgress(
      progressTracker,
      progress.maxStalledSteps,
      stepId,
    );
  }

  /**
   * Samples `tracker` once for the step that just completed (`stepId`),
   * translating both of its failure modes into engine-native ones: a
   * tripped guard becomes {@link M3LProcedureNoProgressError}
   * (`ERR_PROCEDURE_NO_PROGRESS`), and a witness that threw or returned a
   * non-primitive — surfaced by `ProgressTracker.record()` as
   * `ERR_POLLING_INVALID_OPTION` — is re-wrapped as
   * {@link M3LProcedureInvalidOptionError} (`ERR_PROCEDURE_INVALID_OPTION`)
   * so a `core/procedure` caller never observes a polling-vocabulary code.
   * The witness's own original thrown value — not the
   * `M3LPollingInvalidOptionError` wrapper — is chained as `cause`.
   */
  #sampleProgress(
    tracker: ProgressTracker,
    maxStalledSteps: number,
    stepId: TShape["stepId"],
  ): Extract<StepExecutionOutcome<TShape>, { kind: "failed" }> | undefined {
    let tripped: boolean;
    try {
      tripped = tracker.record();
    } catch (cause) {
      const originalCause =
        cause instanceof M3LPollingInvalidOptionError ? cause.cause : cause;
      return {
        kind: "failed",
        stepId,
        error: new M3LProcedureInvalidOptionError(
          "the procedure's progress witness rejected a sample",
          { option: "progress.witness" },
          originalCause,
        ),
      };
    }

    if (!tripped) return undefined;

    return {
      kind: "failed",
      stepId,
      error: new M3LProcedureNoProgressError(
        `no progress observed for ${maxStalledSteps} consecutive step(s)`,
        { stalledSteps: maxStalledSteps, lastStepId: stepId },
      ),
    };
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
   * Checked at the top of every phase-1 loop pass, before `step.execute`
   * ever runs: refuses the run once `context.iteration` (the run's total
   * executions so far — `deriveContext` increments it on every execution,
   * success or `continueOnFailure`-recovered alike) has already reached
   * `maxIterations`, or once `step`'s own declared `loop.maxRevisits`
   * ceiling has already been reached by its prior executions — read off
   * `context.results[step.id].attempt`, the same per-step execution counter
   * {@link M3LProcedure.#executeOneStep} maintains, so no separate counter
   * needs to be threaded through the loop. Pure — returns a failure for the
   * caller to fold into its own local state rather than throwing or
   * mutating anything.
   */
  #checkIterationCeiling(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    maxIterations: number,
  ): Extract<StepExecutionOutcome<TShape>, { kind: "failed" }> | undefined {
    if (context.iteration >= maxIterations) {
      return {
        kind: "failed",
        stepId: step.id,
        error: new M3LProcedureIterationLimitError(
          `procedure exceeded its iteration ceiling of ${maxIterations} step execution(s)`,
          { limit: "iterations", maxIterations },
        ),
      };
    }

    const { loop } = step;
    if (loop === undefined) return undefined;

    const priorExecutions = context.results[step.id]?.attempt ?? 0;
    if (priorExecutions <= loop.maxRevisits) return undefined;

    return {
      kind: "failed",
      stepId: step.id,
      error: new M3LProcedureIterationLimitError(
        `step "${step.id}" exceeded its revisit ceiling of ${loop.maxRevisits}`,
        { limit: "revisits", stepId: step.id, maxRevisits: loop.maxRevisits },
      ),
    };
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
    attempt: number,
  ): Promise<StepExecutionOutcome<TShape>> {
    const start = performance.now();
    try {
      const result = await step.execute(context);
      return this.#advanceFromResult(context, step, attempt, start, result);
    } catch (error) {
      // Abort wins over `continueOnFailure`: an aborting step is never
      // absorbed into a recovery entry, regardless of the step's own
      // declaration. Discriminated by `code`, not `instanceof`, so a plain
      // `M3LError` carrying this code is recognised the same as the
      // concrete `M3LOperationAbortedError` subclass.
      if (isAbortErrorCode(error)) {
        return {
          kind: "aborted",
          error: new M3LOperationAbortedError(
            error instanceof Error ? error.message : undefined,
          ),
        };
      }
      if (step.continueOnFailure !== true) {
        return { kind: "failed", stepId: step.id, error };
      }
      return this.#advanceFromRecovery(context, step, attempt, start, error);
    }
  }

  /**
   * Folds a step's resolved {@link M3LProcedureStepResult} into the
   * `"advanced"` arm of {@link StepExecutionOutcome}: builds the
   * `"succeeded"` record and derives the next context, carrying `values`
   * only when the step actually returned one (`exactOptionalPropertyTypes`
   * rejects an explicit `undefined` on `deriveContext`'s optional field).
   */
  #advanceFromResult(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    attempt: number,
    start: number,
    result: M3LProcedureStepResult<TShape, TShape["stepId"]>,
  ): Extract<StepExecutionOutcome<TShape>, { kind: "advanced" }> {
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
  }

  /**
   * Folds an absorbed `execute` throw (`step.continueOnFailure === true`,
   * already confirmed by the caller) into the `"advanced"` arm of
   * {@link StepExecutionOutcome}: builds the `"recovered"` record, appends a
   * {@link M3LRunRecoveryEntry}, and derives the next context. A step that
   * threw never got to return its own flow directive — a step declaring
   * `loop` has explicitly opted into being revisited, so for such a step the
   * absorbed failure retries it (bounded by the step's own
   * `loop.maxRevisits`/`maxIterations`, same as an explicit `{ goTo }`)
   * rather than silently advancing past a still-failing operation; a step
   * with no `loop` declaration advances normally.
   */
  #advanceFromRecovery(
    context: M3LProcedureContext<TShape>,
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    attempt: number,
    start: number,
    error: unknown,
  ): Extract<StepExecutionOutcome<TShape>, { kind: "advanced" }> {
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
      flow: step.loop === undefined ? "continue" : { goTo: step.id },
    };
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

  /** Assembles the resolved `aborted` outcome for a fired `AbortSignal`. */
  #buildAbortedOutcome(
    phaseOne: Extract<PhaseOneOutcome<TShape>, { kind: "aborted" }>,
    startedAt: string,
    startedAtMs: number,
  ): M3LProcedureOutcome<TShape> {
    return {
      digest: this.digest,
      parametersDigest: canonicalJsonHash(phaseOne.context.parameters),
      trace: [],
      telemetry: this.#buildTelemetry(phaseOne, false, startedAt, startedAtMs),
      status: "aborted",
      abortedAt: phaseOne.abortedAt,
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
