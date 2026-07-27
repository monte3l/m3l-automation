/**
 * `aws/codepipeline/client` — {@link M3LCodePipelineOperations}, a typed
 * wrapper over a raw `CodePipelineClient` so callers never import
 * `@aws-sdk/client-codepipeline` command classes directly. Scoped to pipeline
 * listing/description, the pipeline declaration model, execution control, and
 * stage transitions — CodePipeline ships no package-level waiter, so this
 * module has no `waitUntil*` method (see
 * `docs/reference/aws/codepipeline.md`).
 *
 * SCAFFOLD STATUS: every method below is a signature-only placeholder that
 * rejects with `M3LCodePipelineOperationError("... not yet implemented")`.
 * `implementing-submodules` turns these GREEN against the settled contract in
 * `docs/reference/aws/codepipeline.md`.
 *
 * @packageDocumentation
 */

import type {
  ActionCategory,
  ActionDeclaration,
  ActionExecution,
  ActionOwner,
  ActionState,
  ActionTypeId,
  ArtifactStore,
  ArtifactStoreType,
  CodePipelineClient,
  EncryptionKey,
  EncryptionKeyType,
  ExecutionMode,
  ExecutionTrigger,
  GetPipelineStateOutput,
  InputArtifact,
  OutputArtifact,
  PipelineDeclaration,
  PipelineExecution,
  PipelineExecutionSummary,
  PipelineMetadata,
  PipelineSummary,
  PipelineType,
  PipelineVariableDeclaration,
  StageDeclaration,
  StageExecution,
  StageState,
  Tag,
  TransitionState,
} from "@aws-sdk/client-codepipeline";
import {
  CreatePipelineCommand,
  DeletePipelineCommand,
  DisableStageTransitionCommand,
  EnableStageTransitionCommand,
  GetPipelineCommand,
  GetPipelineExecutionCommand,
  GetPipelineStateCommand,
  ListPipelineExecutionsCommand,
  ListPipelinesCommand,
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
  UpdatePipelineCommand,
} from "@aws-sdk/client-codepipeline";

import { M3LCodePipelineOperationError } from "./error.js";
import type {
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
  M3LCodePipelineStartExecutionResult,
  M3LCodePipelineState,
  M3LCodePipelineStopExecutionInput,
  M3LCodePipelineStopExecutionResult,
  M3LCodePipelineSummary,
  M3LCodePipelineTag,
  M3LCodePipelineTransitionState,
  M3LCodePipelineVariableDeclaration,
} from "./types.js";

// ---------------------------------------------------------------------------
// Declaration model — read direction (SDK `PipelineDeclaration`-shaped
// object -> plain M3LCodePipelineDeclaration). See
// docs/reference/aws/codepipeline.md's "The pipeline declaration is a lossy
// round-trip" section.
// ---------------------------------------------------------------------------

/**
 * Translates an SDK `ActionTypeId`-shaped object into the plain
 * {@link M3LCodePipelineActionTypeId}. Every field defaults to `""` when the
 * SDK omits it, following the required-nullable-string convention (the SDK
 * types every field of this interface as optional even though CodePipeline
 * requires all four on a valid action).
 *
 * @param actionTypeId - The SDK's `ActionTypeId`-shaped object, or
 *   `undefined` when the SDK omits the whole `actionTypeId` on an action.
 * @returns The plain, library-owned action-type-id shape.
 */
function mapActionTypeId(
  actionTypeId: ActionTypeId | undefined,
): M3LCodePipelineActionTypeId {
  return {
    category: actionTypeId?.category ?? "",
    owner: actionTypeId?.owner ?? "",
    provider: actionTypeId?.provider ?? "",
    version: actionTypeId?.version ?? "",
  };
}

/**
 * Translates an SDK `EncryptionKey`-shaped object into the plain
 * {@link M3LCodePipelineEncryptionKey}, both fields defaulted to `""` when
 * the SDK omits either half.
 *
 * @param key - The SDK's `EncryptionKey`-shaped object.
 * @returns The plain, library-owned encryption-key shape.
 */
function mapEncryptionKey(key: EncryptionKey): M3LCodePipelineEncryptionKey {
  return {
    id: key.id ?? "",
    type: key.type ?? "",
  };
}

/**
 * Translates an SDK `ArtifactStore`-shaped object into the plain
 * {@link M3LCodePipelineArtifactStore}. `type`/`location` default to `""`
 * when the SDK omits them; `encryptionKey` is included only when the SDK
 * response defines it.
 *
 * @param artifactStore - The SDK's `ArtifactStore`-shaped object.
 * @returns The plain, library-owned artifact-store shape.
 */
function mapArtifactStore(
  artifactStore: ArtifactStore,
): M3LCodePipelineArtifactStore {
  return {
    type: artifactStore.type ?? "",
    location: artifactStore.location ?? "",
    ...(artifactStore.encryptionKey !== undefined && {
      encryptionKey: mapEncryptionKey(artifactStore.encryptionKey),
    }),
  };
}

/**
 * Translates an SDK `PipelineVariableDeclaration`-shaped object into the
 * plain {@link M3LCodePipelineVariableDeclaration}. `name` defaults to `""`
 * when the SDK omits it; `defaultValue`/`description` are included only when
 * the SDK response defines them.
 *
 * @param variable - The SDK's `PipelineVariableDeclaration`-shaped object.
 * @returns The plain, library-owned variable-declaration shape.
 */
function mapVariableDeclaration(
  variable: PipelineVariableDeclaration,
): M3LCodePipelineVariableDeclaration {
  return {
    name: variable.name ?? "",
    ...(variable.defaultValue !== undefined && {
      defaultValue: variable.defaultValue,
    }),
    ...(variable.description !== undefined && {
      description: variable.description,
    }),
  };
}

