/**
 * `core/procedure/types` — the public shape, step, condition, case, run,
 * outcome, tracing, and validation types consumed and produced by
 * {@link M3LProcedure} and {@link M3LProcedureBuilder}.
 *
 * @packageDocumentation
 */

import type {
  M3LBreadcrumbScalar,
  M3LRunRecoveryEntry,
} from "../diagnostics/index.js";
import type { M3LLogger } from "../logging/M3LLogger.js";
import type { M3LOperationAbortedError } from "../errors/M3LOperationAbortedError.js";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A JSON-scalar: the leaf type every {@link M3LProcedureValue} bottoms out
 * at. `null` is included deliberately — a condition's `exists` arm treats a
 * present `null` differently from an absent key.
 */
export type M3LProcedureScalar = string | number | boolean | null;

/**
 * A serialisable value a step may output, a `values`/`parameters` map may
 * hold, and a {@link M3LProcedureReference} may address. Recursive: an array
 * or object of {@link M3LProcedureValue} is itself one.
 *
 * A non-serialisable handle — an SDK client, a logger, an `M3LPrompt` — is
 * never a step output; it belongs in `context.deps`, which is opaque to
 * conditions and never traced or hashed.
 *
 * @remarks
 * This type admits `NaN` and `Infinity`, which TypeScript cannot exclude but
 * `canonicalJsonHash` rejects with `ERR_INVALID_ARGUMENT`. The engine never
 * hashes a step output — only the built definition and the run's
 * `parameters` are hashed.
 */
export type M3LProcedureValue =
  | M3LProcedureScalar
  | readonly M3LProcedureValue[]
  | { readonly [key: string]: M3LProcedureValue };

/** A closed map of serialisable values — what `values` and `parameters` are. */
export type M3LProcedureValueMap = Readonly<Record<string, M3LProcedureValue>>;

/**
 * The single caller-declared interface every `core/procedure` type is
 * parameterised by. Threading the six positional generics this bundle holds
 * through every exported type individually would be unusable; a single shape
 * keeps each signature to one type argument and gives the compiler enough to
 * reject a typo'd step id or value key as a compile error.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface LogAnalysis extends Core.M3LProcedureShape {
 *   deps: { readonly logs: { query(q: string): Promise<number> } };
 *   values: { errorCount: number; topMessage: string };
 *   parameters: { logGroup: string; errorThreshold: number };
 *   conclusion: void;
 *   stepId: "count-errors" | "sample-traces" | "confirm";
 *   caseId: "error-spike" | "throttled" | "healthy";
 * }
 * ```
 */
export interface M3LProcedureShape {
  /** The injected dependency bag. The engine never reads a property of it. */
  readonly deps: unknown;
  /** The extracted-value map; its keys are what a `value` reference may name. */
  readonly values: M3LProcedureValueMap;
  /** The resolved parameters; its keys are what a `parameter` reference may name. */
  readonly parameters: M3LProcedureValueMap;
  /** What a case action and the fallback action produce. */
  readonly conclusion: unknown;
  /** The closed step-id union. */
  readonly stepId: string;
  /** The closed case-id union. */
  readonly caseId: string;
}

// ---------------------------------------------------------------------------
// Values and references
// ---------------------------------------------------------------------------

/**
 * A path into a nested value. Non-empty; array indices are decimal strings
 * (`"0"`, `"12"`) rather than numbers, so the whole reference stays
 * canonical-JSON serialisable.
 */
export type M3LProcedurePath = readonly [string, ...(readonly string[])];

/**
 * Addresses one of the four things a condition may read. A value object, not
 * a parsed string: nothing is parsed at run time, a typo'd step or value key
 * is a compile error, and a dangling step reference is a build-time problem.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export type M3LProcedureReference<TShape extends M3LProcedureShape> =
  | {
      readonly source: "step";
      readonly step: TShape["stepId"];
      readonly path?: M3LProcedurePath;
    }
  | {
      readonly source: "value";
      readonly key: keyof TShape["values"] & string;
      readonly path?: M3LProcedurePath;
    }
  | {
      readonly source: "parameter";
      readonly key: keyof TShape["parameters"] & string;
      readonly path?: M3LProcedurePath;
    }
  | { readonly source: "literal"; readonly literal: M3LProcedureScalar };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * What a step is declared to be for. A declaration, not a capability grant —
 * the engine does not treat kinds differently; it exists so a trace and an
 * operator report can say what a step _was for_.
 */
