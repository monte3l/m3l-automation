/**
 * `aws/cloudformation/client` — {@link M3LCloudFormationOperations}, a typed
 * wrapper over a raw `CloudFormationClient` so callers never import
 * `@aws-sdk/client-cloudformation` command classes directly. Scoped to the
 * CloudFormation **stack** resource — list/describe/create/update/delete,
 * stack-event streaming, and the three stack-lifecycle waiters (see
 * `docs/reference/aws/cloudformation.md`).
 *
 * @packageDocumentation
 */

import type {
  Capability,
  CloudFormationClient,
  Output,
  Parameter,
  Stack,
  StackEvent,
  StackStatus,
  StackSummary,
  Tag,
} from "@aws-sdk/client-cloudformation";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ListStacksCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";

import { M3LOperationAbortedError } from "../../core/errors/index.js";
import { M3LCloudFormationOperationError } from "./error.js";
import type {
  M3LCloudFormationCapability,
  M3LCloudFormationCreateStackInput,
  M3LCloudFormationCreateStackResult,
  M3LCloudFormationDeleteStackOptions,
  M3LCloudFormationDescribeStackEventsResult,
  M3LCloudFormationKeyValue,
  M3LCloudFormationListStacksResult,
  M3LCloudFormationOutput,
  M3LCloudFormationStack,
  M3LCloudFormationStackEvent,
  M3LCloudFormationStackSummary,
  M3LCloudFormationUpdateStackInput,
  M3LCloudFormationUpdateStackResult,
  M3LCloudFormationWaiterResult,
  M3LCloudFormationWaitOptions,
} from "./types.js";

/**
 * Default `maxWaitTime` (in seconds) passed to each SDK `waitUntilStack*`
 * waiter when the caller omits `options.maxWaitTime` — 3600 seconds (60
 * minutes), see the spec page's "Waiters" section for how this default was
 * derived.
 */
const DEFAULT_MAX_WAIT_TIME_SECONDS = 3600;

/**
 * The shape shared by the SDK's three standalone `waitUntilStack*Complete`
 * waiter functions, narrowed down to just the parts
 * {@link waitForStackTerminalState} calls through. Declared as a structural
 * type (rather than importing `WaiterConfiguration`/`DescribeStacksCommandInput`)
 * so all three waiter functions satisfy it without a cast.
 */
type StackWaiterFunction = (
  params: {
    readonly client: CloudFormationClient;
    readonly maxWaitTime: number;
    readonly abortSignal?: AbortSignal;
  },
  input: { readonly StackName: string },
) => Promise<unknown>;

/**
 * Returns `true` when the given signal is both defined and already aborted.
 * Module-private helper used to avoid the TS2367 false alarm that arises from
 * re-checking `signal.aborted` after an `await` (TS unsoundly narrows it to
 * `false` across an await boundary).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Classifies a caught error from an SDK `waitUntilStack*` waiter into a
 * resolved {@link M3LCloudFormationWaiterResult} (for `TimeoutError`/
 * `AbortError`) or re-throws as a typed error. Extracted to keep
 * {@link waitForStackTerminalState}'s cognitive complexity within the
 * project's ESLint limit.
 *
 * A `TimeoutError`/`AbortError`'s `reason` is always a fresh, static,
 * library-constructed string — never the raw SDK error message, which can
 * embed the last `DescribeStacks` response (including caller-supplied
 * `Parameters`/`Outputs` values) via `@smithy/core`'s `checkExceptions`.
 */
function handleStackWaiterCatch(
  error: unknown,
  methodName: string,
  stackName: string,
  signal: AbortSignal | undefined,
): M3LCloudFormationWaiterResult {
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      state: "TIMEOUT",
      reason: `waiter timed out before stack ${stackName} reached the expected state`,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    if (isAborted(signal)) {
      throw new M3LOperationAbortedError();
    }
    return {
      state: "ABORTED",
      reason: `waiter aborted before stack ${stackName} reached the expected state`,
    };
  }
  throw new M3LCloudFormationOperationError(
    `M3LCloudFormationOperations.${methodName}: waiter polling failed for stackName=${stackName}`,
    { cause: error },
  );
}

