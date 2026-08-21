/**
 * `core/procedure` — the codified-procedure engine (ADR-0046).
 *
 * This barrel currently surfaces only the condition-evaluation subset:
 * {@link evaluateProcedureCondition}, the `M3LProcedureCondition` type
 * family, and the related limit constants. The step/case builder, the
 * `M3LProcedure` runner, and the outcome/tracing types land in later slices.
 *
 * @packageDocumentation
 */

export { evaluateProcedureCondition } from "./conditions.js";
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