export type M3LProcedureStepKind =
  | "gather" // acquires evidence from outside the procedure
  | "transform" // derives values from evidence already gathered
  | "check" // asserts something about the evidence
  | "decide" // chooses a path, possibly by asking the operator
  | "control"; // manipulates flow only

/**
 * Acknowledges that a step's own back edges (a `jumpsTo` entry naming itself
 * or an earlier step) are deliberate, not an accidental cycle. Edges out of a
 * step carrying `loop` are excluded from build-time cycle detection; the
 * engine enforces `maxRevisits` at run time instead.
 */
export interface M3LProcedureLoop {
  /** Why this repetition is deliberate. Recorded in the definition digest. */
  readonly reason: string;
  /** Extra executions permitted beyond the first. Finite integer \> 0. */
  readonly maxRevisits: number;
}

/**
 * The flow directive a step's `execute` returns. The **engine**, never the
 * step, interprets it:
 *
 * - `"continue"` — run the next step in declaration order.
 * - `"stop"` — stop executing steps and go straight to case evaluation.
 * - `"resolve"` — evaluate every case immediately; on a match the run
 *   terminates early, on no match the run continues as if `"continue"` had
 *   been returned.
 * - `{ goTo }` — jump to that step.
 *
 * @typeParam TJump - The step's own declared `jumpsTo` targets. Defaults to
 *   `never`, so a step that declares no jumps cannot construct a `goTo` arm
 *   at all: `{ readonly goTo: never }` is uninhabited.
 */
export type M3LProcedureFlow<TJump extends string = never> =
  "continue" | "stop" | "resolve" | { readonly goTo: TJump };

/**
 * The patch a step returns. A step never returns a context — see
 * {@link M3LProcedureContext}.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @typeParam TJump - The declaring step's own `jumpsTo` targets.
 */
export interface M3LProcedureStepResult<
  TShape extends M3LProcedureShape,
  TJump extends TShape["stepId"] = never,
> {
  readonly flow: M3LProcedureFlow<TJump>;
  /** Recorded under this step's id; addressable by a `step` reference. */
  readonly output?: M3LProcedureValue;
  /** Merged into the next context's `values`. Absent keys are untouched. */
  readonly values?: Readonly<Partial<TShape["values"]>>;
  /** A short, non-secret operator note recorded on the step record. */
  readonly note?: string;
}

/**
 * One caller-declared step in a procedure's ordered step list.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @typeParam TId - This step's own id, drawn from `TShape["stepId"]`.
 * @typeParam TJump - Every step id this step's `execute` may return as a
 *   `{ goTo }` target. Declared, not inferred: `goTo` is a value a function
 *   body returns, so the jump graph is not statically knowable without this.
 */
export interface M3LProcedureStep<
  TShape extends M3LProcedureShape,
  TId extends TShape["stepId"],
  TJump extends TShape["stepId"] = never,
> {
  readonly id: TId;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  /**
   * Every step id this step's `execute` may return as a `{ goTo }` target.
   * It is load-bearing twice — it is what makes build-time cycle detection
   * possible at all, and `TJump` is inferred from it, so `execute` cannot
   * return a `goTo` this array does not name.
   */
  readonly jumpsTo?: readonly TJump[];
  /**
   * Acknowledges that this step's jump edges are deliberate back edges. Edges
   * out of a step carrying `loop` are excluded from cycle detection; the
   * engine enforces `maxRevisits` at run time instead.
   */
  readonly loop?: M3LProcedureLoop;
  /** Absorb a throw from `execute` into a recovery entry and advance. */
  readonly continueOnFailure?: boolean;
  readonly execute: (
    context: M3LProcedureContext<TShape>,
  ) =>
    | M3LProcedureStepResult<TShape, NoInfer<TJump>>
    | Promise<M3LProcedureStepResult<TShape, NoInfer<TJump>>>;
  /**
   * Called **before** `execute`, with the context `execute` is about to
   * receive — so what reaches the trace is the *resolved* value the step
   * actually used, not the declaration it came from. Return type is pinned
   * to the allowlisted breadcrumb scalars and enforced again at run time.
   */
  readonly describeTrace?: (
    context: M3LProcedureContext<TShape>,
  ) => Readonly<Record<string, M3LBreadcrumbScalar>>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The latest recorded execution of one step. Overwritten on a revisit (via
 * `{ goTo }`); `attempt` increments each time.
 */
export interface M3LProcedureStepRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  readonly status: "succeeded" | "recovered";
  /** 1-based; increments when a `goTo` revisits this step. */
  readonly attempt: number;
  readonly output: M3LProcedureValue | undefined;
  readonly note: string | undefined;
  readonly durationMs: number;
}

