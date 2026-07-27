/**
 * `aws/codepipeline/types` — plain, library-owned shapes returned by
 * {@link M3LCodePipelineOperations}, translated from the raw
 * `@aws-sdk/client-codepipeline` request/response types. See
 * `docs/reference/aws/codepipeline.md` for the full field-by-field contract,
 * including the intentionally-dropped declaration fields and the
 * security-relevant fields this module deliberately never maps
 * (`ActionExecution.token`, and `PipelineExecution.variables`/
 * `.artifactRevisions` in full — not just `variables[].resolvedValue`).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Listing / summaries
// ---------------------------------------------------------------------------

/**
 * One page of {@link M3LCodePipelineOperations.listPipelines}. `pipelines` is
 * always an array (`[]` when the SDK omits `pipelines`); `nextToken` is
 * present only when the SDK returns one.
 */
export interface M3LCodePipelineListPipelinesResult {
  readonly pipelines: readonly M3LCodePipelineSummary[];
  readonly nextToken?: string;
}

/**
 * A single pipeline summary entry from
 * {@link M3LCodePipelineListPipelinesResult}. `name` is always present
 * (defaulted to `""` when the SDK omits it); the rest present only when the
 * SDK response includes them.
 */
export interface M3LCodePipelineSummary {
  readonly name: string;
  readonly version?: number;
  readonly pipelineType?: string;
  readonly executionMode?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly created?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly updated?: string;
}

// ---------------------------------------------------------------------------
// Pipeline definition (declaration model)
// ---------------------------------------------------------------------------

/**
 * Result of {@link M3LCodePipelineOperations.getPipeline}.
 */
export interface M3LCodePipelineDefinition {
  readonly declaration: M3LCodePipelineDeclaration;
  readonly metadata?: M3LCodePipelineMetadata;
}

/**
 * The `metadata` half of {@link M3LCodePipelineDefinition}. All fields
 * present only when the SDK response includes them.
 */
export interface M3LCodePipelineMetadata {
  readonly pipelineArn?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly created?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly updated?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly pollingDisabledAt?: string;
}

/**
 * A CodePipeline pipeline declaration, modeled field-by-field rather than
 * re-exporting the SDK's `PipelineDeclaration` (SDK types are never
 * re-exported; ADR-0029). **Not a faithful round-trip of
 * {@link M3LCodePipelineOperations.getPipeline}** — see the spec page's "The
 * pipeline declaration is a lossy round-trip" section for the full list of
 * fields intentionally out of scope for v1 (`triggers`, the cross-region
 * `artifactStores` map, per-stage conditions, action `commands`/
 * `environmentVariables`/`outputVariables`, `OutputArtifact.files`).
 * `updatePipeline` takes a caller-authored complete declaration; using a
 * `getPipeline` result as an update input silently deletes every dropped
 * field from the live pipeline.
 */
export interface M3LCodePipelineDeclaration {
  readonly name: string;
  readonly roleArn: string;
  readonly stages: readonly M3LCodePipelineStageDeclaration[];
  readonly artifactStore?: M3LCodePipelineArtifactStore;
  readonly version?: number;
  readonly pipelineType?: string;
  readonly executionMode?: string;
  readonly variables?: readonly M3LCodePipelineVariableDeclaration[];
}

/**
 * A single stage within {@link M3LCodePipelineDeclaration.stages}.
 */
export interface M3LCodePipelineStageDeclaration {
  readonly name: string;
  readonly actions: readonly M3LCodePipelineActionDeclaration[];
}

/**
 * A single action within {@link M3LCodePipelineStageDeclaration.actions}.
 * `inputArtifacts`/`outputArtifacts` collapse the SDK's `{ name }[]` wrapper
 * objects down to plain `readonly string[]` (mirrors
 * `M3LCloudFormationKeyValue`'s collapsing of `Parameter`/`Tag`).
 */
export interface M3LCodePipelineActionDeclaration {
  readonly name: string;
  readonly actionTypeId: M3LCodePipelineActionTypeId;
  readonly runOrder?: number;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly inputArtifacts?: readonly string[];
  readonly outputArtifacts?: readonly string[];
  readonly roleArn?: string;
  readonly region?: string;
  readonly namespace?: string;
  readonly timeoutInMinutes?: number;
}

/**
 * An action's type identifier — the four fields CodePipeline uses to select
 * the concrete action provider (e.g. CodeBuild, Manual Approval).
 */
export interface M3LCodePipelineActionTypeId {
  readonly category: string;
  readonly owner: string;
  readonly provider: string;
  readonly version: string;
}

/**
 * A pipeline's artifact store. `encryptionKey` present only when the caller
 * or SDK response supplies one.
 */
