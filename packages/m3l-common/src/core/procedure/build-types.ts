/**
 * `core/procedure/build-types` — the case, fallback, build-option,
 * validation-problem, and definition-digest types
 * {@link M3LProcedureBuilder.build} consumes and produces.
 *
 * Split out of `types.ts` (slice 1) purely to stay under the per-file byte
 * ceiling (`check:file-budget`) — there is no behavioral boundary between the
 * two files, and both are re-exported together from the `core/procedure`
 * barrel.
 *
 * @packageDocumentation
 */

import type {
  M3LProcedureCondition,
  M3LProcedureConditionEvaluation,
  M3LProcedureShape,
  M3LProcedureStepKind,
} from "./types.js";
import type { M3LProcedureContext, M3LProcedureLoop } from "./step-types.js";

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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: Record<string, never>;
 *   values: { errorCount: number };
 *   parameters: Record<string, never>;
 *   conclusion: { readonly verdict: string };
 *   stepId: "count-errors";
 *   caseId: "quiet";
 * }
 *
 * const quiet: Core.M3LProcedureCase<Triage, "quiet"> = {
 *   id: "quiet",
 *   description: "no errors observed",
 *   prose: "The log window was quiet.",
 *   priority: 1,
 *   condition: {
 *     kind: "compare",
 *     left: { source: "value", key: "errorCount" },
 *     operator: "==",
 *     right: { source: "literal", literal: 0 },
 *   },
 *   action: () => ({ verdict: "quiet" }),
 * };
 * ```
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const fallback: Core.M3LProcedureFallback<Core.M3LProcedureShape> = {
 *   description: "no case matched",
 *   prose: "Unrecognized pattern. Investigate.",
 *   action: () => undefined,
 * };
 * ```
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const options: Core.M3LProcedureBuildOptions = { revision: "r1" };
 * ```
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const problem: Core.M3LProcedureValidationProblem = {
 *   code: "ERR_PROCEDURE_EMPTY_STEPS",
 *   message: "M3LProcedure: build() requires at least one declared step",
 * };
 * ```
 */
export interface M3LProcedureValidationProblem {
  readonly code: M3LProcedureProblemCode;
  readonly message: string;
  readonly stepId?: string;
  readonly caseId?: string;
  /** For `ERR_PROCEDURE_CYCLE_DETECTED`: the cycle, first node repeated last. */
  readonly path?: readonly string[];
  /**
   * For `ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY` only: every colliding case id
   * (`caseId` alone can only hold one). Additive — every other code keeps
   * using `caseId`.
   */
  readonly caseIds?: readonly string[];
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
 * (functions are not canonical-JSON serialisable —
 * `M3LProcedureBuildOptions.revision` is the author's lever for that), and
 * parameter *values* (`digest` identifies the procedure; `parametersDigest`
 * identifies the run's inputs).
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function isNamed(summary: Core.M3LProcedureSummary, name: string): boolean {
 *   return summary.name === name;
 * }
 * ```
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