/**
 * The immutable, copy-on-write context a step receives. A step returns a
 * _patch_, never a context — the engine derives the next frozen context at
 * exactly one call site, so a step cannot mutate or forge one.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureContext<TShape extends M3LProcedureShape> {
  /** The injected dependency bag. The same reference for the whole run. */
  readonly deps: TShape["deps"];
  /** The latest record per step id. `Partial` — mid-run, most are absent. */
  readonly results: Readonly<
    Partial<Record<TShape["stepId"], M3LProcedureStepRecord>>
  >;
  readonly values: Readonly<Partial<TShape["values"]>>;
  readonly parameters: Readonly<TShape["parameters"]>;
  /** Failures absorbed by `continueOnFailure`, capped at `M3L_RECOVERY_LIMIT`. */
  readonly recovered: readonly M3LRunRecoveryEntry[];
  /** The true count of absorbed failures, even when `recovered` was capped. */
  readonly recoveredTotal: number;
  /**
   * The cooperative cancellation signal (ADR-0049), or `undefined`.
   * Deliberately a required property holding `undefined` rather than an
   * optional one: under `exactOptionalPropertyTypes` an optional key lets a
   * caller-side helper forget the field exists, while a required
   * `AbortSignal | undefined` forces the narrow.
   */
  readonly signal: AbortSignal | undefined;
  /** Count of step executions completed before this one. */
  readonly iteration: number;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** The comparison operators `compare` supports. */
export type M3LProcedureCompareOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

/** The discriminant of a {@link M3LProcedureCondition} node. */
export type M3LProcedureConditionKind =
  "compare" | "matches" | "contains" | "exists" | "and" | "or" | "not";

/**
 * A serialisable value object describing one node of a condition tree —
 * never a predicate function, which cannot be traced, statically checked, or
 * explained.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export type M3LProcedureCondition<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "compare";
      readonly left: M3LProcedureReference<TShape>;
      readonly operator: M3LProcedureCompareOperator;
      readonly right: M3LProcedureReference<TShape>;
    }
  | {
      readonly kind: "matches";
      readonly subject: M3LProcedureReference<TShape>;
      readonly pattern: string;
      readonly ignoreCase?: boolean;
    }
  | {
      readonly kind: "contains";
      readonly subject: M3LProcedureReference<TShape>;
      readonly item: M3LProcedureReference<TShape>;
    }
  | { readonly kind: "exists"; readonly subject: M3LProcedureReference<TShape> }
  | {
      readonly kind: "and";
      readonly operands: readonly [
        M3LProcedureCondition<TShape>,
        ...M3LProcedureCondition<TShape>[],
      ];
    }
  | {
      readonly kind: "or";
      readonly operands: readonly [
        M3LProcedureCondition<TShape>,
        ...M3LProcedureCondition<TShape>[],
      ];
    }
  | { readonly kind: "not"; readonly operand: M3LProcedureCondition<TShape> };

/**
 * One reference resolved during condition evaluation, alongside whether it
 * was present. This is what lets a run report _why_ it concluded what it
 * did, without re-running anything.
 *
 * @remarks
 * **Safety classification.** Carries resolved caller data verbatim, so it is
 * _run-report grade_, not _breadcrumb grade_ — it reaches the outcome and is
 * never handed to a trace sink.
 */