export interface M3LCodePipelineArtifactStore {
  readonly type: string;
  readonly location: string;
  readonly encryptionKey?: M3LCodePipelineEncryptionKey;
}

/**
 * The customer-managed KMS key configuration for an
 * {@link M3LCodePipelineArtifactStore}.
 */
export interface M3LCodePipelineEncryptionKey {
  readonly id: string;
  readonly type: string;
}

/**
 * A pipeline-level variable declaration.
 */
export interface M3LCodePipelineVariableDeclaration {
  readonly name: string;
  readonly defaultValue?: string;
  readonly description?: string;
}

/**
 * A plain `{ key, value }` tag pair. **No collapsing transformation** here —
 * unlike `M3LCloudFormationKeyValue`, which merges CloudFormation's separate
 * `Parameter`/`Tag` shapes with different field names into one, the SDK's
 * `Tag` is already `{ key, value }`, so this is a 1:1 map (required-nullable
 * → required).
 */
export interface M3LCodePipelineTag {
  readonly key: string;
  readonly value: string;
}

/**
 * Input to {@link M3LCodePipelineOperations.createPipeline}.
 */
export interface M3LCodePipelineCreatePipelineInput {
  readonly declaration: M3LCodePipelineDeclaration;
  readonly tags?: readonly M3LCodePipelineTag[];
}

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

/**
 * Result of {@link M3LCodePipelineOperations.getPipelineState}. `pipelineName`
 * is always present (defaulted to `""` when the SDK omits it); `stageStates`
 * is always an array (`[]` when the SDK omits it — e.g. a valid pipeline with
 * zero stages, not a mapping error).
 */
export interface M3LCodePipelineState {
  readonly pipelineName: string;
  readonly stageStates: readonly M3LCodePipelineStageState[];
  readonly pipelineVersion?: number;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly created?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly updated?: string;
}

/**
 * A single stage's state within {@link M3LCodePipelineState.stageStates}.
 * `stageName` is always present (defaulted to `""` when the SDK omits it);
 * `actionStates` is always an array (`[]` when the SDK omits it).
 */
export interface M3LCodePipelineStageState {
  readonly stageName: string;
  readonly actionStates: readonly M3LCodePipelineActionState[];
  readonly inboundTransitionState?: M3LCodePipelineTransitionState;
  readonly latestExecution?: M3LCodePipelineStageExecution;
}

/**
 * The inbound-transition (enable/disable) state of a stage.
 */
export interface M3LCodePipelineTransitionState {
  readonly enabled?: boolean;
  readonly lastChangedBy?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly lastChangedAt?: string;
  readonly disabledReason?: string;
}

/**
 * A stage's latest execution summary, within
 * {@link M3LCodePipelineStageState.latestExecution}. `pipelineExecutionId`/
 * `status` are always present (defaulted to `""` when the SDK omits them).
 * `status` is sourced from the SDK's `StageExecutionStatus` — a distinct
 * 7-value set from {@link M3LCodePipelineExecution}'s `status` (which has
 * `Superseded` but no `Skipped`); see
 * `docs/reference/aws/codepipeline.md`'s "Watching an execution" section.
 */
export interface M3LCodePipelineStageExecution {
  readonly pipelineExecutionId: string;
  readonly status: string;
  readonly type?: string;
}

/**
 * A single action's state within {@link M3LCodePipelineStageState.actionStates}.
 * `actionName` is always present (defaulted to `""` when the SDK omits it).
 */
export interface M3LCodePipelineActionState {
  readonly actionName: string;
  readonly latestExecution?: M3LCodePipelineActionExecution;
  readonly entityUrl?: string;
  readonly revisionUrl?: string;
}

/**
 * An action's latest execution detail, within
 * {@link M3LCodePipelineActionState.latestExecution}. `errorCode`/
 * `errorMessage` flatten the SDK's nested `errorDetails: { code?, message? }`
 * to sibling fields. **Deliberately omits the SDK's `token` field** — the
 * manual-approval token; a holder can approve a production deployment via
 * `PutApprovalResult`, so this module never maps it into the public type
 * (see the spec page's security section).
 */