/**
 * The `name`/`actionTypeId`/`runOrder`/`configuration` subset of
 * {@link M3LCodePipelineActionDeclaration}, each optional field included only
 * when the SDK response defines it. Split out of {@link mapActionDeclaration}
 * to keep that function's cyclomatic complexity within the lint budget.
 *
 * @param action - The SDK's `ActionDeclaration`-shaped object.
 * @returns The core-field subset of the plain action-declaration shape.
 */
function mapActionDeclarationCore(
  action: ActionDeclaration,
): Pick<
  M3LCodePipelineActionDeclaration,
  "actionTypeId" | "configuration" | "name" | "runOrder"
> {
  return {
    name: action.name ?? "",
    actionTypeId: mapActionTypeId(action.actionTypeId),
    ...(action.runOrder !== undefined && { runOrder: action.runOrder }),
    ...(action.configuration !== undefined && {
      configuration: action.configuration,
    }),
  };
}

/**
 * The `inputArtifacts`/`outputArtifacts` subset of
 * {@link M3LCodePipelineActionDeclaration}, collapsing the SDK's `{ name }[]`
 * wrapper objects down to plain `readonly string[]`. Split out of
 * {@link mapActionDeclaration} to keep that function's cyclomatic complexity
 * within the lint budget.
 *
 * @param action - The SDK's `ActionDeclaration`-shaped object.
 * @returns The artifact-field subset of the plain action-declaration shape.
 */
function mapActionDeclarationArtifacts(
  action: ActionDeclaration,
): Pick<
  M3LCodePipelineActionDeclaration,
  "inputArtifacts" | "outputArtifacts"
> {
  return {
    ...(action.inputArtifacts !== undefined && {
      inputArtifacts: action.inputArtifacts.map(
        (artifact) => artifact.name ?? "",
      ),
    }),
    ...(action.outputArtifacts !== undefined && {
      outputArtifacts: action.outputArtifacts.map(
        (artifact) => artifact.name ?? "",
      ),
    }),
  };
}

/**
 * The `roleArn`/`region`/`namespace`/`timeoutInMinutes` subset of
 * {@link M3LCodePipelineActionDeclaration}, each included only when the SDK
 * response defines it. Split out of {@link mapActionDeclaration} to keep that
 * function's cyclomatic complexity within the lint budget.
 *
 * @param action - The SDK's `ActionDeclaration`-shaped object.
 * @returns The detail-field subset of the plain action-declaration shape.
 */
function mapActionDeclarationDetail(
  action: ActionDeclaration,
): Pick<
  M3LCodePipelineActionDeclaration,
  "namespace" | "region" | "roleArn" | "timeoutInMinutes"
> {
  return {
    ...(action.roleArn !== undefined && { roleArn: action.roleArn }),
    ...(action.region !== undefined && { region: action.region }),
    ...(action.namespace !== undefined && { namespace: action.namespace }),
    ...(action.timeoutInMinutes !== undefined && {
      timeoutInMinutes: action.timeoutInMinutes,
    }),
  };
}

/**
 * Translates an SDK `ActionDeclaration`-shaped object into the plain
 * {@link M3LCodePipelineActionDeclaration}.
 *
 * @param action - The SDK's `ActionDeclaration`-shaped object.
 * @returns The plain, library-owned action-declaration shape.
 */
function mapActionDeclaration(
  action: ActionDeclaration,
): M3LCodePipelineActionDeclaration {
  return {
    ...mapActionDeclarationCore(action),
    ...mapActionDeclarationArtifacts(action),
    ...mapActionDeclarationDetail(action),
  };
}

/**
 * Translates an SDK `StageDeclaration`-shaped object into the plain
 * {@link M3LCodePipelineStageDeclaration}. `name` defaults to `""` when the
 * SDK omits it; `actions` is always an array (`[]` when the SDK omits it).
 *
 * @param stage - The SDK's `StageDeclaration`-shaped object.
 * @returns The plain, library-owned stage-declaration shape.
 */
function mapStageDeclaration(
  stage: StageDeclaration,
): M3LCodePipelineStageDeclaration {
  return {
    name: stage.name ?? "",
    actions: (stage.actions ?? []).map(mapActionDeclaration),
  };
}

/**
 * The `artifactStore`/`version`/`pipelineType`/`executionMode`/`variables`
 * subset of {@link M3LCodePipelineDeclaration}, each included only when the
 * SDK response defines it. Split out of {@link mapDeclaration} to keep that
 * function's cyclomatic complexity within the lint budget.
 *
 * @param pipeline - The SDK's `PipelineDeclaration`-shaped object.
 * @returns The optional-field subset of the plain declaration shape.
 */
function mapDeclarationOptionalFields(
  pipeline: PipelineDeclaration,
): Omit<M3LCodePipelineDeclaration, "name" | "roleArn" | "stages"> {
  return {
    ...(pipeline.artifactStore !== undefined && {
      artifactStore: mapArtifactStore(pipeline.artifactStore),
    }),
    ...(pipeline.version !== undefined && { version: pipeline.version }),
    ...(pipeline.pipelineType !== undefined && {
      pipelineType: pipeline.pipelineType,
    }),
    ...(pipeline.executionMode !== undefined && {
      executionMode: pipeline.executionMode,
    }),
    ...(pipeline.variables !== undefined && {
      variables: pipeline.variables.map(mapVariableDeclaration),
    }),
  };
}

/**
 * Translates an SDK `PipelineDeclaration`-shaped object into the plain
 * {@link M3LCodePipelineDeclaration}. `name`/`roleArn` default to `""` when
 * the SDK omits them (the read-path bidirectional-optionality note — see the
 * spec page); `stages` is always an array (`[]` when the SDK omits it); every
 * other field is included only when the SDK response defines it.
 *
 * @param pipeline - The SDK's `PipelineDeclaration`-shaped object.
 * @returns The plain, library-owned declaration shape.
 */
