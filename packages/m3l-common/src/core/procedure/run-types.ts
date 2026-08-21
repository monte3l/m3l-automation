/**
 * `core/procedure/run-types` — options and outcome types for
 * {@link M3LProcedure.run}.
 *
 * Slice 3a scope: `M3LProcedureRunOptions` carries `deps`/`signal`/
 * `maxIterations`/`initialValues`/`parameters` only. The opt-in no-progress
 * guard (`progress`) and tracing (`trace`/`logger`) land in later slices
 * (3c/3b) as additive optional fields on this same base interface — nothing
 * here needs to change shape to admit them.
 *
 * `M3LProcedureOutcomeBase.trace` IS part of this slice's shape, always an
 * empty array until a later slice's tracer exists: `M3LProcedureOutcome` is
 * one discriminated union type a caller narrows on immediately, so every arm
 * needs the same base fields from the start rather than gaining one later.
 *
 * @packageDocumentation
 */

import type {
  M3LBreadcrumbScalar,
  M3LRunRecoveryEntry,
} from "../diagnostics/index.js";
import type { M3LOperationAbortedError } from "../errors/index.js";
import type {
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
} from "./build-types.js";
import type {
  M3LProcedureShape,
  M3LProcedureStepKind,
  M3LProcedureStepRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * Fields common to every {@link M3LProcedureRunOptions}, regardless of
 * whether `TShape["parameters"]` has any declared keys. Not part of the
 * public API on its own — {@link M3LProcedureRunOptions} is the exported type
 * consumers name.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
interface M3LProcedureRunOptionsBase<TShape extends M3LProcedureShape> {
  readonly deps: TShape["deps"];
  readonly signal?: AbortSignal;
  /** Ceiling on step *executions*. Defaults to `M3L_PROCEDURE_MAX_ITERATIONS`. */
  readonly maxIterations?: number;
  readonly initialValues?: Readonly<Partial<TShape["values"]>>;
}

/**
 * Options for {@link M3LProcedure.run}. `parameters` is conditionally
 * required — absent when `TShape["parameters"]` declares no keys (or every
 * declared key's value type is `never`, the `Record<string, never>` spelling
 * of "no parameters"), required otherwise.
 *
 * The predicate tests the map's **value** type, not its key type: testing
 * `[keyof TShape["parameters"]] extends [never]` looks equivalent and is
 * not — `keyof Record<string, never>` is `string`, so the most natural way to
 * write "this procedure takes no parameters" would land on the *required*
 * branch. Both `Record<string, never>` and `Record<never, never>` make
 * `parameters` optional under the value-type form used here.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: Record<string, never>;
 *   values: Record<string, never>;
 *   parameters: { threshold: number };
 *   conclusion: void;
 *   stepId: "gather";
 *   caseId: "quiet";
 * }
 *
 * const options: Core.M3LProcedureRunOptions<Triage> = {
 *   deps: {},
 *   parameters: { threshold: 5 },
 * };
 * ```
 */
export type M3LProcedureRunOptions<TShape extends M3LProcedureShape> =
  M3LProcedureRunOptionsBase<TShape> &
    ([TShape["parameters"][keyof TShape["parameters"]]] extends [never]
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
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function ran(telemetry: Core.M3LProcedureTelemetry<Core.M3LProcedureShape>): number {
 *   return telemetry.iterations;
 * }
 * ```
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
 * One `procedure:step` trace entry: the engine's own scalar keys plus a
 * step's `describeTrace` allowlist-projected return. Not yet populated in
 * this slice — {@link M3LProcedureOutcomeBase.trace} is always empty until a
 * later slice's opt-in tracer exists — but the shape is declared now because
 * `trace`'s element type must resolve for every consumer of
 * {@link M3LProcedureOutcome}, not only once tracing ships.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const entry: Core.M3LProcedureTraceEntry = {
 *   stepId: "gather",
 *   label: "Gather",
 *   kind: "gather",
 *   attempt: 1,
 *   durationMs: 12,
 *   failed: false,
 *   flow: "continue",
 *   payload: {},
 * };
 * ```
 */
export interface M3LProcedureTraceEntry {
  readonly stepId: string;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  readonly attempt: number;
  readonly durationMs: number;
  readonly failed: boolean;
  /**
   * The flow directive, projected to a scalar per `docs/reference/core/procedure.md`
   * § Tracing: `"continue"`, `"stop"`, `"resolve"`, or the string `goTo:` followed
   * by the jump's target step id. `undefined` when the step threw. Closed to this
   * set — matching `M3LProcedureFlow`'s own closed set, with the `goTo` arm's
   * object shape flattened to a template-literal string since a structured
   * payload would silently vanish from a breadcrumb sink that drops non-scalars.
   */
  readonly flow: "continue" | "stop" | "resolve" | `goTo:${string}` | undefined;
  readonly payload: Readonly<Record<string, M3LBreadcrumbScalar>>;
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
  /**
   * The allowlisted per-step trace, in execution order. Empty in this slice
   * — no tracer exists yet, so there is nothing to retain.
   */
  readonly trace: readonly M3LProcedureTraceEntry[];
  readonly telemetry: M3LProcedureTelemetry<TShape>;
}

/**
 * The resolved result of {@link M3LProcedure.run}. `run()` resolves for all
 * four arms — only a contract violation (a malformed `run` option) throws.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @remarks
 * `alsoMatched: readonly []` appears on three arms rather than being
 * omitted, so a caller can read `outcome.alsoMatched.length` without
 * narrowing first.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function verdict(outcome: Core.M3LProcedureOutcome<Core.M3LProcedureShape>): string {
 *   return outcome.status;
 * }
 * ```
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