/**
 * Translates an SDK `Parameter`-shaped object into the plain
 * {@link M3LCloudFormationKeyValue}, both fields defaulted to `""` when the
 * SDK omits either half.
 *
 * @param parameter - The SDK's `Parameter`-shaped object.
 * @returns The plain, library-owned key/value shape.
 */
function mapKeyValueFromParameter(
  parameter: Parameter,
): M3LCloudFormationKeyValue {
  return {
    key: parameter.ParameterKey ?? "",
    value: parameter.ParameterValue ?? "",
  };
}

/**
 * Translates an SDK `Tag`-shaped object into the plain
 * {@link M3LCloudFormationKeyValue}, both fields defaulted to `""` when the
 * SDK omits either half.
 *
 * @param tag - The SDK's `Tag`-shaped object.
 * @returns The plain, library-owned key/value shape.
 */
function mapKeyValueFromTag(tag: Tag): M3LCloudFormationKeyValue {
  return {
    key: tag.Key ?? "",
    value: tag.Value ?? "",
  };
}

/**
 * Translates an SDK `Output`-shaped object into the plain
 * {@link M3LCloudFormationOutput}. `key`/`value` default to `""` when the SDK
 * omits either half; `description`/`exportName` are included only when the
 * SDK response defines them (`exactOptionalPropertyTypes`-safe).
 *
 * @param output - The SDK's `Output`-shaped object.
 * @returns The plain, library-owned output shape.
 */
function mapOutput(output: Output): M3LCloudFormationOutput {
  return {
    key: output.OutputKey ?? "",
    value: output.OutputValue ?? "",
    ...(output.Description !== undefined && {
      description: output.Description,
    }),
    ...(output.ExportName !== undefined && { exportName: output.ExportName }),
  };
}

/**
 * Builds an SDK `Parameter`-shaped object from the plain
 * {@link M3LCloudFormationKeyValue}.
 *
 * @param keyValue - The caller's plain key/value shape.
 * @returns The SDK command-input `Parameter` shape.
 */
function buildParameter(keyValue: M3LCloudFormationKeyValue): Parameter {
  return { ParameterKey: keyValue.key, ParameterValue: keyValue.value };
}

/**
 * Builds an SDK `Tag`-shaped object from the plain
 * {@link M3LCloudFormationKeyValue}.
 *
 * @param keyValue - The caller's plain key/value shape.
 * @returns The SDK command-input `Tag` shape.
 */
function buildTag(keyValue: M3LCloudFormationKeyValue): Tag {
  return { Key: keyValue.key, Value: keyValue.value };
}

/**
 * Translates an SDK `StackSummary`-shaped object into the plain
 * {@link M3LCloudFormationStackSummary}. `stackName`/`stackStatus` default to
 * `""` when the SDK omits them; `stackId` is a genuinely optional SDK field
 * (not defaulted); the rest are included only when the SDK response defines
 * them (`exactOptionalPropertyTypes`-safe).
 *
 * @param summary - The SDK's `StackSummary`-shaped object.
 * @returns The plain, library-owned stack-summary shape.
 */
function mapStackSummary(summary: StackSummary): M3LCloudFormationStackSummary {
  return {
    stackName: summary.StackName ?? "",
    stackStatus: summary.StackStatus ?? "",
    ...(summary.StackId !== undefined && { stackId: summary.StackId }),
    ...(summary.CreationTime !== undefined && {
      creationTime: summary.CreationTime.toISOString(),
    }),
    ...(summary.LastUpdatedTime !== undefined && {
      lastUpdatedTime: summary.LastUpdatedTime.toISOString(),
    }),
    ...(summary.DeletionTime !== undefined && {
      deletionTime: summary.DeletionTime.toISOString(),
    }),
    ...(summary.StackStatusReason !== undefined && {
      stackStatusReason: summary.StackStatusReason,
    }),
  };
}