function mapDeclaration(
  pipeline: PipelineDeclaration,
): M3LCodePipelineDeclaration {
  return {
    name: pipeline.name ?? "",
    roleArn: pipeline.roleArn ?? "",
    stages: (pipeline.stages ?? []).map(mapStageDeclaration),
    ...mapDeclarationOptionalFields(pipeline),
  };
}

/**
 * Translates an SDK `PipelineMetadata`-shaped object into the plain
 * {@link M3LCodePipelineMetadata}, every field included only when the SDK
 * response defines it.
 *
 * @param metadata - The SDK's `PipelineMetadata`-shaped object.
 * @returns The plain, library-owned metadata shape.
 */
function mapMetadata(metadata: PipelineMetadata): M3LCodePipelineMetadata {
  return {
    ...(metadata.pipelineArn !== undefined && {
      pipelineArn: metadata.pipelineArn,
    }),
    ...(metadata.created !== undefined && {
      created: metadata.created.toISOString(),
    }),
    ...(metadata.updated !== undefined && {
      updated: metadata.updated.toISOString(),
    }),
    ...(metadata.pollingDisabledAt !== undefined && {
      pollingDisabledAt: metadata.pollingDisabledAt.toISOString(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Declaration model — write direction (plain M3LCodePipelineDeclaration ->
// SDK `PipelineDeclaration`-shaped object), used by createPipeline/
// updatePipeline.
// ---------------------------------------------------------------------------

/**
 * Builds an SDK `ActionTypeId`-shaped object from the plain
 * {@link M3LCodePipelineActionTypeId}. `category`/`owner` are cast to the
 * SDK's closed enums — this module's read-path rule keeps them plain
 * `string` (see the spec page's enum-asymmetry note), so a caller-supplied
 * value that isn't a real category/owner surfaces as a `ValidationException`
 * from CodePipeline rather than a compile error here.
 *
 * @param actionTypeId - The caller's plain action-type-id shape.
 * @returns The SDK command-input `ActionTypeId` shape.
 */
function buildActionTypeId(
  actionTypeId: M3LCodePipelineActionTypeId,
): ActionTypeId {
  return {
    category: actionTypeId.category as ActionCategory,
    owner: actionTypeId.owner as ActionOwner,
    provider: actionTypeId.provider,
    version: actionTypeId.version,
  };
}

/**
 * Builds an SDK `EncryptionKey`-shaped object from the plain
 * {@link M3LCodePipelineEncryptionKey}.
 *
 * @param key - The caller's plain encryption-key shape.
 * @returns The SDK command-input `EncryptionKey` shape.
 */
function buildEncryptionKey(key: M3LCodePipelineEncryptionKey): EncryptionKey {
  return {
    id: key.id,
    type: key.type as EncryptionKeyType,
  };
}

/**
 * Builds an SDK `ArtifactStore`-shaped object from the plain
 * {@link M3LCodePipelineArtifactStore}.
 *
 * @param artifactStore - The caller's plain artifact-store shape.
 * @returns The SDK command-input `ArtifactStore` shape.
 */
function buildArtifactStore(
  artifactStore: M3LCodePipelineArtifactStore,
): ArtifactStore {
  return {
    type: artifactStore.type as ArtifactStoreType,
    location: artifactStore.location,
    ...(artifactStore.encryptionKey !== undefined && {
      encryptionKey: buildEncryptionKey(artifactStore.encryptionKey),
    }),
  };
}

/**
 * Builds an SDK `PipelineVariableDeclaration`-shaped object from the plain
 * {@link M3LCodePipelineVariableDeclaration}.
 *
 * @param variable - The caller's plain variable-declaration shape.
 * @returns The SDK command-input `PipelineVariableDeclaration` shape.
 */
function buildVariableDeclaration(
  variable: M3LCodePipelineVariableDeclaration,
): PipelineVariableDeclaration {
  return {
    name: variable.name,
    ...(variable.defaultValue !== undefined && {
      defaultValue: variable.defaultValue,
    }),
    ...(variable.description !== undefined && {
      description: variable.description,
    }),
  };
}

/**
 * Builds an SDK `Tag`-shaped object from the plain {@link M3LCodePipelineTag}.
 * A 1:1 map, no collapsing transformation (see the spec page).
 *
 * @param tag - The caller's plain tag shape.
 * @returns The SDK command-input `Tag` shape.
 */
function buildTag(tag: M3LCodePipelineTag): Tag {
  return { key: tag.key, value: tag.value };
}

/**
 * The `inputArtifacts`/`outputArtifacts` subset of the SDK's
 * `ActionDeclaration`, expanding the caller's plain `readonly string[]` back
 * to the SDK's `{ name }[]` wrapper objects. Split out of
 * {@link buildActionDeclaration} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param action - The caller's plain action-declaration shape.
 * @returns The artifact-field subset of the SDK command-input shape.
 */
function buildActionDeclarationArtifacts(
  action: M3LCodePipelineActionDeclaration,
): {
  readonly inputArtifacts?: InputArtifact[];
  readonly outputArtifacts?: OutputArtifact[];
} {
  return {
    ...(action.inputArtifacts !== undefined && {
      inputArtifacts: action.inputArtifacts.map((name) => ({ name })),
    }),
    ...(action.outputArtifacts !== undefined && {
      outputArtifacts: action.outputArtifacts.map((name) => ({ name })),
    }),
  };
}

/**
 * The `roleArn`/`region`/`namespace`/`timeoutInMinutes` subset of the SDK's
 * `ActionDeclaration`, built from the caller's plain
 * {@link M3LCodePipelineActionDeclaration}. Split out of
 * {@link buildActionDeclaration} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param action - The caller's plain action-declaration shape.
 * @returns The detail-field subset of the SDK command-input shape.
 */
function buildActionDeclarationDetail(
  action: M3LCodePipelineActionDeclaration,
): {
  readonly roleArn?: string;
  readonly region?: string;
  readonly namespace?: string;
  readonly timeoutInMinutes?: number;
} {
  return {
    ...(action.roleArn !== undefined && { roleArn: action.roleArn }),
    ...(action.region !== undefined && { region: action.region }),
    ...(action.namespace !== undefined && { namespace: action.namespace }),
    ...(action.timeoutInMinutes !== undefined && {
      timeoutInMinutes: action.timeoutInMinutes,
    }),
  };
}

/**
 * Builds an SDK `ActionDeclaration`-shaped object from the plain
 * {@link M3LCodePipelineActionDeclaration}.
 *
 * @param action - The caller's plain action-declaration shape.
 * @returns The SDK command-input `ActionDeclaration` shape.
 */
function buildActionDeclaration(
  action: M3LCodePipelineActionDeclaration,
): ActionDeclaration {
  return {
    name: action.name,
    actionTypeId: buildActionTypeId(action.actionTypeId),
    ...(action.runOrder !== undefined && { runOrder: action.runOrder }),
    ...(action.configuration !== undefined && {
      configuration: { ...action.configuration },
    }),
    ...buildActionDeclarationArtifacts(action),
    ...buildActionDeclarationDetail(action),
  };
}

/**
 * Builds an SDK `StageDeclaration`-shaped object from the plain
 * {@link M3LCodePipelineStageDeclaration}.
 *
 * @param stage - The caller's plain stage-declaration shape.
 * @returns The SDK command-input `StageDeclaration` shape.
 */
function buildStageDeclaration(
  stage: M3LCodePipelineStageDeclaration,
): StageDeclaration {
  return {
    name: stage.name,
    actions: stage.actions.map(buildActionDeclaration),
  };
}

/**
 * The `artifactStore`/`version`/`pipelineType`/`executionMode`/`variables`
 * subset of the SDK's `PipelineDeclaration`, built from the caller's plain
 * {@link M3LCodePipelineDeclaration}. Split out of {@link buildDeclaration}
 * to keep that function's cyclomatic complexity within the lint budget.
 *
 * @param declaration - The caller's plain declaration shape.
 * @returns The optional-field subset of the SDK command-input shape.
 */
function buildDeclarationOptionalFields(
  declaration: M3LCodePipelineDeclaration,
): {
  readonly artifactStore?: ArtifactStore;
  readonly version?: number;
  readonly pipelineType?: PipelineType;
  readonly executionMode?: ExecutionMode;
  readonly variables?: PipelineVariableDeclaration[];
} {
  return {
    ...(declaration.artifactStore !== undefined && {
      artifactStore: buildArtifactStore(declaration.artifactStore),
    }),
    ...(declaration.version !== undefined && {
      version: declaration.version,
    }),
    ...(declaration.pipelineType !== undefined && {
      pipelineType: declaration.pipelineType as PipelineType,
    }),
    ...(declaration.executionMode !== undefined && {
      executionMode: declaration.executionMode as ExecutionMode,
    }),
    ...(declaration.variables !== undefined && {
      variables: declaration.variables.map(buildVariableDeclaration),
    }),
  };
}

/**
 * Builds an SDK `PipelineDeclaration`-shaped object from the plain
 * {@link M3LCodePipelineDeclaration}, used as the `pipeline` field of both
 * `CreatePipelineCommand` and `UpdatePipelineCommand`'s input. `name`/
 * `roleArn` are caller-required strings on this write path — no defaulting
 * (see the spec page's bidirectional-optionality note).
 *
 * @param declaration - The caller's plain declaration shape.
 * @returns The SDK command-input `PipelineDeclaration` shape.
 */
function buildDeclaration(
  declaration: M3LCodePipelineDeclaration,
): PipelineDeclaration {
  return {
    name: declaration.name,
    roleArn: declaration.roleArn,
    stages: declaration.stages.map(buildStageDeclaration),
    ...buildDeclarationOptionalFields(declaration),
  };
}

/**
 * Translates an SDK `PipelineSummary`-shaped object into the plain
 * {@link M3LCodePipelineSummary}. `name` defaults to `""` when the SDK omits
 * it; every other field is included only when the SDK response defines it
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param summary - The SDK's `PipelineSummary`-shaped object.
 * @returns The plain, library-owned pipeline-summary shape.
 */
function mapPipelineSummary(summary: PipelineSummary): M3LCodePipelineSummary {
  return {
    name: summary.name ?? "",
    ...(summary.version !== undefined && { version: summary.version }),
    ...(summary.pipelineType !== undefined && {
      pipelineType: summary.pipelineType,
    }),
    ...(summary.executionMode !== undefined && {
      executionMode: summary.executionMode,
    }),
    ...(summary.created !== undefined && {
      created: summary.created.toISOString(),
    }),
    ...(summary.updated !== undefined && {
      updated: summary.updated.toISOString(),
    }),
  };
}

/**
 * The `status`/`actionExecutionId`/`summary`/`lastStatusChange`/
 * `lastUpdatedBy` subset of {@link M3LCodePipelineActionExecution}, each
 * included only when the SDK response defines the corresponding field. Split
 * out of {@link mapActionExecution} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param execution - The SDK's `ActionExecution`-shaped object.
 * @returns The core-field subset of the plain action-execution shape.
 */
function mapActionExecutionCore(
  execution: ActionExecution,
): Pick<
  M3LCodePipelineActionExecution,
  | "actionExecutionId"
  | "lastStatusChange"
  | "lastUpdatedBy"
  | "status"
  | "summary"
> {
  return {
    ...(execution.status !== undefined && { status: execution.status }),
    ...(execution.actionExecutionId !== undefined && {
      actionExecutionId: execution.actionExecutionId,
    }),
    ...(execution.summary !== undefined && { summary: execution.summary }),
    ...(execution.lastStatusChange !== undefined && {
      lastStatusChange: execution.lastStatusChange.toISOString(),
    }),
    ...(execution.lastUpdatedBy !== undefined && {
      lastUpdatedBy: execution.lastUpdatedBy,
    }),
  };
}

/**
 * The `externalExecutionId`/`externalExecutionUrl`/`percentComplete`/
 * `errorCode`/`errorMessage` subset of {@link M3LCodePipelineActionExecution},
 * each included only when the SDK response defines the corresponding field.
 * `errorCode`/`errorMessage` flatten the SDK's nested
 * `errorDetails: { code?, message? }`. Split out of {@link mapActionExecution}
 * to keep that function's cyclomatic complexity within the lint budget.
 *
 * @param execution - The SDK's `ActionExecution`-shaped object.
 * @returns The detail-field subset of the plain action-execution shape.
 */
function mapActionExecutionDetail(
  execution: ActionExecution,
): Pick<
  M3LCodePipelineActionExecution,
  | "errorCode"
  | "errorMessage"
  | "externalExecutionId"
  | "externalExecutionUrl"
  | "percentComplete"
> {
  return {
    ...(execution.externalExecutionId !== undefined && {
      externalExecutionId: execution.externalExecutionId,
    }),
    ...(execution.externalExecutionUrl !== undefined && {
      externalExecutionUrl: execution.externalExecutionUrl,
    }),
    ...(execution.percentComplete !== undefined && {
      percentComplete: execution.percentComplete,
    }),
    ...(execution.errorDetails?.code !== undefined && {
      errorCode: execution.errorDetails.code,
    }),
    ...(execution.errorDetails?.message !== undefined && {
      errorMessage: execution.errorDetails.message,
    }),
  };
}

/**
 * Translates an SDK `ActionExecution`-shaped object into the plain
 * {@link M3LCodePipelineActionExecution}. Every field is optional, present
 * only when the SDK response includes it. **Deliberately omits the SDK's
 * `token` field** — the manual-approval token — see the spec page's security
 * section.
 *
 * @param execution - The SDK's `ActionExecution`-shaped object.
 * @returns The plain, library-owned action-execution shape.
 */
function mapActionExecution(
  execution: ActionExecution,
): M3LCodePipelineActionExecution {
  return {
    ...mapActionExecutionCore(execution),
    ...mapActionExecutionDetail(execution),
  };
}

/**
 * Translates an SDK `ActionState`-shaped object into the plain
 * {@link M3LCodePipelineActionState}. `actionName` defaults to `""` when the
 * SDK omits it; the rest are included only when the SDK response defines
 * them.
 *
 * @param state - The SDK's `ActionState`-shaped object.
 * @returns The plain, library-owned action-state shape.
 */
function mapActionState(state: ActionState): M3LCodePipelineActionState {
  return {
    actionName: state.actionName ?? "",
    ...(state.latestExecution !== undefined && {
      latestExecution: mapActionExecution(state.latestExecution),
    }),
    ...(state.entityUrl !== undefined && { entityUrl: state.entityUrl }),
    ...(state.revisionUrl !== undefined && {
      revisionUrl: state.revisionUrl,
    }),
  };
}

/**
 * Translates an SDK `TransitionState`-shaped object into the plain
 * {@link M3LCodePipelineTransitionState}. Every field is included only when
 * the SDK response defines it.
 *
 * @param state - The SDK's `TransitionState`-shaped object.
 * @returns The plain, library-owned transition-state shape.
 */
function mapTransitionState(
  state: TransitionState,
): M3LCodePipelineTransitionState {
  return {
    ...(state.enabled !== undefined && { enabled: state.enabled }),
    ...(state.lastChangedBy !== undefined && {
      lastChangedBy: state.lastChangedBy,
    }),
    ...(state.lastChangedAt !== undefined && {
      lastChangedAt: state.lastChangedAt.toISOString(),
    }),
    ...(state.disabledReason !== undefined && {
      disabledReason: state.disabledReason,
    }),
  };
}

/**
 * Translates an SDK `StageExecution`-shaped object into the plain
 * {@link M3LCodePipelineStageExecution}. `pipelineExecutionId`/`status`
 * default to `""` when the SDK omits them; `type` is included only when the
 * SDK response defines it.
 *
 * @param execution - The SDK's `StageExecution`-shaped object.
 * @returns The plain, library-owned stage-execution shape.
 */
function mapStageExecution(
  execution: StageExecution,
): M3LCodePipelineStageExecution {
  return {
    pipelineExecutionId: execution.pipelineExecutionId ?? "",
    status: execution.status ?? "",
    ...(execution.type !== undefined && { type: execution.type }),
  };
}

/**
 * Translates an SDK `StageState`-shaped object into the plain
 * {@link M3LCodePipelineStageState}. `stageName` defaults to `""` when the
 * SDK omits it; `actionStates` is always an array (`[]` when the SDK omits
 * it); `inboundTransitionState`/`latestExecution` are included only when the
 * SDK response defines them.
 *
 * @param state - The SDK's `StageState`-shaped object.
 * @returns The plain, library-owned stage-state shape.
 */
function mapStageState(state: StageState): M3LCodePipelineStageState {
  return {
    stageName: state.stageName ?? "",
    actionStates: (state.actionStates ?? []).map(mapActionState),
    ...(state.inboundTransitionState !== undefined && {
      inboundTransitionState: mapTransitionState(state.inboundTransitionState),
    }),
    ...(state.latestExecution !== undefined && {
      latestExecution: mapStageExecution(state.latestExecution),
    }),
  };
}

/**
 * Translates an SDK `GetPipelineStateOutput`-shaped object into the plain
 * {@link M3LCodePipelineState}. `pipelineName` defaults to `""` when the SDK
 * omits it; `stageStates` is always an array (`[]` when the SDK omits it —
 * e.g. a valid pipeline with zero stages, not a mapping error);
 * `pipelineVersion`/`created`/`updated` are included only when the SDK
 * response defines them.
 *
 * @param output - The SDK's `GetPipelineStateOutput`-shaped response.
 * @returns The plain, library-owned pipeline-state shape.
 */
function mapPipelineState(
  output: GetPipelineStateOutput,
): M3LCodePipelineState {
  return {
    pipelineName: output.pipelineName ?? "",
    stageStates: (output.stageStates ?? []).map(mapStageState),
    ...(output.pipelineVersion !== undefined && {
      pipelineVersion: output.pipelineVersion,
    }),
    ...(output.created !== undefined && {
      created: output.created.toISOString(),
    }),
    ...(output.updated !== undefined && {
      updated: output.updated.toISOString(),
    }),
  };
}

/**
 * Translates an SDK `ExecutionTrigger`-shaped object into the plain
 * {@link M3LCodePipelineExecutionTrigger}. Shared by {@link mapExecution} and
 * {@link mapExecutionSummary}.
 *
 * @param trigger - The SDK's `ExecutionTrigger`-shaped object.
 * @returns The plain, library-owned execution-trigger shape.
 */
function mapExecutionTrigger(
  trigger: ExecutionTrigger,
): M3LCodePipelineExecutionTrigger {
  return {
    ...(trigger.triggerType !== undefined && {
      triggerType: trigger.triggerType,
    }),
    ...(trigger.triggerDetail !== undefined && {
      triggerDetail: trigger.triggerDetail,
    }),
  };
}

/**
 * Translates an SDK `PipelineExecution`-shaped object into the plain
 * {@link M3LCodePipelineExecution}. `pipelineExecutionId`/`pipelineName`/
 * `status` default to `""` when the SDK omits them; the rest are included
 * only when the SDK response defines them. **Deliberately omits the SDK's
 * `variables` and `artifactRevisions`** — see the spec page's security
 * section.
 *
 * @param execution - The SDK's `PipelineExecution`-shaped object.
 * @returns The plain, library-owned execution shape.
 */
function mapExecution(execution: PipelineExecution): M3LCodePipelineExecution {
  return {
    pipelineExecutionId: execution.pipelineExecutionId ?? "",
    pipelineName: execution.pipelineName ?? "",
    status: execution.status ?? "",
    ...(execution.statusSummary !== undefined && {
      statusSummary: execution.statusSummary,
    }),
    ...(execution.pipelineVersion !== undefined && {
      pipelineVersion: execution.pipelineVersion,
    }),
    ...(execution.executionMode !== undefined && {
      executionMode: execution.executionMode,
    }),
    ...(execution.executionType !== undefined && {
      executionType: execution.executionType,
    }),
    ...(execution.trigger !== undefined && {
      trigger: mapExecutionTrigger(execution.trigger),
    }),
  };
}

/**
 * The `statusSummary`/`startTime`/`lastUpdateTime`/`executionMode`/
 * `executionType` subset of {@link M3LCodePipelineExecutionSummary}, each
 * included only when the SDK response defines the corresponding field. Split
 * out of {@link mapExecutionSummary} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param summary - The SDK's `PipelineExecutionSummary`-shaped object.
 * @returns The mid-field subset of the plain execution-summary shape.
 */
function mapExecutionSummaryFields(
  summary: PipelineExecutionSummary,
): Pick<
  M3LCodePipelineExecutionSummary,
  | "executionMode"
  | "executionType"
  | "lastUpdateTime"
  | "startTime"
  | "statusSummary"
> {
  return {
    ...(summary.statusSummary !== undefined && {
      statusSummary: summary.statusSummary,
    }),
    ...(summary.startTime !== undefined && {
      startTime: summary.startTime.toISOString(),
    }),
    ...(summary.lastUpdateTime !== undefined && {
      lastUpdateTime: summary.lastUpdateTime.toISOString(),
    }),
    ...(summary.executionMode !== undefined && {
      executionMode: summary.executionMode,
    }),
    ...(summary.executionType !== undefined && {
      executionType: summary.executionType,
    }),
  };
}

/**
 * Translates an SDK `PipelineExecutionSummary`-shaped object into the plain
 * {@link M3LCodePipelineExecutionSummary}. `pipelineExecutionId`/`status`
 * default to `""` when the SDK omits them; `stopTriggerReason` flattens the
 * SDK's nested `stopTrigger: { reason? }`; the rest are included only when
 * the SDK response defines them.
 *
 * @param summary - The SDK's `PipelineExecutionSummary`-shaped object.
 * @returns The plain, library-owned execution-summary shape.
 */
function mapExecutionSummary(
  summary: PipelineExecutionSummary,
): M3LCodePipelineExecutionSummary {
  return {
    pipelineExecutionId: summary.pipelineExecutionId ?? "",
    status: summary.status ?? "",
    ...mapExecutionSummaryFields(summary),
    ...(summary.trigger !== undefined && {
      trigger: mapExecutionTrigger(summary.trigger),
    }),
    ...(summary.stopTrigger?.reason !== undefined && {
      stopTriggerReason: summary.stopTrigger.reason,
    }),
  };
}

/**
 * Options for {@link M3LCodePipelineOperations.listPipelines}.
 */
export interface M3LCodePipelineListPipelinesOptions {
  readonly nextToken?: string;
  readonly maxResults?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.listPipelineExecutions}.
 */
export interface M3LCodePipelineListExecutionsOptions {
  readonly nextToken?: string;
  readonly maxResults?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.getPipeline}.
 */
export interface M3LCodePipelineGetPipelineOptions {
  readonly version?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.startPipelineExecution}.
 */
export interface M3LCodePipelineStartExecutionOptions {
  readonly clientRequestToken?: string;
}

/**
 * Typed wrapper over a raw `CodePipelineClient`. Constructed once from a
 * provider-vended client (e.g. `script.aws.clients.codePipeline`) and reused
 * across calls; holds no state of its own beyond the client reference.
 *
 * @example
 * ```ts
 * import { M3LCodePipelineOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const codePipeline = new M3LCodePipelineOperations(script.aws.clients.codePipeline);
 * const { pipelines } = await codePipeline.listPipelines();
 * ```
 */
export class M3LCodePipelineOperations {
  readonly #client: CodePipelineClient;

  /**
   * Creates a new `M3LCodePipelineOperations` over the given raw client.
   *
   * @param client - The raw `CodePipelineClient` to wrap (e.g.
   *   `script.aws.clients.codePipeline`).
   */
  constructor(client: CodePipelineClient) {
    this.#client = client;
  }

  /**
   * Lists pipelines, one `nextToken` page per call (no auto-pagination).
   *
   * @param options - Optional `nextToken` and `maxResults`.
   * @returns The page of pipeline summaries plus an optional `nextToken`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  async listPipelines(
    options?: M3LCodePipelineListPipelinesOptions,
  ): Promise<M3LCodePipelineListPipelinesResult> {
    let response;
    try {
      response = await this.#client.send(
        new ListPipelinesCommand({
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
          ...(options?.maxResults !== undefined && {
            maxResults: options.maxResults,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        "M3LCodePipelineOperations.listPipelines: ListPipelines failed",
        { cause },
      );
    }

    return {
      pipelines: (response.pipelines ?? []).map(mapPipelineSummary),
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Gets a pipeline's declaration (and metadata).
   *
   * @param name - The pipeline name.
   * @param options - Optional `version` to retrieve a specific pipeline version.
   * @returns The pipeline definition, or `undefined` when CodePipeline cannot
   *   resolve the given `name` (`PipelineNotFoundException`).
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  async getPipeline(
    name: string,
    options?: M3LCodePipelineGetPipelineOptions,
  ): Promise<M3LCodePipelineDefinition | undefined> {
    let response;
    try {
      response = await this.#client.send(
        new GetPipelineCommand({
          name,
          ...(options?.version !== undefined && { version: options.version }),
        }),
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "PipelineNotFoundException"
      ) {
        return undefined;
      }
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipeline: GetPipeline failed for name=${name}`,
        { cause },
      );
    }

    if (response.pipeline === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipeline: GetPipeline succeeded but returned no pipeline for name=${name}`,
      );
    }

    return {
      declaration: mapDeclaration(response.pipeline),
      ...(response.metadata !== undefined && {
        metadata: mapMetadata(response.metadata),
      }),
    };
  }

  /**
   * Gets a pipeline's current stage/action state.
   *
   * @param name - The pipeline name.
   * @returns The pipeline state, or `undefined` when CodePipeline cannot
   *   resolve the given `name` (`PipelineNotFoundException`).
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  async getPipelineState(
    name: string,
  ): Promise<M3LCodePipelineState | undefined> {
    let response;
    try {
      response = await this.#client.send(new GetPipelineStateCommand({ name }));
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "PipelineNotFoundException"
      ) {
        return undefined;
      }
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipelineState: GetPipelineState failed for name=${name}`,
        { cause },
      );
    }

    return mapPipelineState(response);
  }

  /**
   * Lists a pipeline's executions, one `nextToken` page per call (no
   * auto-pagination).
   *
   * @param pipelineName - The pipeline whose executions to list.
   * @param options - Optional `nextToken` and `maxResults`.
   * @returns The page of execution summaries plus an optional `nextToken`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  async listPipelineExecutions(
    pipelineName: string,
    options?: M3LCodePipelineListExecutionsOptions,
  ): Promise<M3LCodePipelineListExecutionsResult> {
    let response;
    try {
      response = await this.#client.send(
        new ListPipelineExecutionsCommand({
          pipelineName,
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
          ...(options?.maxResults !== undefined && {
            maxResults: options.maxResults,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.listPipelineExecutions: ListPipelineExecutions failed for pipelineName=${pipelineName}`,
        { cause },
      );
    }

    return {
      executionSummaries: (response.pipelineExecutionSummaries ?? []).map(
        mapExecutionSummary,
      ),
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Gets a single pipeline execution's detail.
   *
   * @param pipelineName - The pipeline the execution belongs to.
   * @param pipelineExecutionId - The execution to describe.
   * @returns The execution detail, or `undefined` when CodePipeline cannot
   *   resolve the pipeline (`PipelineNotFoundException`) or the execution
   *   (`PipelineExecutionNotFoundException`) — the latter lets a `watch` poll
   *   loop tolerate the eventual-consistency window right after a trigger.
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  async getPipelineExecution(
    pipelineName: string,
    pipelineExecutionId: string,
  ): Promise<M3LCodePipelineExecution | undefined> {
    let response;
    try {
      response = await this.#client.send(
        new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId }),
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "PipelineNotFoundException" ||
          cause.name === "PipelineExecutionNotFoundException")
      ) {
        return undefined;
      }
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipelineExecution: GetPipelineExecution failed for pipelineName=${pipelineName}, pipelineExecutionId=${pipelineExecutionId}`,
        { cause },
      );
    }

    if (response.pipelineExecution === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipelineExecution: GetPipelineExecution succeeded but returned no pipelineExecution for pipelineName=${pipelineName}, pipelineExecutionId=${pipelineExecutionId}`,
      );
    }

    return mapExecution(response.pipelineExecution);
  }

  /**
   * Creates a new pipeline.
   *
   * @param input - The pipeline creation input.
   * @returns The created pipeline's declaration, as returned by CodePipeline.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  async createPipeline(
    input: M3LCodePipelineCreatePipelineInput,
  ): Promise<M3LCodePipelineDeclaration> {
    let response;
    try {
      response = await this.#client.send(
        new CreatePipelineCommand({
          pipeline: buildDeclaration(input.declaration),
          ...(input.tags !== undefined && {
            tags: input.tags.map(buildTag),
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.createPipeline: CreatePipeline failed for name=${input.declaration.name}`,
        { cause },
      );
    }

    if (response.pipeline === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.createPipeline: CreatePipeline succeeded but returned no pipeline for name=${input.declaration.name}`,
      );
    }

    return mapDeclaration(response.pipeline);
  }

  /**
   * Updates an existing pipeline. **Takes a caller-authored complete
   * declaration** — this wrapper ships no get-mutate-put convenience method,
   * since {@link M3LCodePipelineDeclaration} is not a faithful round-trip of
   * {@link getPipeline} (see the spec page).
   *
   * @param declaration - The complete pipeline declaration to apply.
   * @returns The updated pipeline's declaration, as returned by CodePipeline.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  async updatePipeline(
    declaration: M3LCodePipelineDeclaration,
  ): Promise<M3LCodePipelineDeclaration> {
    let response;
    try {
      response = await this.#client.send(
        new UpdatePipelineCommand({
          pipeline: buildDeclaration(declaration),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.updatePipeline: UpdatePipeline failed for name=${declaration.name}`,
        { cause },
      );
    }

    if (response.pipeline === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.updatePipeline: UpdatePipeline succeeded but returned no pipeline for name=${declaration.name}`,
      );
    }

    return mapDeclaration(response.pipeline);
  }

  /**
   * Deletes a pipeline. **Destructive** — this wrapper performs no
   * confirmation gate of its own (see the spec page).
   *
   * @param name - The pipeline name to delete.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call. Deleting an already-absent pipeline is a CodePipeline no-op
   *   success, not an error.
   */
  async deletePipeline(name: string): Promise<void> {
    try {
      await this.#client.send(new DeletePipelineCommand({ name }));
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.deletePipeline: DeletePipeline failed for name=${name}`,
        { cause },
      );
    }
  }

  /**
   * Starts a pipeline execution. **Not idempotent without
   * `options.clientRequestToken`** — supply it to dedupe retried triggers.
   *
   * @param name - The pipeline name to trigger.
   * @param options - Optional `clientRequestToken`.
   * @returns The started execution's `pipelineExecutionId`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `ConcurrentPipelineExecutionsLimitExceededException`/
   *   `ConflictException` (neither classified as data — see the spec page).
   */
  async startPipelineExecution(
    name: string,
    options?: M3LCodePipelineStartExecutionOptions,
  ): Promise<M3LCodePipelineStartExecutionResult> {
    let response;
    try {
      response = await this.#client.send(
        new StartPipelineExecutionCommand({
          name,
          ...(options?.clientRequestToken !== undefined && {
            clientRequestToken: options.clientRequestToken,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.startPipelineExecution: StartPipelineExecution failed for name=${name}`,
        { cause },
      );
    }

    if (response.pipelineExecutionId === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.startPipelineExecution: StartPipelineExecution succeeded but returned no pipelineExecutionId for name=${name}`,
      );
    }

    return { pipelineExecutionId: response.pipelineExecutionId };
  }

  /**
   * Stops a pipeline execution. Unlike {@link deletePipeline}, re-stopping or
   * stopping an already-terminal execution **errors**
   * (`DuplicatedStopRequestException`/`PipelineExecutionNotStoppableException`
   * — neither classified as data, see the spec page).
   *
   * @param input - The pipeline/execution to stop, plus optional
   *   `abandon`/`reason`.
   * @returns The stopped execution's `pipelineExecutionId`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  async stopPipelineExecution(
    input: M3LCodePipelineStopExecutionInput,
  ): Promise<M3LCodePipelineStopExecutionResult> {
    let response;
    try {
      response = await this.#client.send(
        new StopPipelineExecutionCommand({
          pipelineName: input.pipelineName,
          pipelineExecutionId: input.pipelineExecutionId,
          ...(input.abandon !== undefined && { abandon: input.abandon }),
          ...(input.reason !== undefined && { reason: input.reason }),
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.stopPipelineExecution: StopPipelineExecution failed for pipelineName=${input.pipelineName}, pipelineExecutionId=${input.pipelineExecutionId}`,
        { cause },
      );
    }

    if (response.pipelineExecutionId === undefined) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.stopPipelineExecution: StopPipelineExecution succeeded but returned no pipelineExecutionId for pipelineName=${input.pipelineName}, pipelineExecutionId=${input.pipelineExecutionId}`,
      );
    }

    return { pipelineExecutionId: response.pipelineExecutionId };
  }

  /**
   * Enables a stage transition (inbound or outbound).
   *
   * @param input - The pipeline/stage/direction to enable.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `StageNotFoundException` — deliberately **not**
   *   classified as data (a bad stage name is a caller error, see the spec
   *   page).
   */
  async enableStageTransition(
    input: M3LCodePipelineEnableStageTransitionInput,
  ): Promise<void> {
    try {
      await this.#client.send(
        new EnableStageTransitionCommand({
          pipelineName: input.pipelineName,
          stageName: input.stageName,
          transitionType: input.transitionType,
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.enableStageTransition: EnableStageTransition failed for pipelineName=${input.pipelineName}, stageName=${input.stageName}`,
        { cause },
      );
    }
  }

  /**
   * Disables a stage transition (inbound or outbound). Unlike
   * {@link enableStageTransition}, `input.reason` is **required**.
   *
   * @param input - The pipeline/stage/direction to disable, plus the
   *   required `reason`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `StageNotFoundException` — deliberately **not**
   *   classified as data (see the spec page).
   */
  async disableStageTransition(
    input: M3LCodePipelineDisableStageTransitionInput,
  ): Promise<void> {
    try {
      await this.#client.send(
        new DisableStageTransitionCommand({
          pipelineName: input.pipelineName,
          stageName: input.stageName,
          transitionType: input.transitionType,
          reason: input.reason,
        }),
      );
    } catch (cause) {
      throw new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.disableStageTransition: DisableStageTransition failed for pipelineName=${input.pipelineName}, stageName=${input.stageName}`,
        { cause },
      );
    }
  }
}
