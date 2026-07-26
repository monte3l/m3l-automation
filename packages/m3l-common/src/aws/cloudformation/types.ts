/**
 * `aws/cloudformation/types` — plain, library-owned shapes returned by
 * {@link M3LCloudFormationOperations}, translated from the raw
 * `@aws-sdk/client-cloudformation` request/response types. See
 * `docs/reference/aws/cloudformation.md` for the full field-by-field
 * contract.
 *
 * @packageDocumentation
 */

/**
 * A plain `{ key, value }` pair, used for both CloudFormation stack
 * parameters and tags (collapsing the SDK's separate
 * `ParameterKey`/`ParameterValue` and `Key`/`Value` shapes down to one form).
 * Both fields default to `""` when the SDK omits either half.
 */
export interface M3LCloudFormationKeyValue {
  readonly key: string;
  readonly value: string;
}

/**
 * A plain CloudFormation stack output — `key`/`value` always present
 * (defaulted to `""` when the SDK omits either half);
 * `description`/`exportName` present only when the SDK response includes
 * them.
 */
export interface M3LCloudFormationOutput {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly exportName?: string;
}

/**
 * One page of {@link M3LCloudFormationOperations.listStacks}. `stackSummaries`
 * is always an array (`[]` when the SDK omits `StackSummaries`); `nextToken`
 * is present only when the SDK returns one.
 */
export interface M3LCloudFormationListStacksResult {
  readonly stackSummaries: readonly M3LCloudFormationStackSummary[];
  readonly nextToken?: string;
}

/**
 * A single stack summary entry from {@link M3LCloudFormationListStacksResult}.
 * `stackName`, `stackStatus` are always present (defaulted to `""` when the
 * SDK omits them); `stackId` is a genuinely optional SDK field (not
 * defaulted — an empty string would be misleading for an identifying field);
 * the rest present only when the SDK response includes them.
 */
export interface M3LCloudFormationStackSummary {
  readonly stackName: string;
  readonly stackStatus: string;
  readonly stackId?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly creationTime?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly lastUpdatedTime?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly deletionTime?: string;
  readonly stackStatusReason?: string;
}

/**
 * A full stack description, returned by
 * {@link M3LCloudFormationOperations.describeStack}. `stackName`,
 * `stackStatus` are always present (defaulted to `""` when the SDK omits
 * them); `stackId`/`creationTime` are genuinely optional SDK fields, present
 * only when the SDK response includes them (no safe placeholder exists for
 * an absent `Date`); the rest present only when the SDK response includes
 * them.
 */
export interface M3LCloudFormationStack {
  readonly stackName: string;
  readonly stackStatus: string;
  readonly stackId?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly creationTime?: string;
  readonly description?: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly lastUpdatedTime?: string;
  readonly stackStatusReason?: string;
  readonly parameters?: readonly M3LCloudFormationKeyValue[];
  readonly outputs?: readonly M3LCloudFormationOutput[];
  readonly tags?: readonly M3LCloudFormationKeyValue[];
  readonly roleArn?: string;
  readonly disableRollback?: boolean;
  readonly enableTerminationProtection?: boolean;
}

/**
 * CloudFormation's closed capability-acknowledgment set — the three values
 * `CreateStack`/`UpdateStack` accept for `Capabilities`, mirroring the SDK's
 * `Capability` enum.
 */
export type M3LCloudFormationCapability =
  "CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM" | "CAPABILITY_AUTO_EXPAND";

/**
 * Input to {@link M3LCloudFormationOperations.createStack}. `stackName` is
 * required. CloudFormation itself requires exactly one of
 * `templateBody`/`templateUrl`, but this wrapper does not enforce that
 * mutual requirement locally — see the spec page. The rest are optional and
 * included in the SDK command only when supplied
 * (`exactOptionalPropertyTypes`-safe).
 */
export interface M3LCloudFormationCreateStackInput {
  readonly stackName: string;
  readonly templateBody?: string;
  readonly templateUrl?: string;
  readonly parameters?: readonly M3LCloudFormationKeyValue[];
  readonly capabilities?: readonly M3LCloudFormationCapability[];
  readonly roleArn?: string;
  readonly tags?: readonly M3LCloudFormationKeyValue[];
  readonly timeoutInMinutes?: number;
  readonly disableRollback?: boolean;
  readonly enableTerminationProtection?: boolean;
}