/**
 * The `stackId`/`creationTime`/`description`/`lastUpdatedTime`/
 * `stackStatusReason` subset of {@link M3LCloudFormationStack}, each included
 * only when the SDK response defines the corresponding field
 * (`exactOptionalPropertyTypes`-safe). Split out of {@link mapStack} (via
 * {@link mapOptionalStackFields}) to keep cyclomatic complexity within the
 * lint budget.
 *
 * @param stack - The SDK's `Stack`-shaped object.
 * @returns The descriptive-field subset of the plain stack shape.
 */
function mapStackDescriptiveFields(
  stack: Stack,
): Pick<
  M3LCloudFormationStack,
  | "stackId"
  | "creationTime"
  | "description"
  | "lastUpdatedTime"
  | "stackStatusReason"
> {
  return {
    ...(stack.StackId !== undefined && { stackId: stack.StackId }),
    ...(stack.CreationTime !== undefined && {
      creationTime: stack.CreationTime.toISOString(),
    }),
    ...(stack.Description !== undefined && {
      description: stack.Description,
    }),
    ...(stack.LastUpdatedTime !== undefined && {
      lastUpdatedTime: stack.LastUpdatedTime.toISOString(),
    }),
    ...(stack.StackStatusReason !== undefined && {
      stackStatusReason: stack.StackStatusReason,
    }),
  };
}

/**
 * The `parameters`/`outputs`/`tags`/`roleArn`/`disableRollback`/
 * `enableTerminationProtection` subset of {@link M3LCloudFormationStack},
 * each included only when the SDK response defines the corresponding field
 * (`exactOptionalPropertyTypes`-safe). Split out of {@link mapStack} (via
 * {@link mapOptionalStackFields}) to keep cyclomatic complexity within the
 * lint budget.
 *
 * @param stack - The SDK's `Stack`-shaped object.
 * @returns The detail-field subset of the plain stack shape.
 */
function mapStackDetailFields(
  stack: Stack,
): Pick<
  M3LCloudFormationStack,
  | "parameters"
  | "outputs"
  | "tags"
  | "roleArn"
  | "disableRollback"
  | "enableTerminationProtection"
> {
  return {
    ...(stack.Parameters !== undefined && {
      parameters: stack.Parameters.map(mapKeyValueFromParameter),
    }),
    ...(stack.Outputs !== undefined && {
      outputs: stack.Outputs.map(mapOutput),
    }),
    ...(stack.Tags !== undefined && {
      tags: stack.Tags.map(mapKeyValueFromTag),
    }),
    ...(stack.RoleARN !== undefined && { roleArn: stack.RoleARN }),
    ...(stack.DisableRollback !== undefined && {
      disableRollback: stack.DisableRollback,
    }),
    ...(stack.EnableTerminationProtection !== undefined && {
      enableTerminationProtection: stack.EnableTerminationProtection,
    }),
  };
}

/**
 * The optional-field subset of {@link M3LCloudFormationStack} — every field
 * except `stackName`/`stackStatus`. Combines
 * {@link mapStackDescriptiveFields} and {@link mapStackDetailFields}.
 *
 * @param stack - The SDK's `Stack`-shaped object.
 * @returns The optional-field subset of the plain stack shape.
 */
function mapOptionalStackFields(
  stack: Stack,
): Omit<M3LCloudFormationStack, "stackName" | "stackStatus"> {
  return {
    ...mapStackDescriptiveFields(stack),
    ...mapStackDetailFields(stack),
  };
}

/**
 * Translates an SDK `Stack`-shaped object (returned by `DescribeStacks` under
 * `.Stacks[]`) into the plain {@link M3LCloudFormationStack}. `stackName`/
 * `stackStatus` default to `""` when the SDK omits them; every other field is
 * included only when the SDK response defines it
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param stack - The SDK's `Stack`-shaped object.
 * @returns The plain, library-owned stack shape.
 */
