/**
 * `core/procedure` — the codified-procedure engine (ADR-0046).
 *
 * This barrel now surfaces the condition-evaluation subset (slice 1) plus
 * the builder and build-time validation surface (slice 2a):
 * {@link createProcedureBuilder}, {@link M3LProcedureBuilder},
 * {@link M3LProcedure} (constructor + `digest` + `describe()` only), the
 * step/case/fallback/build-option/validation-problem/summary type family,
 * and {@link evaluateProcedureCondition} with the `M3LProcedureCondition`
 * type family and related limit constants. `M3LProcedure.run()` and its
 * outcome/tracing types land in a later slice.
 *
 * @packageDocumentation
 */

export { evaluateProcedureCondition } from "./conditions.js";
export { M3LProcedure } from "./M3LProcedure.js";
export { createProcedureBuilder } from "./M3LProcedureBuilder.js";
export type { M3LProcedureBuilder } from "./M3LProcedureBuilder.js";
export type {
  M3LProcedureBuildOptions,
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureFallback,
  M3LProcedureProblemCode,
  M3LProcedureSummary,
  M3LProcedureValidationProblem,
} from "./build-types.js";
export type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureLoop,
  M3LProcedureStep,
  M3LProcedureStepResult,
} from "./step-types.js";
export type {
  M3LProcedureCompareOperator,
  M3LProcedureCondition,
  M3LProcedureConditionEvaluation,
  M3LProcedureConditionKind,
  M3LProcedureConditionScope,
  M3LProcedurePath,
  M3LProcedureReference,
  M3LProcedureResolvedReference,
  M3LProcedureScalar,
  M3LProcedureShape,
  M3LProcedureStepKind,
  M3LProcedureStepRecord,
  M3LProcedureValue,
  M3LProcedureValueMap,
} from "./types.js";
export {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "./types.js";