export type M3LProcedureResolvedReference =
  | {
      /** Canonical rendering, e.g. `"step:count-errors.count"`, `"literal:5"`. */
      readonly reference: string;
      readonly present: true;
      readonly resolved: M3LProcedureValue;
      /** Set when an arm declined a value that did resolve. */
      readonly refused?: "oversized" | "invalid-pattern";
    }
  | {
      /** Canonical rendering, e.g. `"step:count-errors.count"`, `"literal:5"`. */
      readonly reference: string;
      readonly present: false;
      readonly resolved?: undefined;
      readonly refused?: undefined;
    };

/**
 * A tree mirroring a {@link M3LProcedureCondition} tree, one evaluation node
 * per condition node. `and`/`or` deliberately do not short-circuit: an
 * unevaluated operand would leave a hole in the explanation.
 *
 * @remarks
 * There is deliberately no case-evaluation trace event: this tree carries
 * resolved caller values and is report-grade, not breadcrumb-grade.
 */
export interface M3LProcedureConditionEvaluation {
  readonly kind: M3LProcedureConditionKind;
  readonly satisfied: boolean;
  /** The leaf references this node resolved; empty for `and`/`or`/`not`. */
  readonly references: readonly M3LProcedureResolvedReference[];
  /** Child evaluations; empty for leaves. */
  readonly operands: readonly M3LProcedureConditionEvaluation[];
  /** A short rendered explanation, e.g. `"12 > 5"`. Length-capped. */
  readonly detail: string | undefined;
}

/**
 * The read-only view of run state {@link evaluateProcedureCondition} reads a
 * condition against — a subset of {@link M3LProcedureContext} that excludes
 * `deps`, `recovered`, `signal`, and `iteration`, none of which a condition
 * may address.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureConditionScope<TShape extends M3LProcedureShape> {
  readonly results: Readonly<
    Partial<Record<TShape["stepId"], M3LProcedureStepRecord>>
  >;
  readonly values: Readonly<Partial<TShape["values"]>>;
  readonly parameters: Readonly<TShape["parameters"]>;
}

// ---------------------------------------------------------------------------
// Cases and the mandatory fallback
// ---------------------------------------------------------------------------

/**
 * One evaluated case: its declared metadata alongside the evaluation tree its
 * `condition` produced against a run's scope.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureCaseEvaluation<TShape extends M3LProcedureShape> {
  readonly caseId: TShape["caseId"];
  readonly description: string;
  readonly prose: string;
  readonly priority: number;
  readonly evaluation: M3LProcedureConditionEvaluation;
}

/**
 * A {@link M3LProcedureCaseEvaluation} that provably matched.
 * `boolean & true` collapses to `true`, so `match.evaluation.satisfied` is
 * the literal `true`: a case action can never be handed an unsatisfied
 * evaluation, enforced by the compiler rather than a test asserting it.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export type M3LProcedureCaseMatch<TShape extends M3LProcedureShape> = Omit<
  M3LProcedureCaseEvaluation<TShape>,
  "evaluation"
> & {
  readonly evaluation: M3LProcedureConditionEvaluation & {
    readonly satisfied: true;
  };
};

/**
 * A prioritised, named conclusion candidate. Priority is unique across the
 * procedure — a tie is a build-time problem, never a convention, because it
 * would make which case matched depend on array order.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @typeParam TId - This case's own id, drawn from `TShape["caseId"]`.
 */
export interface M3LProcedureCase<
  TShape extends M3LProcedureShape,
  TId extends TShape["caseId"],
> {
  readonly id: TId;
  /** What this case means, for a maintainer. */
  readonly description: string;
  /** Operator-facing prose — what a human reads when this case wins. */
  readonly prose: string;
  readonly condition: M3LProcedureCondition<TShape>;
  /** Unique across the procedure; higher wins. */
  readonly priority: number;
  readonly action: (
    context: M3LProcedureContext<TShape>,
    match: M3LProcedureCaseMatch<TShape>,
  ) => TShape["conclusion"] | Promise<TShape["conclusion"]>;
}

