/**
 * Core `procedure` submodule — the codified-procedure engine: a multi-step
 * procedure whose control flow and conclusions are data rather than
 * hand-written branching.
 *
 * Surfaces exactly the documented public API. No error class is exported —
 * callers narrow on `instanceof M3LError` and the machine-readable `code`,
 * never on a subclass identity, the same rule `core/pipeline` follows.
 *
 * @packageDocumentation
 */

export { evaluateProcedureCondition } from "./conditions.js";
export { M3LProcedure } from "./M3LProcedure.js";
export {
  createProcedureBuilder,
  M3LProcedureBuilder,
} from "./M3LProcedureBuilder.js";
export type {
  M3LProcedureBuildOptions,
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureCompareOperator,
  M3LProcedureCondition,
  M3LProcedureConditionEvaluation,
  M3LProcedureConditionKind,
  M3LProcedureConditionScope,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureFlow,
  M3LProcedureLoop,
  M3LProcedureOutcome,
  M3LProcedureOutcomeBase,
  M3LProcedurePath,
  M3LProcedureProblemCode,
  M3LProcedureProgressOptions,
  M3LProcedureProgressWitness,
  M3LProcedureReference,
  M3LProcedureResolvedReference,
  M3LProcedureRunOptions,
  M3LProcedureScalar,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureStepKind,
  M3LProcedureStepRecord,
  M3LProcedureStepResult,
  M3LProcedureSummary,
  M3LProcedureTelemetry,
  M3LProcedureTraceEntry,
  M3LProcedureTraceOptions,
  M3LProcedureTraceSink,
  M3LProcedureValidationProblem,
  M3LProcedureValue,
  M3LProcedureValueMap,
} from "./types.js";
export {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_ITERATIONS,
  M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "./types.js";
