/**
 * `core/procedure/types` — the public shape, step, condition, case, run,
 * outcome, tracing, and validation types consumed and produced by
 * {@link M3LProcedure} and {@link M3LProcedureBuilder}.
 *
 * This file currently ships only the condition-evaluation type family
 * (`M3LProcedureShape`, references, and the `M3LProcedureCondition` tree and
 * its evaluation types) — later slices add the step, case, build, run, and
 * outcome types to this same file.
 *
 * @packageDocumentation
 */

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
// Limits
// ---------------------------------------------------------------------------

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
