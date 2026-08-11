# CodePipeline Operations

`M3LCodePipelineOperations` is a typed wrapper over a raw `CodePipelineClient`,
so callers never import `@aws-sdk/client-codepipeline` command classes
directly. Surfaced by `scripts/codepipeline-ops` (roadmap W3) needing to avoid
importing the SDK directly (ADR-0029 — scripts depend only on
`@m3l-automation/m3l-common`).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `AWSClientProvider.codePipeline`
returns the raw `CodePipelineClient`; `M3LCodePipelineOperations` wraps it
with bespoke, typed methods, translating SDK request/response shapes into
plain, library-owned types so a caller never touches an
`@aws-sdk/client-codepipeline` type.

Scoped to pipeline listing/description, the pipeline **declaration** model
(create/update/delete), execution control (trigger/stop/list/get), and stage
transitions (enable/disable). **Deliberately out of scope for this v1**:
webhooks, custom action types, third-party jobs, and `PutApprovalResult` — see
"Out of scope (v1)" below.

- `M3LCodePipelineOperations` — the wrapper class, constructed from a raw
  `CodePipelineClient`.
- `M3LCodePipelineOperationError` — thrown on a request-level CodePipeline
  failure.
- Plain types: `M3LCodePipelineListPipelinesResult`, `M3LCodePipelineSummary`,
  `M3LCodePipelineDefinition`, `M3LCodePipelineMetadata`,
  `M3LCodePipelineDeclaration`, `M3LCodePipelineStageDeclaration`,
  `M3LCodePipelineActionDeclaration`, `M3LCodePipelineActionTypeId`,
  `M3LCodePipelineArtifactStore`, `M3LCodePipelineEncryptionKey`,
  `M3LCodePipelineVariableDeclaration`, `M3LCodePipelineTag`,
  `M3LCodePipelineCreatePipelineInput`, `M3LCodePipelineState`,
  `M3LCodePipelineStageState`, `M3LCodePipelineTransitionState`,
  `M3LCodePipelineStageExecution`, `M3LCodePipelineActionState`,
  `M3LCodePipelineActionExecution`, `M3LCodePipelineExecution`,
  `M3LCodePipelineExecutionTrigger`, `M3LCodePipelineListExecutionsResult`,
  `M3LCodePipelineExecutionSummary`, `M3LCodePipelineStartExecutionResult`,
  `M3LCodePipelineStopExecutionInput`, `M3LCodePipelineStopExecutionResult`,
  `M3LCodePipelineStageTransitionType`,
  `M3LCodePipelineEnableStageTransitionInput`,
  `M3LCodePipelineDisableStageTransitionInput`.
- Options types (declared alongside the methods that take them, not
  constructed by callers otherwise): `M3LCodePipelineListPipelinesOptions`,
  `M3LCodePipelineListExecutionsOptions`, `M3LCodePipelineGetPipelineOptions`,
  `M3LCodePipelineStartExecutionOptions`.

## Public API

### `M3LCodePipelineOperations`

**Constructor** — `new M3LCodePipelineOperations(client)`, where `client` is
a raw `CodePipelineClient` (e.g. `script.aws.clients.codePipeline`).

| Method                                                    | Returns                                           | Throws                          |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| `listPipelines(options?)`                                 | `Promise<M3LCodePipelineListPipelinesResult>`     | `M3LCodePipelineOperationError` |
| `getPipeline(name, options?)`                             | `Promise<M3LCodePipelineDefinition \| undefined>` | `M3LCodePipelineOperationError` |
| `getPipelineState(name)`                                  | `Promise<M3LCodePipelineState \| undefined>`      | `M3LCodePipelineOperationError` |
| `listPipelineExecutions(pipelineName, options?)`          | `Promise<M3LCodePipelineListExecutionsResult>`    | `M3LCodePipelineOperationError` |
| `getPipelineExecution(pipelineName, pipelineExecutionId)` | `Promise<M3LCodePipelineExecution \| undefined>`  | `M3LCodePipelineOperationError` |
| `createPipeline(input)`                                   | `Promise<M3LCodePipelineDeclaration>`             | `M3LCodePipelineOperationError` |
| `updatePipeline(declaration)`                             | `Promise<M3LCodePipelineDeclaration>`             | `M3LCodePipelineOperationError` |
| `deletePipeline(name)`                                    | `Promise<void>`                                   | `M3LCodePipelineOperationError` |
| `startPipelineExecution(name, options?)`                  | `Promise<M3LCodePipelineStartExecutionResult>`    | `M3LCodePipelineOperationError` |
| `stopPipelineExecution(input)`                            | `Promise<M3LCodePipelineStopExecutionResult>`     | `M3LCodePipelineOperationError` |
| `enableStageTransition(input)`                            | `Promise<void>`                                   | `M3LCodePipelineOperationError` |
| `disableStageTransition(input)`                           | `Promise<void>`                                   | `M3LCodePipelineOperationError` |

