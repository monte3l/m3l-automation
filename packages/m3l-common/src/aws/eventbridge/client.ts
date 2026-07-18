/**
 * `aws/eventbridge/client` — {@link M3LEventBridgeOperations}, a typed
 * wrapper over a raw `EventBridgeClient` so callers never import
 * `@aws-sdk/client-eventbridge` command classes directly. See
 * `docs/reference/aws/eventbridge.md` for the full contract, and ADR-0026
 * (referenced by `aws/sqs`) for why this module is permitted to import
 * `core/polling` (Zone A).
 *
 * @packageDocumentation
 */

import type {
  DescribeRuleResponse,
  EventBridgeClient,
  PutTargetsResultEntry,
  RemoveTargetsResultEntry,
  Rule,
  Target,
} from "@aws-sdk/client-eventbridge";
import {
  DeleteRuleCommand,
  DescribeRuleCommand,
  DisableRuleCommand,
  EnableRuleCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from "@aws-sdk/client-eventbridge";

import { M3LEventBridgeOperationError } from "./error.js";
import type {
  M3LEventBridgeDeleteRuleOptions,
  M3LEventBridgeEventBusOptions,
  M3LEventBridgeListRulesOptions,
  M3LEventBridgeListRulesResult,
  M3LEventBridgeListTargetsOptions,
  M3LEventBridgeListTargetsResult,
  M3LEventBridgePutRuleInput,
  M3LEventBridgePutRuleResult,
  M3LEventBridgePutTargetsFailure,
  M3LEventBridgePutTargetsResult,
  M3LEventBridgeRemoveTargetsFailure,
  M3LEventBridgeRemoveTargetsOptions,
  M3LEventBridgeRemoveTargetsResult,
  M3LEventBridgeRule,
  M3LEventBridgeRuleDetail,
  M3LEventBridgeTarget,
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/** The EventBridge API cap on entries per `PutTargets`/`RemoveTargets` call. */
const MAX_BATCH_ENTRIES = 10;

/**
 * The subset of fields shared by an SDK `Rule` and a `DescribeRuleResponse`
 * — both describe one rule's name/arn/pattern/schedule/state/etc, just under
 * slightly different response envelopes.
 */
type RuleLikeFields = Pick<
  Rule & DescribeRuleResponse,
  | "Name"
  | "Arn"
  | "EventPattern"
  | "ScheduleExpression"
  | "State"
  | "Description"
  | "RoleArn"
  | "ManagedBy"
  | "EventBusName"
>;

/**
 * Translates the fields shared by an SDK `Rule`/`DescribeRuleResponse` into
 * a plain {@link M3LEventBridgeRule}, defaulting missing `Name`/`Arn` to
 * `""` rather than throwing and omitting every other field the SDK left
 * `undefined`.
 *
 * @param rule - One SDK `Rule` (from a `ListRules` response) or a
 *   `DescribeRuleResponse` — both share this field shape.
 * @returns The plain, library-owned rule shape.
 */
function mapRuleFields(rule: RuleLikeFields): M3LEventBridgeRule {
  return {
    name: rule.Name ?? "",
    arn: rule.Arn ?? "",
    ...(rule.EventPattern !== undefined && {
      eventPattern: rule.EventPattern,
    }),
    ...(rule.ScheduleExpression !== undefined && {
      scheduleExpression: rule.ScheduleExpression,
    }),
    ...(rule.State !== undefined && {
      state: rule.State,
    }),
    ...(rule.Description !== undefined && {
      description: rule.Description,
    }),
    ...(rule.RoleArn !== undefined && { roleArn: rule.RoleArn }),
    ...(rule.ManagedBy !== undefined && { managedBy: rule.ManagedBy }),
    ...(rule.EventBusName !== undefined && {
      eventBusName: rule.EventBusName,
    }),
  };
}

/**
 * Translates one SDK `Target` into a plain {@link M3LEventBridgeTarget},
 * defaulting missing `Id`/`Arn` to `""` rather than throwing.
 *
 * @param target - One SDK `Target` from a `ListTargetsByRule` response.
 * @returns The plain, library-owned target shape.
 */
function mapTarget(target: Target): M3LEventBridgeTarget {
  return {
    id: target.Id ?? "",
    arn: target.Arn ?? "",
    ...(target.RoleArn !== undefined && { roleArn: target.RoleArn }),
    ...(target.Input !== undefined && { input: target.Input }),
    ...(target.InputPath !== undefined && { inputPath: target.InputPath }),
  };
}

/**
 * Builds the SDK `Target` shape for a `PutTargets` request entry from a
 * plain {@link M3LEventBridgeTarget}.
 *
 * @param target - The caller's plain target.
 * @returns The SDK `Target`-shaped object.
 */
function toSdkTarget(target: M3LEventBridgeTarget): Target {
  return {
    Id: target.id,
    Arn: target.arn,
    ...(target.roleArn !== undefined && { RoleArn: target.roleArn }),
    ...(target.input !== undefined && { Input: target.input }),
    ...(target.inputPath !== undefined && { InputPath: target.inputPath }),
  };
}

/**
 * Validates a `putTargets`/`removeTargets` batch request before any AWS
 * call: at most 10 entries, and every id unique within the batch.
 *
 * @param ids - The batch's target ids, in order.
 * @param operation - The operation name, for the error message (`"putTargets"` or `"removeTargets"`).
 * @throws {@link M3LEventBridgeOperationError} if the batch is too large or has duplicate ids.
 */
function assertValidBatch(ids: readonly string[], operation: string): void {
  if (ids.length > MAX_BATCH_ENTRIES) {
    throw new M3LEventBridgeOperationError(
      `${operation}: at most ${String(MAX_BATCH_ENTRIES)} entries are allowed per call, got ${String(ids.length)}`,
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new M3LEventBridgeOperationError(
        `${operation}: duplicate target id "${id}" within batch`,
      );
    }
    seen.add(id);
  }
}

/**
 * Joins a `PutTargets` response's `FailedEntries[]` back to the caller's
 * original input targets, so every input target lands in exactly one of
 * `successful` or `failed`.
 *
 * @param targets - The caller's original input targets, in order.
 * @param failedEntries - The SDK response's `FailedEntries[]` (or `undefined`).
 * @returns The joined `{ successful, failed }` result.
 * @throws {@link M3LEventBridgeOperationError} if `FailedEntries[]` contains
 *   an entry whose `TargetId` is `undefined` or does not match any input
 *   target's `id` — an anomalous SDK response that would otherwise be
 *   silently dropped rather than surfaced.
 */
function joinPutTargetsResult(
  targets: readonly M3LEventBridgeTarget[],
  failedEntries: readonly PutTargetsResultEntry[] | undefined,
): M3LEventBridgePutTargetsResult {
  const failedList = failedEntries ?? [];
  const failedById = new Map(failedList.map((f) => [f.TargetId, f]));
  const successful: M3LEventBridgeTarget[] = [];
  const failed: M3LEventBridgePutTargetsFailure[] = [];
  const matchedIds = new Set<string>();

  for (const target of targets) {
    const failure = failedById.get(target.id);
    if (failure !== undefined) {
      matchedIds.add(target.id);
      failed.push({
        target,
        code: failure.ErrorCode ?? "",
        ...(failure.ErrorMessage !== undefined && {
          message: failure.ErrorMessage,
        }),
      });
    } else {
      successful.push(target);
    }
  }

  // A FailedEntries[] entry with no matching input target id (including
  // TargetId: undefined, which can never match a real caller id) would
  // otherwise be silently dropped — it lands in neither `successful` nor
  // `failed`. Treat that as a request-level failure rather than swallowing a
  // real report.
  const orphaned = failedList.filter(
    (f) => f.TargetId === undefined || !matchedIds.has(f.TargetId),
  );
  if (orphaned.length > 0) {
    throw new M3LEventBridgeOperationError(
      `putTargets: response contained ${String(orphaned.length)} FailedEntries[] entries with no matching input target id`,
      { cause: orphaned },
    );
  }

  return { successful, failed };
}

/**
 * Joins a `RemoveTargets` response's `FailedEntries[]` back to the caller's
 * original input target ids, so every input id lands in exactly one of
 * `successful` or `failed`.
 *
 * @param targetIds - The caller's original input target ids, in order.
 * @param failedEntries - The SDK response's `FailedEntries[]` (or `undefined`).
 * @returns The joined `{ successful, failed }` result.
 * @throws {@link M3LEventBridgeOperationError} if `FailedEntries[]` contains
 *   an entry whose `TargetId` is `undefined` or does not match any input id
 *   — an anomalous SDK response that would otherwise be silently dropped
 *   rather than surfaced.
 */
function joinRemoveTargetsResult(
  targetIds: readonly string[],
  failedEntries: readonly RemoveTargetsResultEntry[] | undefined,
): M3LEventBridgeRemoveTargetsResult {
  const failedList = failedEntries ?? [];
  const failedById = new Map(failedList.map((f) => [f.TargetId, f]));
  const successful: string[] = [];
  const failed: M3LEventBridgeRemoveTargetsFailure[] = [];
  const matchedIds = new Set<string>();

  for (const targetId of targetIds) {
    const failure = failedById.get(targetId);
    if (failure !== undefined) {
      matchedIds.add(targetId);
      failed.push({
        targetId,
        code: failure.ErrorCode ?? "",
        ...(failure.ErrorMessage !== undefined && {
          message: failure.ErrorMessage,
        }),
      });
    } else {
      successful.push(targetId);
    }
  }

  // See the equivalent comment in joinPutTargetsResult.
  const orphaned = failedList.filter(
    (f) => f.TargetId === undefined || !matchedIds.has(f.TargetId),
  );
  if (orphaned.length > 0) {
    throw new M3LEventBridgeOperationError(
      `removeTargets: response contained ${String(orphaned.length)} FailedEntries[] entries with no matching input target id`,
      { cause: orphaned },
    );
  }

  return { successful, failed };
}

/**
 * Typed operations over a raw EventBridge `EventBridgeClient`: rule
 * CRUD (list/describe/put/delete/enable/disable) and target management
 * (list/put/remove) — translating SDK request/response shapes into the
 * plain types in `aws/eventbridge/types`. Every method retries
 * throttling/network failures internally via
 * `M3LPollingPolicies.awsThrottling()`.
 *
 * @example
 * ```ts
 * import { M3LEventBridgeOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const eventBridgeOperations = new M3LEventBridgeOperations(script.aws.clients.eventBridge);
 * const { rules } = await eventBridgeOperations.listRules({ namePrefix: "nightly-" });
 * ```
 */
export class M3LEventBridgeOperations {
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LEventBridgeOperations` wrapping the given raw SDK
   * client.
   *
   * @param client - A constructed `EventBridgeClient` (e.g. `script.aws.clients.eventBridge`).
   */
  constructor(private readonly client: EventBridgeClient) {
    this.#runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
  }

  /**
   * Lists rules on an event bus, optionally filtered by name prefix. Issues
   * a single `ListRules` request — draining every page (looping on
   * `nextToken`) is a caller decision, mirroring
   * `M3LSQSOperations.receive`'s one-shot-call convention.
   *
   * @param options - Listing filters/pagination; see {@link M3LEventBridgeListRulesOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `ListRules` call fails.
   */
  async listRules(
    options?: M3LEventBridgeListRulesOptions,
  ): Promise<M3LEventBridgeListRulesResult> {
    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new ListRulesCommand({
            ...(options?.namePrefix !== undefined && {
              NamePrefix: options.namePrefix,
            }),
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
            ...(options?.nextToken !== undefined && {
              NextToken: options.nextToken,
            }),
            ...(options?.limit !== undefined && { Limit: options.limit }),
          }),
        ),
      );
      return {
        rules: (response.Rules ?? []).map(mapRuleFields),
        ...(response.NextToken !== undefined && {
          nextToken: response.NextToken,
        }),
      };
    } catch (cause) {
      throw new M3LEventBridgeOperationError("listRules: ListRules failed", {
        cause,
      });
    }
  }

  /**
   * Retrieves the full detail of one rule, including its creating account.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `DescribeRule` call fails.
   */
  async describeRule(
    name: string,
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<M3LEventBridgeRuleDetail> {
    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new DescribeRuleCommand({
            Name: name,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
          }),
        ),
      );
      return {
        ...mapRuleFields(response),
        ...(response.CreatedBy !== undefined && {
          createdBy: response.CreatedBy,
        }),
      };
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `describeRule: DescribeRule failed for name=${name}`,
        { cause },
      );
    }
  }

  /**
   * Creates a new rule or updates an existing one with the same name.
   *
   * @param input - The rule definition; see {@link M3LEventBridgePutRuleInput}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `PutRule` call fails.
   */
  async putRule(
    input: M3LEventBridgePutRuleInput,
  ): Promise<M3LEventBridgePutRuleResult> {
    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new PutRuleCommand({
            Name: input.name,
            ...(input.eventPattern !== undefined && {
              EventPattern: input.eventPattern,
            }),
            ...(input.scheduleExpression !== undefined && {
              ScheduleExpression: input.scheduleExpression,
            }),
            ...(input.state !== undefined && { State: input.state }),
            ...(input.description !== undefined && {
              Description: input.description,
            }),
            ...(input.roleArn !== undefined && { RoleArn: input.roleArn }),
            ...(input.eventBusName !== undefined && {
              EventBusName: input.eventBusName,
            }),
          }),
        ),
      );
      return { ruleArn: response.RuleArn ?? "" };
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `putRule: PutRule failed for name=${input.name}`,
        { cause },
      );
    }
  }

  /**
   * Deletes a rule. A rule with attached targets must have its targets
   * removed first (or use `force` for a managed rule) — EventBridge itself
   * enforces this precondition; this method does not pre-check it.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting plus the managed-rule `force` override.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `DeleteRule` call fails.
   */
  async deleteRule(
    name: string,
    options?: M3LEventBridgeDeleteRuleOptions,
  ): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.client.send(
          new DeleteRuleCommand({
            Name: name,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
            ...(options?.force !== undefined && { Force: options.force }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `deleteRule: DeleteRule failed for name=${name}`,
        { cause },
      );
    }
  }

  /**
   * Enables a rule so EventBridge resumes matching events against it.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `EnableRule` call fails.
   */
  async enableRule(
    name: string,
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.client.send(
          new EnableRuleCommand({
            Name: name,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `enableRule: EnableRule failed for name=${name}`,
        { cause },
      );
    }
  }

  /**
   * Disables a rule so EventBridge stops matching events against it,
   * without deleting it or its targets.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `DisableRule` call fails.
   */
  async disableRule(
    name: string,
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.client.send(
          new DisableRuleCommand({
            Name: name,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `disableRule: DisableRule failed for name=${name}`,
        { cause },
      );
    }
  }

  /**
   * Lists the targets attached to a rule. Issues a single
   * `ListTargetsByRule` request — draining every page is a caller decision,
   * mirroring {@link listRules}.
   *
   * @param ruleName - The rule's name.
   * @param options - Listing pagination plus event-bus targeting; see {@link M3LEventBridgeListTargetsOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `ListTargetsByRule` call fails.
   */
  async listTargetsByRule(
    ruleName: string,
    options?: M3LEventBridgeListTargetsOptions,
  ): Promise<M3LEventBridgeListTargetsResult> {
    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new ListTargetsByRuleCommand({
            Rule: ruleName,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
            ...(options?.nextToken !== undefined && {
              NextToken: options.nextToken,
            }),
            ...(options?.limit !== undefined && { Limit: options.limit }),
          }),
        ),
      );
      return {
        targets: (response.Targets ?? []).map(mapTarget),
        ...(response.NextToken !== undefined && {
          nextToken: response.NextToken,
        }),
      };
    } catch (cause) {
      throw new M3LEventBridgeOperationError(
        `listTargetsByRule: ListTargetsByRule failed for ruleName=${ruleName}`,
        { cause },
      );
    }
  }

  /**
   * Adds or updates up to 10 targets on a rule in one `PutTargets` request.
   * Per-entry failures inside a successful response are returned via
   * {@link M3LEventBridgePutTargetsResult.failed}, never thrown.
   *
   * @param ruleName - The rule's name.
   * @param targets - Up to 10 targets with unique `id`s; see {@link M3LEventBridgeTarget}.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the batch is malformed (\>10
   *   entries, duplicate ids) or the whole request fails after retries.
   */
  async putTargets(
    ruleName: string,
    targets: readonly M3LEventBridgeTarget[],
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<M3LEventBridgePutTargetsResult> {
    assertValidBatch(
      targets.map((target) => target.id),
      "putTargets",
    );

    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new PutTargetsCommand({
            Rule: ruleName,
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
            Targets: targets.map(toSdkTarget),
          }),
        ),
      );
      return joinPutTargetsResult(targets, response.FailedEntries);
    } catch (cause) {
      // joinPutTargetsResult can itself throw a specific
      // M3LEventBridgeOperationError (an orphaned FailedEntries[] entry)
      // from inside this try block — forward it unchanged rather than
      // re-wrapping it under the generic "request failed" message below,
      // which would be misleading (the request succeeded; the response
      // shape was anomalous).
      if (cause instanceof M3LEventBridgeOperationError) {
        throw cause;
      }
      throw new M3LEventBridgeOperationError(
        `putTargets: PutTargets failed for ruleName=${ruleName}`,
        { cause },
      );
    }
  }

  /**
   * Removes up to 10 targets from a rule in one `RemoveTargets` request.
   * Per-entry failures inside a successful response are returned via
   * {@link M3LEventBridgeRemoveTargetsResult.failed}, never thrown.
   *
   * @param ruleName - The rule's name.
   * @param targetIds - Up to 10 unique target ids to remove.
   * @param options - Event-bus targeting plus the managed-rule `force` override.
   * @throws {@link M3LEventBridgeOperationError} if the batch is malformed (\>10
   *   entries, duplicate ids) or the whole request fails after retries.
   */
  async removeTargets(
    ruleName: string,
    targetIds: readonly string[],
    options?: M3LEventBridgeRemoveTargetsOptions,
  ): Promise<M3LEventBridgeRemoveTargetsResult> {
    assertValidBatch(targetIds, "removeTargets");

    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new RemoveTargetsCommand({
            Rule: ruleName,
            Ids: [...targetIds],
            ...(options?.eventBusName !== undefined && {
              EventBusName: options.eventBusName,
            }),
            ...(options?.force !== undefined && { Force: options.force }),
          }),
        ),
      );
      return joinRemoveTargetsResult(targetIds, response.FailedEntries);
    } catch (cause) {
      // See the equivalent guard in putTargets: joinRemoveTargetsResult's
      // own M3LEventBridgeOperationError (orphaned FailedEntries[] entry)
      // must not be re-wrapped under the generic "request failed" message
      // below.
      if (cause instanceof M3LEventBridgeOperationError) {
        throw cause;
      }
      throw new M3LEventBridgeOperationError(
        `removeTargets: RemoveTargets failed for ruleName=${ruleName}`,
        { cause },
      );
    }
  }
}
