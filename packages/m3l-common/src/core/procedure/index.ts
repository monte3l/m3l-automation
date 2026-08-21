/**
 * `core/procedure` — the codified-procedure engine (ADR-0046).
 *
 * This barrel surfaces the condition-evaluation subset (slice 1), the
 * builder and build-time validation surface (slice 2a), {@link M3LProcedure.run}
 * (slice 3a) — the option/outcome/telemetry type family — and, as of slice
 * 3b, opt-in tracing (`options.trace`/`options.logger`). The no-progress
 * guard (`options.progress`) lands in a later slice as an additive field on
 * {@link M3LProcedureRunOptions}.
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
  M3L_PROCEDURE_MAX_ITERATIONS,
  M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "./types.js";
export type {
  M3LProcedureOutcome,
  M3LProcedureOutcomeBase,
  M3LProcedureRunOptions,
  M3LProcedureTelemetry,
  M3LProcedureTraceEntry,
  M3LProcedureTraceOptions,
  M3LProcedureTraceSink,
} from "./run-types.js";
