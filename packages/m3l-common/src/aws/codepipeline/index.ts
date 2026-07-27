/**
 * `aws/codepipeline` — typed wrapper over the raw
 * `@aws-sdk/client-codepipeline` `CodePipelineClient`, so callers never
 * import SDK command classes directly. Scoped to pipeline listing/
 * description, the pipeline declaration model, execution control, and stage
 * transitions; see `docs/reference/aws/codepipeline.md`.
 *
 * @packageDocumentation
 */

export {
  M3LCodePipelineOperations,
  type M3LCodePipelineGetPipelineOptions,
  type M3LCodePipelineListExecutionsOptions,
  type M3LCodePipelineListPipelinesOptions,
  type M3LCodePipelineStartExecutionOptions,
} from "./client.js";
export { M3LCodePipelineOperationError } from "./error.js";
export type {
  M3LCodePipelineActionDeclaration,
  M3LCodePipelineActionExecution,
  M3LCodePipelineActionState,
  M3LCodePipelineActionTypeId,
  M3LCodePipelineArtifactStore,
  M3LCodePipelineCreatePipelineInput,
  M3LCodePipelineDeclaration,
  M3LCodePipelineDefinition,
  M3LCodePipelineDisableStageTransitionInput,
  M3LCodePipelineEnableStageTransitionInput,
  M3LCodePipelineEncryptionKey,
  M3LCodePipelineExecution,
  M3LCodePipelineExecutionSummary,
  M3LCodePipelineExecutionTrigger,
  M3LCodePipelineListExecutionsResult,
  M3LCodePipelineListPipelinesResult,
  M3LCodePipelineMetadata,
  M3LCodePipelineStageDeclaration,
  M3LCodePipelineStageExecution,
  M3LCodePipelineStageState,
  M3LCodePipelineStageTransitionType,
  M3LCodePipelineStartExecutionResult,
  M3LCodePipelineState,
  M3LCodePipelineStopExecutionInput,
  M3LCodePipelineStopExecutionResult,
  M3LCodePipelineSummary,
  M3LCodePipelineTag,
  M3LCodePipelineTransitionState,
  M3LCodePipelineVariableDeclaration,
} from "./types.js";