export interface M3LCodePipelineActionExecution {
  /** Sourced from the SDK's `ActionExecutionStatus` — a 4-value set, distinct from {@link M3LCodePipelineExecution}'s `status`/{@link M3LCodePipelineStageExecution}'s `status`. */
  readonly status?: string;
  readonly actionExecutionId?: string;
  readonly summary?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly lastStatusChange?: string;
  readonly lastUpdatedBy?: string;
  readonly externalExecutionId?: string;
  readonly externalExecutionUrl?: string;
  readonly percentComplete?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

/**
 * Result of {@link M3LCodePipelineOperations.getPipelineExecution}.
 * `pipelineExecutionId`/`pipelineName`/`status` are always present (defaulted
 * to `""` when the SDK omits them). **Deliberately omits the SDK's
 * `variables`** (caller-supplied pipeline-variable resolved values, not
 * covered by the library's redaction denylist) **and `artifactRevisions`**
 * (bulk, and `revisionSummary` embeds commit messages) — see the spec page's
 * security section.
 */
export interface M3LCodePipelineExecution {
  readonly pipelineExecutionId: string;
  readonly pipelineName: string;
  /** Sourced from the SDK's `PipelineExecutionStatus` — see `docs/reference/aws/codepipeline.md`'s "Watching an execution" section for the full 7-value set (incl. `Superseded`). */
  readonly status: string;
  readonly statusSummary?: string;
  readonly pipelineVersion?: number;
  readonly executionMode?: string;
  readonly executionType?: string;
  readonly trigger?: M3LCodePipelineExecutionTrigger;
}

/**
 * What triggered a pipeline execution, shared by
 * {@link M3LCodePipelineExecution} and {@link M3LCodePipelineExecutionSummary}.
 */
export interface M3LCodePipelineExecutionTrigger {
  readonly triggerType?: string;
  readonly triggerDetail?: string;
}

/**
 * One page of {@link M3LCodePipelineOperations.listPipelineExecutions}.
 * `executionSummaries` is always an array (`[]` when the SDK omits it);
 * `nextToken` is present only when the SDK returns one.
 */
export interface M3LCodePipelineListExecutionsResult {
  readonly executionSummaries: readonly M3LCodePipelineExecutionSummary[];
  readonly nextToken?: string;
}

/**
 * A single execution summary entry from
 * {@link M3LCodePipelineListExecutionsResult}. `pipelineExecutionId`/
 * `status` are always present (defaulted to `""` when the SDK omits them).
 * `stopTriggerReason` flattens the SDK's nested `stopTrigger: { reason? }`
 * down to a single field, the same flattening move applied to
 * `M3LCodePipelineActionExecution`'s `errorCode`/`errorMessage`.
 */
export interface M3LCodePipelineExecutionSummary {
  readonly pipelineExecutionId: string;
  readonly status: string;
  readonly statusSummary?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly startTime?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly lastUpdateTime?: string;
  readonly executionMode?: string;
  readonly executionType?: string;
  readonly trigger?: M3LCodePipelineExecutionTrigger;
  readonly stopTriggerReason?: string;
}

/**
 * Result of {@link M3LCodePipelineOperations.startPipelineExecution}.
 * `pipelineExecutionId` is always present — an absent value on an
 * otherwise-successful `StartPipelineExecution` response is treated as a
 * genuine API/SDK anomaly and throws rather than silently omitting the field
 * (mirrors `M3LCloudFormationCreateStackResult`'s `stackId` contract).
 */
export interface M3LCodePipelineStartExecutionResult {
  readonly pipelineExecutionId: string;
}

/**
 * Input to {@link M3LCodePipelineOperations.stopPipelineExecution}.
 */
export interface M3LCodePipelineStopExecutionInput {
  readonly pipelineName: string;
  readonly pipelineExecutionId: string;
  readonly abandon?: boolean;
  readonly reason?: string;
}

/**
 * Result of {@link M3LCodePipelineOperations.stopPipelineExecution}. Same
 * anomaly-throw contract as {@link M3LCodePipelineStartExecutionResult}.
 */
export interface M3LCodePipelineStopExecutionResult {
  readonly pipelineExecutionId: string;
}

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

/**
 * The direction of a stage transition. A **closed** union (unlike the
 * `string`-typed read-path status/type fields above) because it is
 * write-only — a typo becomes a compile error rather than a future
 * server-side value becoming a type-level lie (mirrors
 * `M3LCloudFormationCapability`).
 */
export type M3LCodePipelineStageTransitionType = "Inbound" | "Outbound";

/**
 * Input to {@link M3LCodePipelineOperations.enableStageTransition}. Unlike
 * {@link M3LCodePipelineDisableStageTransitionInput}, has no `reason` field —
 * the SDK's `EnableStageTransitionInput` does not declare one.
 */
export interface M3LCodePipelineEnableStageTransitionInput {
  readonly pipelineName: string;
  readonly stageName: string;
  readonly transitionType: M3LCodePipelineStageTransitionType;
}

/**
 * Input to {@link M3LCodePipelineOperations.disableStageTransition}. `reason`
 * is **required** — the SDK's `DisableStageTransitionInput` declares it as
 * such, unlike the enable counterpart.
 */
export interface M3LCodePipelineDisableStageTransitionInput {
  readonly pipelineName: string;
  readonly stageName: string;
  readonly transitionType: M3LCodePipelineStageTransitionType;
  readonly reason: string;
}