function mapStack(stack: Stack): M3LCloudFormationStack {
  return {
    stackName: stack.StackName ?? "",
    stackStatus: stack.StackStatus ?? "",
    ...mapOptionalStackFields(stack),
  };
}

/**
 * Translates an SDK `StackEvent`-shaped object into the plain
 * {@link M3LCloudFormationStackEvent}. `stackId`/`eventId`/`stackName`
 * default to `""` when the SDK omits them; the rest are included only when
 * the SDK response defines them (`exactOptionalPropertyTypes`-safe).
 *
 * @param event - The SDK's `StackEvent`-shaped object.
 * @returns The plain, library-owned stack-event shape.
 */
function mapStackEvent(event: StackEvent): M3LCloudFormationStackEvent {
  return {
    stackId: event.StackId ?? "",
    eventId: event.EventId ?? "",
    stackName: event.StackName ?? "",
    ...(event.Timestamp !== undefined && {
      timestamp: event.Timestamp.toISOString(),
    }),
    ...(event.LogicalResourceId !== undefined && {
      logicalResourceId: event.LogicalResourceId,
    }),
    ...(event.PhysicalResourceId !== undefined && {
      physicalResourceId: event.PhysicalResourceId,
    }),
    ...(event.ResourceType !== undefined && {
      resourceType: event.ResourceType,
    }),
    ...(event.ResourceStatus !== undefined && {
      resourceStatus: event.ResourceStatus,
    }),
    ...(event.ResourceStatusReason !== undefined && {
      resourceStatusReason: event.ResourceStatusReason,
    }),
  };
}

/**
 * The `Parameters`/`Capabilities`/`Tags` subset of the SDK's
 * `CreateStackCommandInput`/`UpdateStackCommandInput` (both accept the same
 * three collection fields), built from the caller's plain
 * {@link M3LCloudFormationCreateStackInput}/{@link M3LCloudFormationUpdateStackInput},
 * each included only when the caller supplied it
 * (`exactOptionalPropertyTypes`-safe). Split out of
 * {@link buildCreateStackInput}/{@link buildUpdateStackInput} to keep each
 * builder's cyclomatic complexity within the lint budget.
 *
 * @param input - The caller's `parameters`/`capabilities`/`tags` fields.
 * @returns The SDK command-input collection-field subset.
 */
function buildStackCollectionFields(input: {
  readonly parameters?: readonly M3LCloudFormationKeyValue[];
  readonly capabilities?: readonly M3LCloudFormationCapability[];
  readonly tags?: readonly M3LCloudFormationKeyValue[];
}): {
  readonly Parameters?: Parameter[];
  readonly Capabilities?: Capability[];
  readonly Tags?: Tag[];
} {
  return {
    ...(input.parameters !== undefined && {
      Parameters: input.parameters.map(buildParameter),
    }),
    ...(input.capabilities !== undefined && {
      Capabilities: [...input.capabilities],
    }),
    ...(input.tags !== undefined && {
      Tags: input.tags.map(buildTag),
    }),
  };
}

/**
 * Builds the SDK `CreateStackCommand` input from the caller's plain
 * {@link M3LCloudFormationCreateStackInput}, each optional field included
 * only when the caller supplied it (`exactOptionalPropertyTypes`-safe). Split
 * out of {@link M3LCloudFormationOperations.createStack} to keep that
 * method's cyclomatic complexity within the lint budget.
 *
 * @param input - The caller's stack creation input.
 * @returns The SDK command-input `CreateStackCommand` constructor argument.
 */
