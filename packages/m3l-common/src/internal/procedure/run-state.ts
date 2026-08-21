/**
 * `internal/procedure/run-state` — pure type declarations shared across the
 * run-loop implementation modules (`flow.ts`, `step-exec.ts`, `guards.ts`,
 * `outcome.ts`, `run-loop.ts`, `run.ts`). No runtime code lives here.
 *
 * `ProcedureRuntime<TShape>` is the frozen record `M3LProcedure`'s
 * constructor builds once from a built definition's `steps`/`cases`/
 * `fallback` — every free function in the sibling modules takes it as an
 * explicit parameter instead of reading `this.#field` off a class instance,
 * which is what makes those modules plain, testable functions rather than
 * private methods.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import type { M3LOperationAbortedError } from "../../core/errors/index.js";
import type {
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureFallback,
} from "../../core/procedure/build-types.js";
import type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type {
  M3LProcedureShape,
  M3LProcedureStepRecord,
} from "../../core/procedure/types.js";

/**
 * The frozen, per-instance runtime record `M3LProcedure`'s constructor builds
 * once from a built definition: the declared steps (in execution order), the
 * cases (sorted once, descending by `priority`), the mandatory fallback, and
 * a step-id-to-index lookup. Immutable after construction and therefore
 * shared safely across concurrent `run()` calls.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface ProcedureRuntime<TShape extends M3LProcedureShape> {
  readonly steps: readonly M3LProcedureStep<
    TShape,
    TShape["stepId"],
    TShape["stepId"]
  >[];
  readonly cases: readonly M3LProcedureCase<TShape, TShape["caseId"]>[];
  readonly fallback: M3LProcedureFallback<TShape>;
  readonly stepIndexById: ReadonlyMap<string, number>;
}

/** One case, paired with the evaluation its `condition` produced this pass. */
export interface CaseEvaluationPair<TShape extends M3LProcedureShape> {
  readonly caseEntry: M3LProcedureCase<TShape, TShape["caseId"]>;
  readonly evaluation: M3LProcedureCaseEvaluation<TShape>;
}

/**
 * The result of one full, no-short-circuit pass over every declared case:
 * every evaluation (for `investigated`/telemetry), every match in descending
 * priority (for `alsoMatched`), and the highest-priority matched case's own
 * declaration (so its `action` can be invoked without a second lookup).
 */
export interface CasesPass<TShape extends M3LProcedureShape> {
  readonly evaluations: readonly M3LProcedureCaseEvaluation<TShape>[];
  readonly matches: readonly M3LProcedureCaseMatch<TShape>[];
  readonly primaryCase: M3LProcedureCase<TShape, TShape["caseId"]> | undefined;
}

/**
 * What phase 1 accumulated by the time it stopped, regardless of how — the
 * run loop builds this from its own local bindings and returns it (never
 * mutating a shared object other helpers hold), so every downstream
 * assembler reads it as plain data.
 */
export interface PhaseOneAccumulated<TShape extends M3LProcedureShape> {
  readonly context: M3LProcedureContext<TShape>;
  readonly executedSteps: readonly M3LProcedureStepRecord[];
  readonly resolveChecks: number;
}