/**
 * The mandatory, id-less conclusion for "no case matched". A required
 * positional argument to `build()`, so a procedure without a defined outcome
 * for unrecognised evidence cannot be constructed.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureFallback<TShape extends M3LProcedureShape> {
  readonly description: string;
  readonly prose: string;
  /** Receives every case evaluation, so "what was investigated" is data. */
  readonly action: (
    context: M3LProcedureContext<TShape>,
    investigated: readonly M3LProcedureCaseEvaluation<TShape>[],
  ) => TShape["conclusion"] | Promise<TShape["conclusion"]>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Options for {@link M3LProcedureBuilder.build}.
 */
export interface M3LProcedureBuildOptions {
  /**
   * Folded into the digest projection. The digest cannot see handler
   * *bodies* (functions are not canonical-JSON serialisable), so this is the
   * author's lever for "the declared shape is unchanged but the behaviour is
   * not".
   */
  readonly revision?: string;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Samples one cheap, side-effect-free, serialisable-ish witness value per
 * continuing step for the no-progress guard.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export type M3LProcedureProgressWitness<TShape extends M3LProcedureShape> = (
  context: M3LProcedureContext<TShape>,
) => string | number | bigint | boolean;

/**
 * The opt-in no-progress guard, mirroring `M3LPollerOptions` and
 * `M3LRetryRunnerOptions`: absent, no guard runs and the engine samples
 * nothing.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureProgressOptions<TShape extends M3LProcedureShape> {
  /** Sampled once per continuing step. Must be cheap and side-effect-free. */
  readonly witness: M3LProcedureProgressWitness<TShape>;
  /** Consecutive unchanged samples after the baseline that trip the guard. */
  readonly maxStalledSteps: number;
}

/**
 * Fields common to every {@link M3LProcedureRunOptions}, regardless of
 * whether `TShape["parameters"]` has any declared keys. Not part of the
 * public API on its own — {@link M3LProcedureRunOptions} is the exported
 * type consumers name.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
interface M3LProcedureRunOptionsBase<TShape extends M3LProcedureShape> {
  readonly deps: TShape["deps"];
  readonly signal?: AbortSignal;
  /** Ceiling on step *executions*. Defaults to `M3L_PROCEDURE_MAX_ITERATIONS`. */
  readonly maxIterations?: number;
  /**
   * The no-progress guard. **Opt-in**, exactly as `M3LPollerOptions` and
   * `M3LRetryRunnerOptions` have it: absent, no guard runs and the engine
   * samples nothing. The iteration ceiling still bounds a runaway loop.
   */
  readonly progress?: M3LProcedureProgressOptions<TShape>;
  readonly trace?: M3LProcedureTraceOptions;
  /** Used only for guarded tracing warnings. Absent → the warning is dropped. */
  readonly logger?: M3LLogger;
  readonly initialValues?: Readonly<Partial<TShape["values"]>>;
}

/**
 * Options for {@link M3LProcedure.run}. `parameters` is conditionally
 * required: absent when `TShape["parameters"]` declares no keys, or when
 * every declared key's value type is `never` (the `Record<string, never>`
 * spelling of "no parameters"), required otherwise — the same mechanism
 * `M3LOperationPipelineOptions` uses to make `prepare` conditionally required
 * on `TContext`.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export type M3LProcedureRunOptions<TShape extends M3LProcedureShape> =
  M3LProcedureRunOptionsBase<TShape> &
    ([keyof TShape["parameters"]] extends [never]
      ? { readonly parameters?: Readonly<TShape["parameters"]> }
      : [TShape["parameters"][keyof TShape["parameters"]]] extends [never]
        ? { readonly parameters?: Readonly<TShape["parameters"]> }
        : { readonly parameters: Readonly<TShape["parameters"]> });

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * Per-run telemetry: every step execution (including revisits), and the
 * counters a caller needs to tell "checked once" apart from "checked four
 * times".
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureTelemetry<TShape extends M3LProcedureShape> {
  /** Every execution, in order — including revisits. */
  readonly steps: readonly M3LProcedureStepRecord[];
  readonly iterations: number;
  /**
   * Declared steps that never executed, because of `stop`, a forward
   * `goTo`, or an early `resolve`.
   */
  readonly stepsSkipped: number;
  /** How many times a `resolve` triggered an all-case check. */
  readonly resolveChecks: number;
  /** Directly assignable to `M3LRunReportInput["recovery"]`. */
  readonly recovered: readonly M3LRunRecoveryEntry[];
  /** The true, uncapped count — `M3LRunReportInput["recoveryTotal"]`. */
  readonly recoveredTotal: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly terminatedAt: TShape["stepId"] | undefined;
  readonly earlyResolved: boolean;
}