function buildCreateStackInput(input: M3LCloudFormationCreateStackInput): {
  readonly StackName: string;
  readonly TemplateBody?: string;
  readonly TemplateURL?: string;
  readonly RoleARN?: string;
  readonly TimeoutInMinutes?: number;
  readonly DisableRollback?: boolean;
  readonly EnableTerminationProtection?: boolean;
  readonly Parameters?: Parameter[];
  readonly Capabilities?: Capability[];
  readonly Tags?: Tag[];
} {
  return {
    StackName: input.stackName,
    ...(input.templateBody !== undefined && {
      TemplateBody: input.templateBody,
    }),
    ...(input.templateUrl !== undefined && {
      TemplateURL: input.templateUrl,
    }),
    ...(input.roleArn !== undefined && { RoleARN: input.roleArn }),
    ...(input.timeoutInMinutes !== undefined && {
      TimeoutInMinutes: input.timeoutInMinutes,
    }),
    ...(input.disableRollback !== undefined && {
      DisableRollback: input.disableRollback,
    }),
    ...(input.enableTerminationProtection !== undefined && {
      EnableTerminationProtection: input.enableTerminationProtection,
    }),
    ...buildStackCollectionFields(input),
  };
}

/**
 * Builds the SDK `UpdateStackCommand` input from the caller's plain
 * {@link M3LCloudFormationUpdateStackInput}, each optional field included
 * only when the caller supplied it (`exactOptionalPropertyTypes`-safe). Split
 * out of {@link M3LCloudFormationOperations.updateStack} to keep that
 * method's cyclomatic complexity within the lint budget.
 *
 * @param input - The caller's stack update input.
 * @returns The SDK command-input `UpdateStackCommand` constructor argument.
 */
function buildUpdateStackInput(input: M3LCloudFormationUpdateStackInput): {
  readonly StackName: string;
  readonly TemplateBody?: string;
  readonly TemplateURL?: string;
  readonly UsePreviousTemplate?: boolean;
  readonly RoleARN?: string;
  readonly Parameters?: Parameter[];
  readonly Capabilities?: Capability[];
  readonly Tags?: Tag[];
} {
  return {
    StackName: input.stackName,
    ...(input.templateBody !== undefined && {
      TemplateBody: input.templateBody,
    }),
    ...(input.templateUrl !== undefined && {
      TemplateURL: input.templateUrl,
    }),
    ...(input.usePreviousTemplate !== undefined && {
      UsePreviousTemplate: input.usePreviousTemplate,
    }),
    ...(input.roleArn !== undefined && { RoleARN: input.roleArn }),
    ...buildStackCollectionFields(input),
  };
}

/**
 * Runs one of the SDK's standalone `waitUntilStack*Complete` waiter
 * functions, translating its own `TimeoutError`/`AbortError` rejections into
 * a resolved {@link M3LCloudFormationWaiterResult} and wrapping any other
 * rejection (including the SDK's unclassifiable `FAILURE` terminal state) as
 * a thrown {@link M3LCloudFormationOperationError}. Shared by all three
 * `waitUntilStack*Complete` methods to keep each one a thin, one-line
 * delegation (see `docs/reference/aws/cloudformation.md`'s "Waiters"
 * section).
 *
 * @param waiterFunction - The SDK waiter function to run (one of
 *   `waitUntilStackCreateComplete`/`waitUntilStackUpdateComplete`/`waitUntilStackDeleteComplete`).
 * @param client - The raw `CloudFormationClient` the waiter polls through.
 * @param methodName - The calling method's name, folded into both the
 *   thrown error's message and the `M3LCloudFormationOperationError` prefix.
 * @param stackName - The stack name or ID to wait on.
 * @param options - Optional `maxWaitTime` (seconds; defaults to 3600). When
 *   `options.signal` is supplied and aborts while the SDK waiter is polling,
 *   this function throws {@link M3LOperationAbortedError} instead of resolving.
 * @returns `{ state: "SUCCESS" }`, or a resolved `TIMEOUT`/`ABORTED` state
 *   (the `"ABORTED"` state is reachable only when an `AbortError` arrives
 *   with no aborted caller signal).
 * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
 *   while the SDK waiter is polling.
 * @throws {@link M3LCloudFormationOperationError} on any other non-`SUCCESS`
 *   terminal state. On the SDK's `FAILURE` terminal state specifically, the
 *   thrown error's `cause` embeds the entire last `DescribeStacksCommand`
 *   response verbatim (the SDK waiter machinery's own behavior, not this
 *   wrapper's) — including any `Parameters`/`Outputs` values the caller
 *   supplied — and this is not covered by the library's redaction denylist
 *   (see `docs/reference/aws/cloudformation.md`'s "Waiters" section).
 */