/** How phase 1 (the step loop) concluded. */
export type PhaseOneOutcome<TShape extends M3LProcedureShape> =
  PhaseOneAccumulated<TShape> &
    (
      | { readonly kind: "ended" }
      | { readonly kind: "matched"; readonly pass: CasesPass<TShape> }
      | {
          readonly kind: "failed";
          /**
           * The step that failed, or `undefined` for the overall iteration
           * ceiling — a whole-run guard not attributable to any one step's
           * own behavior. A step's own revisit-ceiling trip and an unabsorbed
           * `execute` throw both still name a real step id.
           */
          readonly stepId: TShape["stepId"] | undefined;
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
 * context/record it produced, an engine-synthesized retry, or an unabsorbed
 * failure. Pure — the caller folds these into its own local
 * `context`/`executedSteps`, nothing here mutates a parameter.
 *
 * `"retry"` is distinct from `"advanced"` on purpose: it is produced only for
 * a step that declares `loop` and just absorbed a `continueOnFailure` throw.
 * It carries no `flow` — unlike a genuine advance, there was never a
 * caller-returned directive to interpret, so it must never be routed through
 * `flow.ts`'s flow interpretation and validated against the declaring step's
 * own `jumpsTo` allowlist.
 */
export type StepExecutionOutcome<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "advanced";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
      readonly flow: M3LProcedureFlow<string>;
    }
  | {
      readonly kind: "retry";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
    }
  | {
      readonly kind: "failed";
      /**
       * The step that failed, or `undefined` for the overall iteration
       * ceiling — see {@link PhaseOneOutcome}'s `"failed"` arm for the same
       * distinction.
       */
      readonly stepId: TShape["stepId"] | undefined;
      readonly error: unknown;
    }
  | {
      readonly kind: "aborted";
      readonly error: M3LOperationAbortedError;
    };

/**
 * A step-boundary guard's failure: shared by every place phase 1 can end a
 * run without a step's own flow directive deciding it — the pre-step guard,
 * a step's own execution outcome folded into a "return now", and the
 * post-advance guard.
 */
export type StepGuardFailure<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "aborted";
      readonly abortedAt: TShape["stepId"] | undefined;
      readonly error: M3LOperationAbortedError;
    }
  | Extract<StepExecutionOutcome<TShape>, { kind: "failed" }>;

/**
 * What folding one step's {@link StepExecutionOutcome} decided: either the
 * loop must return this outcome now (a failure or an abort, neither of which
 * advances phase 1's state), or the step genuinely advanced (`"advanced"`,
 * carrying the flow directive to interpret), or an engine-synthesized retry
 * occurred (`"retry"`, carrying no flow) — for either of the latter two, the
 * caller folds `context`/`record` into its own local state.
 */
export type FoldedStepExecution<TShape extends M3LProcedureShape> =
  | { readonly kind: "return"; readonly result: StepGuardFailure<TShape> }
  | {
      readonly kind: "advanced";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
      readonly flow: M3LProcedureFlow<string>;
    }
  | {
      readonly kind: "retry";
      readonly context: M3LProcedureContext<TShape>;
      readonly record: M3LProcedureStepRecord;
    };

/**
 * What resolving a step's flow decided after it advanced and the flow was
 * classified: either the loop must return this outcome now (an abort, an
 * ordinary end, or an early match), or it should keep looping from `index`.
 */
export type FlowResolution<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "return";
      readonly result:
        | StepGuardFailure<TShape>
        | { readonly kind: "ended" }
        | { readonly kind: "matched"; readonly pass: CasesPass<TShape> };
    }
  | { readonly kind: "continue"; readonly index: number };

/**
 * What resolving the post-advance guard decided, bundling the updated
 * `resolveChecks` alongside either the outcome the run loop should return
 * now, or the next `index` to keep looping from.
 */
export type PostAdvanceResolution<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "return";
      readonly resolveChecks: number;
      readonly result: Extract<
        FlowResolution<TShape>,
        { kind: "return" }
      >["result"];
    }
  | {
      readonly kind: "continue";
      readonly resolveChecks: number;
      readonly index: number;
    };

/**
 * How `flow.ts`'s `interpretFlow` resolved one step's directive: pure,
 * returning the updated `resolveChecks` rather than mutating a shared
 * counter. `"failed"` is the one arm that isn't a genuine advance — either a
 * malformed flow directive, or a `{ goTo }` naming a target that either isn't
 * a declared step id, or is declared but absent from the declaring step's own
 * `jumpsTo` allowlist (`ERR_PROCEDURE_UNDECLARED_JUMP`).
 */
export type FlowDecision<TShape extends M3LProcedureShape> =
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
    }
  | {
      readonly kind: "failed";
      readonly stepId: TShape["stepId"];
      readonly error: unknown;
      readonly resolveChecks: number;
    };