`listPipelines`/`listPipelineExecutions` page via `nextToken` (mirrors the
SDK's own `nextToken` pagination — one page per call, no auto-pagination, per
`M3LCloudFormationOperations.listStacks`'s precedent); both also accept an
optional `maxResults`. The SDK's `paginateListPipelines`/
`paginateListPipelineExecutions` auto-pagination helpers exist but are
deliberately not used — this module follows the one-page-per-call convention
throughout.

#### Options types (field-by-field)

- `M3LCodePipelineListPipelinesOptions` — `nextToken?: string`,
  `maxResults?: number`. A 1:1 map of the SDK's `ListPipelinesInput`.
- `M3LCodePipelineListExecutionsOptions` — `nextToken?: string`,
  `maxResults?: number`. **Does not model** the SDK's `filter`
  (`PipelineExecutionFilter`, e.g. filtering by `succeededInStage`) — see
  "Out of scope (v1)".
- `M3LCodePipelineGetPipelineOptions` — `version?: number`, to retrieve a
  specific pipeline version. On a `version` that does not exist for the
  pipeline, `getPipeline` throws `PipelineVersionNotFoundException` — this is
  **not** folded into the `undefined` resolution alongside
  `PipelineNotFoundException` below (a caller asking for a specific version
  that doesn't exist is a different condition from the pipeline itself not
  existing), so it throws `M3LCodePipelineOperationError` like any other
  unclassified rejection.
- `M3LCodePipelineStartExecutionOptions` — `clientRequestToken?: string`
  only. **Does not model** the SDK's `variables` (`PipelineVariable[]` —
  per-execution overrides of pipeline variable values) or `sourceRevisions`
  (`SourceRevisionOverride[]` — per-execution source revision overrides) —
  see "Out of scope (v1)".

### `PipelineNotFoundException` is modeled, unlike CloudFormation's `ValidationError`

Unlike CloudFormation (which models zero exception classes for its
not-found case), CodePipeline models `PipelineNotFoundException`,
`PipelineExecutionNotFoundException`, and `StageNotFoundException` as real
SDK exception classes, each pinning `readonly name` as a literal type set at
runtime — so classification here is a clean `error instanceof Error &&
error.name === "PipelineNotFoundException"` check with **none** of
`cloudformation.md`'s "AWS does not publish this string as a stable contract"
caveat.

- `getPipeline`/`getPipelineState` resolve `undefined` on
  `PipelineNotFoundException`; every other rejection throws
  `M3LCodePipelineOperationError` — including `getPipeline`'s
  `PipelineVersionNotFoundException` (raised when `options.version` names a
  version that doesn't exist), which is **not** folded into the `undefined`
  resolution (see "Options types" above).
- `getPipelineExecution` resolves `undefined` on **either**
  `PipelineNotFoundException` **or** `PipelineExecutionNotFoundException`.
  Tolerating the execution-not-found case (rather than throwing) is what lets
  a `watch` poll loop (see below) `continue` through the brief
  eventual-consistency window right after `startPipelineExecution`, instead of
  aborting the whole watch on the first poll.
- `listPipelineExecutions` also declares `PipelineNotFoundException` in its
  exception list, but — unlike the single-resource lookups above — is **not**
  classified: a caller listing executions for a pipeline that doesn't exist
  gets a thrown `M3LCodePipelineOperationError`, not an empty result. This
  mirrors the read/write-adjacent treatment `startPipelineExecution` gets
  below (a listing call is closer to "operate on this named pipeline" than to
  a single-resource existence check).

**Absent-payload anomaly, not a not-found signal.** `getPipeline`'s and
`getPipelineExecution`'s underlying SDK response types (`GetPipelineOutput.pipeline`,
`GetPipelineExecutionOutput.pipelineExecution`) type their payload field as
optional even on a non-error response. An absent payload on an
otherwise-successful call (no `PipelineNotFoundException`/
`PipelineExecutionNotFoundException` raised) is a genuine API/SDK anomaly, not
a not-found signal — both methods throw `M3LCodePipelineOperationError` in
that case rather than resolving `undefined`, so `undefined` from either method
always means the modeled not-found exception fired, never an ambiguous
"empty success." The same anomaly-throw applies to `createPipeline`/
`updatePipeline` below.