/**
 * Result of {@link M3LCloudFormationOperations.createStack}. `stackId` is
 * always present — an absent `StackId` on an otherwise-successful
 * `CreateStack` response is treated as a genuine API/SDK anomaly and throws
 * rather than silently omitting the field (see the spec page).
 */
export interface M3LCloudFormationCreateStackResult {
  readonly stackId: string;
}

/**
 * Input to {@link M3LCloudFormationOperations.updateStack}. `stackName` is
 * required; the rest are optional and included in the SDK command only when
 * supplied (`exactOptionalPropertyTypes`-safe).
 */
export interface M3LCloudFormationUpdateStackInput {
  readonly stackName: string;
  readonly templateBody?: string;
  readonly templateUrl?: string;
  readonly usePreviousTemplate?: boolean;
  readonly parameters?: readonly M3LCloudFormationKeyValue[];
  readonly capabilities?: readonly M3LCloudFormationCapability[];
  readonly roleArn?: string;
  readonly tags?: readonly M3LCloudFormationKeyValue[];
}

/**
 * Result of {@link M3LCloudFormationOperations.updateStack} — a discriminated
 * union. `{ changed: false }` is resolved (not thrown) when the SDK's
 * "No updates are to be performed" `ValidationError` is classified as data;
 * see the spec page's "updateStack and the 'no updates' ValidationError"
 * section for the exact matched pattern and its message-text caveat.
 */
export type M3LCloudFormationUpdateStackResult =
  | { readonly changed: true; readonly stackId: string }
  | { readonly changed: false };

/**
 * Options for {@link M3LCloudFormationOperations.deleteStack}. Both fields
 * optional.
 */
export interface M3LCloudFormationDeleteStackOptions {
  readonly retainResources?: readonly string[];
  readonly roleArn?: string;
}

/**
 * One page of {@link M3LCloudFormationOperations.describeStackEvents}.
 * `stackEvents` is always an array (`[]` when the SDK omits `StackEvents`);
 * `nextToken` is present only when the SDK returns one. Events are in
 * reverse chronological order (most recent first), mirroring the SDK.
 */
export interface M3LCloudFormationDescribeStackEventsResult {
  readonly stackEvents: readonly M3LCloudFormationStackEvent[];
  readonly nextToken?: string;
}

/**
 * A single stack event, from {@link M3LCloudFormationDescribeStackEventsResult}.
 * `stackId`, `eventId`, `stackName` are always present (defaulted to `""`
 * when the SDK omits them); `timestamp` is present only when the SDK
 * response includes one (no safe placeholder exists for an absent `Date`);
 * the rest present only when the SDK response includes them.
 */
export interface M3LCloudFormationStackEvent {
  readonly stackId: string;
  readonly eventId: string;
  readonly stackName: string;
  /** ISO-8601, present only when the SDK response includes a value. */
  readonly timestamp?: string;
  readonly logicalResourceId?: string;
  readonly physicalResourceId?: string;
  readonly resourceType?: string;
  readonly resourceStatus?: string;
  readonly resourceStatusReason?: string;
}

/**
 * Options for the `waitUntilStack*Complete` waiter methods. `maxWaitTime`
 * (in seconds) defaults to 3600 (60 minutes) when omitted — see the spec
 * page's "Waiters" section for how this default was derived.
 */
export interface M3LCloudFormationWaitOptions {
  readonly maxWaitTime?: number;
}

/**
 * Result of a `waitUntilStack*Complete` call. `state` is one of
 * `"SUCCESS" | "ABORTED" | "TIMEOUT"`; `reason` is present only when the
 * waiter supplies one. Any other non-`SUCCESS` terminal state (including
 * the SDK's unclassifiable `FAILURE` state) throws
 * {@link M3LCloudFormationOperationError} instead of resolving — see the
 * spec page's "Waiters" section.
 */
export interface M3LCloudFormationWaiterResult {
  readonly state: "SUCCESS" | "ABORTED" | "TIMEOUT";
  readonly reason?: string;
}