async function waitForStackTerminalState(
  waiterFunction: StackWaiterFunction,
  client: CloudFormationClient,
  methodName: string,
  stackName: string,
  options: M3LCloudFormationWaitOptions | undefined,
): Promise<M3LCloudFormationWaiterResult> {
  const signal = options?.signal;
  try {
    await waiterFunction(
      {
        client,
        maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
        ...(signal !== undefined ? { abortSignal: signal } : {}),
      },
      { StackName: stackName },
    );
  } catch (error) {
    return handleStackWaiterCatch(error, methodName, stackName, signal);
  }

  return { state: "SUCCESS" };
}

/**
 * Options for {@link M3LCloudFormationOperations.listStacks}.
 */
export interface M3LCloudFormationListStacksOptions {
  readonly stackStatusFilter?: readonly string[];
  readonly nextToken?: string;
}

/**
 * Options for {@link M3LCloudFormationOperations.describeStackEvents}.
 */
export interface M3LCloudFormationDescribeStackEventsOptions {
  readonly nextToken?: string;
}

/**
 * Typed wrapper over a raw `CloudFormationClient`. Constructed once from a
 * provider-vended client (e.g. `script.aws.clients.cloudFormation`) and
 * reused across calls; holds no state of its own beyond the client
 * reference.
 *
 * @example
 * ```ts
 * import { M3LCloudFormationOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const cloudFormation = new M3LCloudFormationOperations(script.aws.clients.cloudFormation);
 * const { stackSummaries } = await cloudFormation.listStacks();
 * ```
 */
export class M3LCloudFormationOperations {
  readonly #client: CloudFormationClient;

  /**
   * Creates a new `M3LCloudFormationOperations` over the given raw client.
   *
   * @param client - The raw `CloudFormationClient` to wrap (e.g.
   *   `script.aws.clients.cloudFormation`).
   */
  constructor(client: CloudFormationClient) {
    this.#client = client;
  }

