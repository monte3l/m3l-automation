/**
 * Core `pipeline` submodule — the declarative multi-operation dispatcher
 * engine.
 *
 * Surfaces exactly the documented public API: the {@link
 * M3LOperationPipeline} engine and its option/dependency/outcome types. No
 * error class is exported — guard and configuration failures throw `M3LError`
 * with the caller-supplied `configCode`, and the construction-time
 * `ERR_PIPELINE_INVALID_OPTION` subclass stays internal.
 *
 * @packageDocumentation
 */

export { M3LOperationPipeline } from "./M3LOperationPipeline.js";
export type {
  M3LGuardableKey,
  M3LOperationHandlers,
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
  M3LOperationPipelineOutcome,
  M3LOperationPipelineOutcomeBase,
  M3LPipelineDeclinePolicy,
  M3LPipelineDestructiveOptions,
  M3LPipelinePhase,
  M3LPipelineTraceOptions,
  M3LPipelineTraceSink,
  M3LPipelineTraceSnapshot,
} from "./types.js";