/**
 * Fields common to every {@link M3LProcedureOutcome} arm.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureOutcomeBase<TShape extends M3LProcedureShape> {
  /** `canonicalJsonHash` over the built definition. Identical across runs. */
  readonly digest: string;
  /** `canonicalJsonHash` over this run's parameters. */
  readonly parametersDigest: string;
  /** The allowlisted per-step trace, in execution order. */
  readonly trace: readonly M3LProcedureTraceEntry[];
  readonly telemetry: M3LProcedureTelemetry<TShape>;
}

/**
 * The resolved result of {@link M3LProcedure.run}. `run()` resolves for all
 * four arms — only a contract violation (a `build()` problem, or a malformed
 * `run` option) throws.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @remarks
 * `alsoMatched: readonly []` appears on three arms rather than being
 * omitted, so a caller can read `outcome.alsoMatched.length` without
 * narrowing first.
 */
export type M3LProcedureOutcome<TShape extends M3LProcedureShape> =
  M3LProcedureOutcomeBase<TShape> &
    (
      | {
          readonly status: "matched";
          readonly primary: M3LProcedureCaseMatch<TShape>;
          /** Every OTHER case that also matched, descending priority. */
          readonly alsoMatched: readonly M3LProcedureCaseMatch<TShape>[];
          readonly conclusion: TShape["conclusion"];
          readonly error?: undefined;
        }
      | {
          readonly status: "unrecognized";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** Every case checked, with its full evaluation tree. */
          readonly investigated: readonly M3LProcedureCaseEvaluation<TShape>[];
          readonly conclusion: TShape["conclusion"];
          readonly error?: undefined;
        }
      | {
          readonly status: "failed";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** The step that failed, or `undefined` for a guard failure. */
          readonly failedStep: TShape["stepId"] | undefined;
          readonly error: unknown;
        }
      | {
          readonly status: "aborted";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** The boundary the abort was observed at. */
          readonly abortedAt: TShape["stepId"] | undefined;
          readonly error: M3LOperationAbortedError;
        }
    );

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/**
 * The sink an `options.trace` handler records step and outcome events to.
 * This is a separate declaration from `M3LPipelineTraceSink`, not a reuse:
 * their TSDoc, `@link` targets and event names all say "step" where the
 * pipeline's say "phase".
 */
export interface M3LProcedureTraceSink {
  record(source: string, event: string, payload?: unknown): void;
}

/**
 * Opt-in, additive tracing for {@link M3LProcedure.run}. Absent, the engine
 * touches no sink and does no tracing work.
 */
export interface M3LProcedureTraceOptions {
  readonly sink: M3LProcedureTraceSink;
  /** Overrides the default `"M3LProcedure"` source label. */
  readonly source?: string;
}

/**
 * One `procedure:step` trace entry: the engine's own scalar keys plus
 * `describeTrace`'s allowlist-projected return. The engine's keys are
 * applied last, so a `describeTrace` return cannot forge them.
 */