  /**
   * Lists stacks, one `NextToken` page per call (no auto-pagination).
   *
   * @param options - Optional `stackStatusFilter` and `nextToken`.
   * @returns The page of stack summaries plus an optional `nextToken`.
   * @throws {@link M3LCloudFormationOperationError} on a rejected `.send()` call.
   */
  async listStacks(
    options?: M3LCloudFormationListStacksOptions,
  ): Promise<M3LCloudFormationListStacksResult> {
    let response;
    try {
      response = await this.#client.send(
        new ListStacksCommand({
          ...(options?.nextToken !== undefined && {
            NextToken: options.nextToken,
          }),
          ...(options?.stackStatusFilter !== undefined && {
            StackStatusFilter: [...options.stackStatusFilter] as StackStatus[],
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCloudFormationOperationError(
        "M3LCloudFormationOperations.listStacks: ListStacks failed",
        { cause },
      );
    }

    return {
      stackSummaries: (response.StackSummaries ?? []).map(mapStackSummary),
      ...(response.NextToken !== undefined && {
        nextToken: response.NextToken,
      }),
    };
  }

  /**
   * Describes a single stack by name or ID.
   *
   * @param stackName - The stack name or ID to describe.
   * @returns The stack description, or `undefined` when CloudFormation
   *   cannot resolve the given identifier (see the spec page's "describeStack
   *   and the 'does not exist' ValidationError" section).
   * @throws {@link M3LCloudFormationOperationError} on any other rejected
   *   `.send()` call.
   */
  async describeStack(
    stackName: string,
  ): Promise<M3LCloudFormationStack | undefined> {
    let response;
    try {
      response = await this.#client.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "ValidationError" &&
        cause.message.includes("does not exist")
      ) {
        return undefined;
      }
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.describeStack: DescribeStacks failed for stackName=${stackName}`,
        { cause },
      );
    }

    const stack = response.Stacks?.[0];
    return stack === undefined ? undefined : mapStack(stack);
  }

  /**
   * Creates a new stack.
   *
   * @param input - The stack creation input.
   * @returns The created stack's `stackId`.
   * @throws {@link M3LCloudFormationOperationError} on a rejected `.send()`
   *   call, or when the SDK response omits `StackId` on an otherwise-successful
   *   call (a genuine API/SDK anomaly).
   */
  async createStack(
    input: M3LCloudFormationCreateStackInput,
  ): Promise<M3LCloudFormationCreateStackResult> {
    let response;
    try {
      response = await this.#client.send(
        new CreateStackCommand(buildCreateStackInput(input)),
      );
    } catch (cause) {
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.createStack: CreateStack failed for stackName=${input.stackName}`,
        { cause },
      );
    }

    if (response.StackId === undefined) {
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.createStack: CreateStack succeeded but returned no StackId for stackName=${input.stackName}`,
      );
    }

    return { stackId: response.StackId };
  }

  /**
   * Updates an existing stack.
   *
   * @param input - The stack update input.
   * @returns `{ changed: true, stackId }` on a genuine update, or
   *   `{ changed: false }` when CloudFormation reports no updates are to be
   *   performed (see the spec page's "updateStack and the 'no updates'
   *   ValidationError" section).
   * @throws {@link M3LCloudFormationOperationError} on any other rejected
   *   `.send()` call.
   */
  async updateStack(
    input: M3LCloudFormationUpdateStackInput,
  ): Promise<M3LCloudFormationUpdateStackResult> {
    let response;
    try {
      response = await this.#client.send(
        new UpdateStackCommand(buildUpdateStackInput(input)),
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "ValidationError" &&
        cause.message.includes("No updates are to be performed")
      ) {
        return { changed: false };
      }
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.updateStack: UpdateStack failed for stackName=${input.stackName}`,
        { cause },
      );
    }

    if (response.StackId === undefined) {
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.updateStack: UpdateStack succeeded but returned no StackId for stackName=${input.stackName}`,
      );
    }

    return { changed: true, stackId: response.StackId };
  }

  /**
   * Deletes a stack. **Destructive** — this wrapper performs no confirmation
   * gate of its own (see the spec page).
   *
   * @param stackName - The stack name or ID to delete.
   * @param options - Optional `retainResources`/`roleArn`.
   * @throws {@link M3LCloudFormationOperationError} on a rejected `.send()`
   *   call. Deleting an already-absent stack is a CloudFormation no-op
   *   success, not an error.
   */
  async deleteStack(
    stackName: string,
    options?: M3LCloudFormationDeleteStackOptions,
  ): Promise<void> {
    try {
      await this.#client.send(
        new DeleteStackCommand({
          StackName: stackName,
          ...(options?.retainResources !== undefined && {
            RetainResources: [...options.retainResources],
          }),
          ...(options?.roleArn !== undefined && {
            RoleARN: options.roleArn,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.deleteStack: DeleteStack failed for stackName=${stackName}`,
        { cause },
      );
    }
  }

