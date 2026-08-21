/**
 * `core/procedure/step-types` — the step, flow, step-result, and context
 * types a caller-declared step and its `execute` closure are built from.
 *
 * Split out of `types.ts` (slice 1) purely to stay under the per-file byte
 * ceiling (`check:file-budget`) — there is no behavioral boundary between the
 * two files, and both are re-exported together from the `core/procedure`
 * barrel.
 *
 * @packageDocumentation
 */

import type {
  M3LBreadcrumbScalar,
  M3LRunRecoveryEntry,
} from "../diagnostics/index.js";
import type {
  M3LProcedureShape,
  M3LProcedureStepKind,
  M3LProcedureStepRecord,
  M3LProcedureValue,
} from "./types.js";

/**
 * Acknowledges that a step's own back edges (a `jumpsTo` entry naming itself
 * or an earlier step) are deliberate, not an accidental cycle. Edges out of a
 * step carrying `loop` are excluded from build-time cycle detection; the
 * engine enforces `maxRevisits` at run time instead.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const loop: Core.M3LProcedureLoop = { reason: "retry until quiet", maxRevisits: 3 };
 * ```
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function execute(): Core.M3LProcedureStepResult<Core.M3LProcedureShape> {
 *   return { flow: "continue", output: 3 };
 * }
 * ```
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: Record<string, never>;
 *   values: Record<string, never>;
 *   parameters: Record<string, never>;
 *   conclusion: void;
 *   stepId: "gather";
 *   caseId: "quiet";
 * }
 *
 * const gather: Core.M3LProcedureStep<Triage, "gather"> = {
 *   id: "gather",
 *   label: "gather evidence",
 *   kind: "gather",
 *   execute: () => ({ flow: "continue" }),
 * };
 * ```
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

/**
 * The immutable, copy-on-write context a step receives. A step returns a
 * _patch_, never a context — the engine derives the next frozen context at
 * exactly one call site, so a step cannot mutate or forge one.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function readCount(context: Core.M3LProcedureContext<Core.M3LProcedureShape>): number {
 *   return context.iteration;
 * }
 * ```
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