### `StageNotFoundException` is deliberately not classified

`enableStageTransition`/`disableStageTransition` both declare
`PipelineNotFoundException` **and** `StageNotFoundException` as possible
SDK exceptions; **neither is classified as data** — both throw
`M3LCodePipelineOperationError`. Unlike the read paths above, these are
mutations: a bad stage name on a transition call is a caller error, and
`.claude/rules/library-src.md` says to fail loud on caller errors rather than
resolve them as an absence. This is a deliberate asymmetry with the previous
section, not an inconsistency — a `type-design-analyzer`/spec-conformance
review should read it as intentional.

`ValidationException` is **never** classified anywhere in this module —
CodePipeline models it and raises it for a wide range of malformed input
across every command; treating it as "not found" would be a strictly worse
version of CloudFormation's already-caveated message-substring heuristic.

### `startPipelineExecution` idempotency and `clientRequestToken`

`StartPipelineExecutionInput.clientRequestToken` is the SDK's own dedupe key
for a trigger call — without it, a retried trigger starts a **second**
execution rather than being deduplicated. This wrapper surfaces
`options.clientRequestToken` even though the archived fleet plan's `trigger`
op description omits it, since a script driving `trigger` from a retryable
context needs it to stay idempotent.

Three failure modes on `startPipelineExecution` are **not** classified as
data and always throw: `ConcurrentPipelineExecutionsLimitExceededException`
(the pipeline is in `PARALLEL` execution mode and at its limit),
`ConflictException` (the pipeline is being updated, or a stage condition
blocks the trigger), and `PipelineNotFoundException` — deliberately not
folded into an `undefined`/absence resolution here, unlike the read paths
above, since `startPipelineExecution` is a mutation (see the
`StageNotFoundException` rationale above: a bad identifier on a mutation is a
caller error, not an absence to resolve).

### `deletePipeline` no-ops but `stopPipelineExecution` does not

`deletePipeline` on an already-absent pipeline is a CodePipeline **no-op
success** — the SDK's `DeletePipeline` command declares no
`PipelineNotFoundException` in its exception list, only
`ConcurrentModificationException`/`ValidationException` — so this wrapper
passes that resolution straight through as `void`. `deletePipeline` is
**destructive**; this wrapper performs no confirmation gate of its own — the
caller (`scripts/codepipeline-ops`) is responsible for its own
destructive-operation confirmation via `Core.confirmDestructive`, matching
every other AWS-consumer script's convention and
`M3LCloudFormationOperations.deleteStack`'s identical contract.