  /**
   * Lists a stack's events, one `NextToken` page per call (no
   * auto-pagination), most recent first.
   *
   * @param stackName - The stack name or ID whose events to list.
   * @param options - Optional `nextToken`.
   * @returns The page of stack events plus an optional `nextToken`.
   * @throws {@link M3LCloudFormationOperationError} on a rejected `.send()` call.
   */
  async describeStackEvents(
    stackName: string,
    options?: M3LCloudFormationDescribeStackEventsOptions,
  ): Promise<M3LCloudFormationDescribeStackEventsResult> {
    let response;
    try {
      response = await this.#client.send(
        new DescribeStackEventsCommand({
          StackName: stackName,
          ...(options?.nextToken !== undefined && {
            NextToken: options.nextToken,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LCloudFormationOperationError(
        `M3LCloudFormationOperations.describeStackEvents: DescribeStackEvents failed for stackName=${stackName}`,
        { cause },
      );
    }

    return {
      stackEvents: (response.StackEvents ?? []).map(mapStackEvent),
      ...(response.NextToken !== undefined && {
        nextToken: response.NextToken,
      }),
    };
  }

  /**
   * Waits for a stack to reach `CREATE_COMPLETE`, wrapping the SDK's own
   * `waitUntilStackCreateComplete` waiter (see the spec page's "Waiters"
   * section).
   *
   * @param stackName - The stack name or ID to wait on.
   * @param options - Optional `maxWaitTime` (seconds; defaults to 3600). When
   *   `options.signal` is supplied and aborts while the SDK waiter is polling,
   *   this method throws {@link M3LOperationAbortedError} instead of resolving.
   * @returns `{ state: "SUCCESS" }`, or a resolved `TIMEOUT`/`ABORTED` state.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LCloudFormationOperationError} on any other non-`SUCCESS`
   *   terminal state.
   */
  waitUntilStackCreateComplete(
    stackName: string,
    options?: M3LCloudFormationWaitOptions,
  ): Promise<M3LCloudFormationWaiterResult> {
    return waitForStackTerminalState(
      waitUntilStackCreateComplete,
      this.#client,
      "waitUntilStackCreateComplete",
      stackName,
      options,
    );
  }

  /**
   * Waits for a stack to reach `UPDATE_COMPLETE`, wrapping the SDK's own
   * `waitUntilStackUpdateComplete` waiter (see the spec page's "Waiters"
   * section).
   *
   * @param stackName - The stack name or ID to wait on.
   * @param options - Optional `maxWaitTime` (seconds; defaults to 3600). When
   *   `options.signal` is supplied and aborts while the SDK waiter is polling,
   *   this method throws {@link M3LOperationAbortedError} instead of resolving.
   * @returns `{ state: "SUCCESS" }`, or a resolved `TIMEOUT`/`ABORTED` state.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LCloudFormationOperationError} on any other non-`SUCCESS`
   *   terminal state.
   */
  waitUntilStackUpdateComplete(
    stackName: string,
    options?: M3LCloudFormationWaitOptions,
  ): Promise<M3LCloudFormationWaiterResult> {
    return waitForStackTerminalState(
      waitUntilStackUpdateComplete,
      this.#client,
      "waitUntilStackUpdateComplete",
      stackName,
      options,
    );
  }

  /**
   * Waits for a stack to reach `DELETE_COMPLETE`, wrapping the SDK's own
   * `waitUntilStackDeleteComplete` waiter (see the spec page's "Waiters"
   * section).
   *
   * @param stackName - The stack name or ID to wait on.
   * @param options - Optional `maxWaitTime` (seconds; defaults to 3600). When
   *   `options.signal` is supplied and aborts while the SDK waiter is polling,
   *   this method throws {@link M3LOperationAbortedError} instead of resolving.
   * @returns `{ state: "SUCCESS" }`, or a resolved `TIMEOUT`/`ABORTED` state.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LCloudFormationOperationError} on any other non-`SUCCESS`
   *   terminal state.
   */
  waitUntilStackDeleteComplete(
    stackName: string,
    options?: M3LCloudFormationWaitOptions,
  ): Promise<M3LCloudFormationWaiterResult> {
    return waitForStackTerminalState(
      waitUntilStackDeleteComplete,
      this.#client,
      "waitUntilStackDeleteComplete",
      stackName,
      options,
    );
  }
}