export interface M3LProcedureTraceEntry {
  readonly stepId: string;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  readonly attempt: number;
  readonly durationMs: number;
  readonly failed: boolean;
  /**
   * The flow directive, **projected to a scalar**: `"continue"`, `"stop"`,
   * `"resolve"`, or `"goTo:<targetId>"`. `undefined` when the step threw.
   *
   * `M3LProcedureFlow`'s `{ goTo }` arm is an object, and a breadcrumb sink
   * drops a non-scalar payload entry — so the structured form would silently
   * vanish from exactly the trace that is supposed to explain the jump.
   */
  readonly flow: string | undefined;
  readonly payload: Readonly<Record<string, M3LBreadcrumbScalar>>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The eleven per-problem codes, narrowed away from the full `M3LErrorCode`.
 */
export type M3LProcedureProblemCode =
  | "ERR_PROCEDURE_EMPTY_STEPS"
  | "ERR_PROCEDURE_DUPLICATE_STEP_ID"
  | "ERR_PROCEDURE_INVALID_JUMP_TARGET"
  | "ERR_PROCEDURE_CYCLE_DETECTED"
  | "ERR_PROCEDURE_DUPLICATE_CASE_ID"
  | "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY"
  | "ERR_PROCEDURE_MISSING_FALLBACK"
  | "ERR_PROCEDURE_INVALID_PATTERN"
  | "ERR_PROCEDURE_CONDITION_TOO_DEEP"
  | "ERR_PROCEDURE_UNKNOWN_REFERENCE"
  | "ERR_PROCEDURE_INVALID_DECLARATION";

/**
 * One finding `build()` collected while validating a definition. Every
 * finding surfaces together under a single throw's `context.problems` —
 * `build()` reports every problem it finds at once, never one rejection at a
 * time.
 */
export interface M3LProcedureValidationProblem {
  readonly code: M3LProcedureProblemCode;
  readonly message: string;
  readonly stepId?: string;
  readonly caseId?: string;
  /** For `ERR_PROCEDURE_CYCLE_DETECTED`: the cycle, first node repeated last. */
  readonly path?: readonly string[];
}

// ---------------------------------------------------------------------------
// Definition digest
// ---------------------------------------------------------------------------

/**
 * The exact serialisable projection `M3LProcedure.digest` hashes, returned
 * as-is by {@link M3LProcedure.describe}. Every field is a scalar, an array,
 * or a condition value object — nothing here is a function, so
 * `canonicalJsonHash` accepts it whole.
 *
 * @remarks
 * Two things are deliberately outside the digest: handler *bodies*
 * (functions are not canonical-JSON serialisable — `M3LProcedureBuildOptions.revision`
 * is the author's lever for that), and parameter *values* (`digest`
 * identifies the procedure; `parametersDigest` identifies the run's inputs).
 */
export interface M3LProcedureSummary {
  readonly name: string;
  readonly revision: string | undefined;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: M3LProcedureStepKind;
    readonly continueOnFailure: boolean;
    readonly jumpsTo: readonly string[];
    readonly loop: M3LProcedureLoop | undefined;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly description: string;
    readonly prose: string;
    readonly priority: number;
    /** Shape-erased: `M3LProcedureShape`'s own `stepId`/`caseId` are `string`. */
    readonly condition: M3LProcedureCondition<M3LProcedureShape>;
  }[];
  readonly fallback: { readonly description: string; readonly prose: string };
  readonly parameters: readonly string[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The default ceiling on step *executions* per `run()` call, used when
 * `M3LProcedureRunOptions.maxIterations` is absent. A `goTo` loop counts
 * every pass, not every distinct step.
 *
 * @example
 * ```ts
 * import { M3L_PROCEDURE_MAX_ITERATIONS } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_PROCEDURE_MAX_ITERATIONS); // 100
 * ```
 */
export const M3L_PROCEDURE_MAX_ITERATIONS = 100;

/**
 * The maximum nesting depth a {@link M3LProcedureCondition} tree, or a
 * {@link M3LProcedurePath} walk, may reach before the engine refuses to
 * recurse further.
 *
 * @example
 * ```ts
 * import { M3L_PROCEDURE_CONDITION_MAX_DEPTH } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_PROCEDURE_CONDITION_MAX_DEPTH); // 16
 * ```
 */
export const M3L_PROCEDURE_CONDITION_MAX_DEPTH = 16;

/**
 * The maximum length, in characters, a `matches` condition's `pattern`
 * source string may have. Enforced at `build()` time under
 * `ERR_PROCEDURE_INVALID_PATTERN`.
 *
 * @example
 * ```ts
 * import { M3L_PROCEDURE_MAX_PATTERN_LENGTH } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_PROCEDURE_MAX_PATTERN_LENGTH); // 512
 * ```
 */
export const M3L_PROCEDURE_MAX_PATTERN_LENGTH = 512;

/**
 * The maximum length, in characters, a `matches` condition's resolved
 * subject string may have before the engine refuses to scan it (the arm
 * evaluates `false` and the reference is marked `refused: "oversized"`, rather than
 * being scanned).
 *
 * @example
 * ```ts
 * import { M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH); // 8192
 * ```
 */
export const M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH = 8192;