`stopPipelineExecution` is **not** similarly forgiving: it declares
`DuplicatedStopRequestException` (re-stopping an execution already being
stopped), `PipelineExecutionNotStoppableException` (stopping a terminal
execution), `ConflictException`, and `PipelineNotFoundException` — note this
is `PipelineNotFoundException`, **not** `PipelineExecutionNotFoundException`
(the SDK's `StopPipelineExecution` exception list does not include the
latter, unlike `GetPipelineExecution`'s). None of the four is classified as
data — all throw `M3LCodePipelineOperationError`.

### Watching an execution (no SDK waiter)

Unlike `@aws-sdk/client-cloudformation` (`waitUntilStackCreateComplete`, …)
and `@aws-sdk/client-ecs` (`waitUntilServicesStable`), `@aws-sdk/client-codepipeline`
ships **zero** package-level `waitUntil*` waiter functions. This module
therefore has **no waiter method** — a caller (`scripts/codepipeline-ops`)
composes its own poll loop over `getPipelineExecution`, driven by
`Core.M3LPoller` with a script-owned policy (the archived fleet plan's
"`watch` uses `M3LPoller` with a per-script policy," in contrast to the
library-owned `M3LPollingPolicies.athenaQuery`/`cloudWatchLogsQuery`
policies, since terminal-state detection here needs no additional
result-retrieval work the way Athena/CloudWatch Logs Insights queries do).

**The full `PipelineExecutionStatus` set — the one `getPipelineExecution`'s
`.status` and `listPipelineExecutions`'s `.status` are sourced from — has
seven values, not two.** A poller written from the CloudFormation/ECS
two-terminal-state mental model (`SUCCESS`/`FAILURE`) will hang on states
neither of those services has:

| Status       | Terminal? |
| ------------ | --------- |
| `InProgress` | No        |
| `Stopping`   | No        |
| `Succeeded`  | **Yes**   |
| `Failed`     | **Yes**   |
| `Stopped`    | **Yes**   |
| `Cancelled`  | **Yes**   |
| `Superseded` | **Yes**   |

`Superseded` is the sharp edge: CodePipeline's default `SUPERSEDED` execution
mode means a triggered execution can be overtaken by a later one and reach
`Superseded` **without ever reaching `Succeeded` or `Failed`**. A `watch`
implementation that only checks for two terminal states spins until poll
exhaustion on a perfectly normal supersession. `status` is typed `string` on
every response type in this module (not narrowed to this table) — see "Plain
types" below for why — so a caller's poll predicate must check against all
seven values explicitly, not rely on the type system to enumerate them.

**This table does not apply to every `status` field in this module** — two
sibling SDK enums back other `status` fields and are typed `string` for the
same reason, but carry **different** value sets: `M3LCodePipelineStageExecution.status`
(within `getPipelineState`'s result) is sourced from the SDK's
`StageExecutionStatus` — also seven values, but `Cancelled`/`Failed`/
`InProgress`/`Skipped`/`Stopped`/`Stopping`/`Succeeded` (it has `Skipped`,
which `PipelineExecutionStatus` lacks, and lacks `Superseded`, which
`PipelineExecutionStatus` has). `M3LCodePipelineActionExecution.status` is
sourced from `ActionExecutionStatus`, a **four**-value set:
`Abandoned`/`Failed`/`InProgress`/`Succeeded`. A `watch` implementation
polling `getPipelineExecution` only ever needs the seven-value table above;
one polling `getPipelineState`'s stage/action detail needs the other two sets
instead.

### The pipeline declaration is a lossy round-trip

`PipelineDeclaration` is modeled field-by-field as plain
`M3LCodePipeline*` types (re-exporting the SDK's type would violate "SDK
types are never re-exported" + ADR-0029; `unknown`/`Record<string, unknown>`
would violate "no `any` in the public API"). The modeled subset is
**intentionally bounded** — see "Out of scope (v1)" for the full list of
dropped fields.

**This makes `getPipeline` → mutate → `updatePipeline` a destructive
anti-pattern, not a supported flow.** Every field this module does not model
(triggers, the cross-region `artifactStores` map, per-stage conditions,
action `commands`/`environmentVariables`/`outputVariables`,
`OutputArtifact.files`) is **silently deleted from the live pipeline** by an
`updatePipeline` call built from a `getPipeline` result, since `UpdatePipeline`
replaces the whole declaration rather than patching it. On a V2 pipeline this
can delete production trigger configuration with no error raised anywhere in
the call chain.

`updatePipeline` therefore takes a **caller-authored complete declaration**
— the `aws codepipeline update-pipeline --cli-input-json` idiom, not a
mutated `getPipeline` result. This wrapper ships **no** get-mutate-put
convenience method, deliberately. Both `getPipeline` and `updatePipeline`
restate this contract in their own TSDoc.

`createPipeline`/`updatePipeline` both return `Promise<M3LCodePipelineDeclaration>`
(non-optional). The underlying SDK responses (`CreatePipelineOutput.pipeline`,
`UpdatePipelineOutput.pipeline`) type that payload as optional even on
success; an absent payload on an otherwise-successful call is a genuine
API/SDK anomaly and throws `M3LCodePipelineOperationError`, the same
anomaly-throw contract as `getPipeline`/`getPipelineExecution` above and as
`M3LCloudFormationCreateStackResult`'s `stackId`. `createPipeline` also
drops `CreatePipelineOutput.tags` from its return value — the caller already
knows the tags it supplied (`M3LCodePipelineCreatePipelineInput.tags`), and
this wrapper does not echo them back.

Two mapping simplifications applied uniformly (both with
`M3LCloudFormationKeyValue` precedent):

- `inputArtifacts`/`outputArtifacts` collapse the SDK's `{ name }[]` wrapper
  objects to plain `readonly string[]`.
- `ActionExecution`'s nested `errorDetails: { code?, message? }` flattens to
  sibling `errorCode?`/`errorMessage?` fields, and (separately)
  `PipelineExecutionSummary`'s nested `stopTrigger: { reason? }` flattens to
  a single `stopTriggerReason?` field on
  `M3LCodePipelineExecutionSummary` — the same flattening move, applied to a
  second nested SDK shape.

Three field renames, not 1:1 SDK-name carries: `M3LCodePipelineListExecutionsResult.executionSummaries`
sources from the SDK's `pipelineExecutionSummaries`; `M3LCodePipelineCreatePipelineInput.declaration`
sources from `CreatePipelineInput.pipeline`; `M3LCodePipelineDefinition.declaration`
sources from `GetPipelineOutput.pipeline`. All three rename `pipeline`/
`pipelineExecutionSummaries` to a name that reads correctly in this module's
own vocabulary (`declaration`, `executionSummaries`) rather than carrying the
SDK's naming forward verbatim.

## Plain types (field-by-field)

**Optionality convention**, mirroring `cloudformation.md`'s: a required-nullable
SDK **string** field (e.g. `pipelineName`, `status`, `stageName`,
`actionName`) defaults to `""` when the SDK omits it; a genuinely optional
key stays optional (not defaulted); every `Date`-typed field maps to an
optional ISO-8601 string (`someDate.toISOString()`), present only when the
SDK response includes a value.

**Enum asymmetry, deliberate**: `M3LCodePipelineStageTransitionType`
(`"Inbound" | "Outbound"`) is a **closed** union because it is write-only —
supplied by the caller to `enable`/`disableStageTransition`, so a typo
becomes a compile error rather than a runtime `ValidationException` (mirrors
`M3LCloudFormationCapability`). Every **response** status/type field
(`status`, `pipelineType`, `executionMode`, `actionTypeId.category`/
`.owner`, `artifactStore.type`) stays plain `string`, because a closed union
on a read path would turn a future server-side enum value into a type-level
lie — matching `M3LCloudFormationStackSummary.stackStatus` and
`M3LECSServiceDescription.status`. `M3LCodePipelineActionTypeId` is
bidirectional (read and write) and follows the read-path rule (`string`
fields), consistent with the asymmetry rationale above.

**Enable/disable are two distinct input types, not one shared shape**:
`M3LCodePipelineDisableStageTransitionInput.reason` is **required** — the
SDK's `DisableStageTransitionInput` declares it as such — while
`M3LCodePipelineEnableStageTransitionInput` has no `reason` field at all.

- `M3LCodePipelineListPipelinesResult` — `pipelines` always an array
  (`[]` when the SDK omits `pipelines`); `nextToken` present only when the SDK
  returns one.
- `M3LCodePipelineSummary` — `name` always present (defaulted `""`);
  `version: number`, `pipelineType`, `executionMode`, `created`, `updated`
  present only when the SDK response includes them.
- `M3LCodePipelineDefinition` — `declaration` (see below), `metadata` present
  only when the SDK response includes it.
- `M3LCodePipelineMetadata` — `pipelineArn`, `created`, `updated`,
  `pollingDisabledAt` all present only when the SDK response includes them.
- `M3LCodePipelineDeclaration` — bidirectional: on the **write** path
  (`createPipeline`/`updatePipeline` input) `name`, `roleArn` are caller-required
  strings; on the **read** path (`getPipeline`'s result) the SDK types both as
  required-nullable, so they follow the `""`-default convention above like
  any other required-nullable string. `stages` always an array; `artifactStore`,
  `version: number`, `pipelineType`, `executionMode`, `variables` present
  only when supplied. **Not a faithful round-trip of `getPipeline`** — see
  the section above.
- `M3LCodePipelineStageDeclaration` — `name` required, `actions` always an
  array.
- `M3LCodePipelineActionDeclaration` — `name`, `actionTypeId` required;
  `runOrder: number`, `configuration`, `inputArtifacts` (plain `string[]`),
  `outputArtifacts` (plain `string[]`), `roleArn`, `region`, `namespace`,
  `timeoutInMinutes: number` present only when supplied. **Out of scope for
  v1**: `commands`, `environmentVariables`, `outputVariables` (see "Out of
  scope").
- `M3LCodePipelineActionTypeId` — `category`, `owner`, `provider`, `version`
  (a `string` here, not a number — `ActionTypeId.version` is the SDK's
  action-provider version string, unrelated to `M3LCodePipelineSummary.version`/
  `M3LCodePipelineDeclaration.version`, which are pipeline version numbers)
  all required strings on both the read and write path (the SDK types this
  interface identically for input and output).
- `M3LCodePipelineArtifactStore` — `type`, `location` required;
  `encryptionKey` present only when supplied. The SDK's cross-region
  `artifactStores` map is **out of scope for v1** — only the singular
  `artifactStore` is modeled.
- `M3LCodePipelineEncryptionKey` — `id`, `type` both required.
- `M3LCodePipelineVariableDeclaration` — `name` required; `defaultValue`,
  `description` present only when supplied.
- `M3LCodePipelineTag` — `key`, `value` both required. **No collapsing
  transformation** here (unlike `M3LCloudFormationKeyValue`, which merges
  CloudFormation's separate `Parameter`/`Tag` shapes with different field
  names into one) — the SDK's `Tag` is already `{ key, value }`, so this is a
  1:1 map, required-nullable → required.
- `M3LCodePipelineCreatePipelineInput` — `declaration` required; `tags`
  present only when supplied. The SDK response's own `tags` echo is dropped
  from `createPipeline`'s return (see the section above).
- `M3LCodePipelineState` — `pipelineName` always present (defaulted `""`);
  `stageStates` always an array (`[]` when the SDK omits it — including a
  valid pipeline with zero stages, not a mapping error); `pipelineVersion: number`,
  `created`, `updated` present only when supplied.
- `M3LCodePipelineStageState` — `stageName` always present (defaulted `""`);
  `actionStates` always an array; `inboundTransitionState`,
  `latestExecution` present only when supplied. **Out of scope for v1**
  (see "Out of scope"): `inboundExecution`/`inboundExecutions`,
  `beforeEntryConditionState`/`onSuccessConditionState`/
  `onFailureConditionState`, `retryStageMetadata`.
- `M3LCodePipelineTransitionState` — `enabled`, `lastChangedBy`,
  `lastChangedAt`, `disabledReason` all present only when supplied.
- `M3LCodePipelineStageExecution` — `pipelineExecutionId`, `status` always
  present (defaulted `""`; `status` sourced from `StageExecutionStatus` — see
  the enum-scoping note above, not `PipelineExecutionStatus`); `type` present
  only when supplied.
- `M3LCodePipelineActionState` — `actionName` always present (defaulted
  `""`); `latestExecution`, `entityUrl`, `revisionUrl` present only when
  supplied. **Out of scope for v1**: `currentRevision`.
- `M3LCodePipelineActionExecution` — every field optional, present only when
  the SDK response includes it: `status` (sourced from `ActionExecutionStatus`
  — see the enum-scoping note above), `actionExecutionId`, `summary`,
  `lastStatusChange` (ISO-8601), `lastUpdatedBy`, `externalExecutionId`,
  `externalExecutionUrl`, `percentComplete: number`, `errorCode`/
  `errorMessage` (flattened from the SDK's nested `errorDetails`, see above).
  **Deliberately omits the SDK's `token` field** — the manual-approval token;
  a holder can approve a production deployment via `PutApprovalResult`, so
  this module never maps it into the public type (security-relevant
  omission). **Out of scope for v1** (not security-relevant, just unmapped):
  `logStreamARN`.
- `M3LCodePipelineExecution` — `pipelineExecutionId`, `pipelineName`,
  `status` (sourced from `PipelineExecutionStatus` — see "Watching an
  execution" above) always present (defaulted `""`); `statusSummary`,
  `pipelineVersion: number`, `executionMode`, `executionType`, `trigger`
  present only when supplied. **Deliberately omits the SDK's `variables`**
  (caller-supplied pipeline-variable resolved values, not covered by the
  library's redaction denylist) **and `artifactRevisions`** (bulk, and
  `revisionSummary` embeds commit messages) — both security-relevant
  omissions. **Out of scope for v1** (not security-relevant, just unmapped):
  `rollbackMetadata`.
- `M3LCodePipelineExecutionTrigger` — `triggerType`, `triggerDetail` present
  only when supplied.
- `M3LCodePipelineListExecutionsResult` — `executionSummaries` always an
  array (renamed from the SDK's `pipelineExecutionSummaries` — see above);
  `nextToken` present only when the SDK returns one.
- `M3LCodePipelineExecutionSummary` — `pipelineExecutionId`, `status`
  (sourced from `PipelineExecutionStatus`) always present (defaulted `""`);
  `statusSummary`, `startTime` (ISO-8601), `lastUpdateTime` (ISO-8601),
  `executionMode`, `executionType`, `trigger`, `stopTriggerReason`
  (flattened from the SDK's nested `stopTrigger: { reason? }`, see above)
  present only when supplied. **Out of scope for v1** (not security-relevant,
  just unmapped): `sourceRevisions`, `rollbackMetadata`.
- `M3LCodePipelineStartExecutionResult` — `pipelineExecutionId` always
  present — an absent value on an otherwise-successful
  `StartPipelineExecution` response is a genuine API/SDK anomaly and throws
  rather than silently omitting the field (mirrors
  `M3LCloudFormationCreateStackResult`'s `stackId` contract).
- `M3LCodePipelineStopExecutionInput` — `pipelineName`,
  `pipelineExecutionId` required; `abandon`, `reason` optional.
- `M3LCodePipelineStopExecutionResult` — `pipelineExecutionId` always
  present (same anomaly-throw contract as `StartExecutionResult`).
- `M3LCodePipelineStageTransitionType` — closed `"Inbound" | "Outbound"`
  union (see the enum-asymmetry note above).
- `M3LCodePipelineEnableStageTransitionInput` — `pipelineName`, `stageName`,
  `transitionType` all required; **no** `reason` field.
- `M3LCodePipelineDisableStageTransitionInput` — the same three fields, plus
  a **required** `reason`.

There are no pre-flight validation guards in this module beyond one narrow
exception (contrast `M3LSQSOperations`'s batch-size/duplicate-id guards):
`createPipeline`/`updatePipeline` validate six write-path enum-backed fields
(`actionTypeId.category`/`.owner`, `artifactStore.type`,
`artifactStore.encryptionKey.type`, `declaration.pipelineType`/
`.executionMode`) against the SDK's known enum members **before** ever
calling `.send()`, throwing `M3LCodePipelineOperationError` on an unknown
value. This module's read-path rule keeps these fields plain `string` on
`M3LCodePipelineDeclaration` (see the enum-asymmetry note above) to avoid a
future-server-value lie — but the SDK's own write-path input type requires
the real closed enum, so an unvalidated `as`-cast into it would silently
accept a caller typo (`"Buld"` for `"Build"`) all the way to a network round
trip before CodePipeline itself rejects it with an opaque
`ValidationException`. Validating client-side against the known member set
gives a clearer, faster failure for exactly these six fields; every other
method's only failure mode remains a rejected `.send()` call or the named
exception classifications described above.

### `M3LCodePipelineOperationError`

`code: "ERR_CODEPIPELINE_OPERATION"`. Thrown when the underlying SDK
`.send()` call rejects with anything other than a named data-classified case
— `getPipeline`/`getPipelineState`'s `PipelineNotFoundException`, or
`getPipelineExecution`'s `PipelineNotFoundException`/
`PipelineExecutionNotFoundException` (both resolve `undefined`) — chaining
the rejection as `cause`. Every mutation's exceptions (`StageNotFoundException`,
`PipelineVersionNotFoundException`, `ConcurrentPipelineExecutionsLimitExceededException`,
`ConflictException`, `DuplicatedStopRequestException`,
`PipelineExecutionNotStoppableException`, `ValidationException`, and
`PipelineNotFoundException` when raised by a mutating or listing call) always
throw — see the sections above for the full per-method breakdown.

## Out of scope (v1)

Recorded here rather than left implicit, so a future revision has a named
starting point instead of rediscovering the boundary:

- **Declaration fields**: `PipelineDeclaration.triggers` (V2 trigger
  configuration), `.artifactStores` (the cross-region map — only the
  singular `.artifactStore` is modeled), `StageDeclaration.onFailure`/
  `.onSuccess`/`.beforeEntry`/`.blockers` (stage conditions),
  `ActionDeclaration.commands`/`.environmentVariables`/`.outputVariables`
  (CodeBuild-style compute actions), `OutputArtifact.files`. See "The
  pipeline declaration is a lossy round-trip" above for the consequence of
  this boundary.
- **Approvals** — `PutApprovalResult` and the `ActionExecution.token` field
  it consumes. Deliberately never mapped (security-relevant, see "Plain
  types" above).
- **Webhooks** — `PutWebhook`/`DeleteWebhook`/`ListWebhooks`/
  `RegisterWebhookWithThirdParty`/`DeregisterWebhookWithThirdParty`.
- **Custom action types** — `CreateCustomActionType`/`DeleteCustomActionType`/
  `ListActionTypes`.
- **Third-party jobs** — `PollForThirdPartyJobs`/`AcknowledgeThirdPartyJob`/
  `GetThirdPartyJobDetails`/`PutThirdPartyJobFailureResult`/
  `PutThirdPartyJobSuccessResult`.
- **Jobs (non-third-party)** — `PollForJobs`/`AcknowledgeJob`/`GetJobDetails`/
  `PutJobFailureResult`/`PutJobSuccessResult`.
- **Tagging outside create** — `TagResource`/`UntagResource`/
  `ListTagsForResource`.
- **Options-type input fields**: `M3LCodePipelineListExecutionsOptions`
  does not model the SDK's `filter` (`PipelineExecutionFilter`);
  `M3LCodePipelineStartExecutionOptions` does not model `variables`
  (per-execution pipeline-variable overrides) or `sourceRevisions`
  (per-execution source-revision overrides). See "Options types" above.
- **State/execution response fields**: `StageState.inboundExecution`/
  `.inboundExecutions`/`.beforeEntryConditionState`/
  `.onSuccessConditionState`/`.onFailureConditionState`/
  `.retryStageMetadata`; `ActionState.currentRevision`;
  `ActionExecution.logStreamARN`; `PipelineExecution.rollbackMetadata`;
  `PipelineExecutionSummary.sourceRevisions`/`.rollbackMetadata`. None of
  these are security-relevant (unlike `ActionExecution.token`/
  `PipelineExecution.variables`/`.artifactRevisions` above) — simply unmapped
  for v1.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider.codePipeline`, the raw
  client getter this wrapper is constructed from; also reachable as
  `AWSServiceProvider.codePipeline` (`script.aws.services.codePipeline`).
- [CloudFormation Operations](./cloudformation.md) — the nearest sibling
  wrapper in shape, and the direct contrast on modeled-vs-unmodeled
  not-found classification.
- [Polling](../core/polling.md) — `M3LPoller`, which `scripts/codepipeline-ops`
  composes around `getPipelineExecution` to implement `watch` (see "Watching
  an execution" above).
