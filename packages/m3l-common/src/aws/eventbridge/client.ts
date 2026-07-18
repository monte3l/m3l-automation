/**
 * `aws/eventbridge/client` — {@link M3LEventBridgeOperations}, a typed
 * wrapper over a raw `EventBridgeClient` so callers never import
 * `@aws-sdk/client-eventbridge` command classes directly. See
 * `docs/reference/aws/eventbridge.md` for the full contract.
 *
 * Scaffolding note: every method below is a placeholder that throws
 * {@link M3LEventBridgeOperationError} — signatures and TSDoc are the
 * contract `implementing-submodules` implements against; there is no real
 * AWS call wired up yet.
 *
 * @packageDocumentation
 */

import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";

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
  M3LEventBridgePutTargetsResult,
  M3LEventBridgeRemoveTargetsOptions,
  M3LEventBridgeRemoveTargetsResult,
  M3LEventBridgeRuleDetail,
  M3LEventBridgeTarget,
} from "./types.js";

/**
 * Typed operations over a raw EventBridge `EventBridgeClient`: rule
 * CRUD (list/describe/put/delete/enable/disable) and target management
 * (list/put/remove) — translating SDK request/response shapes into the
 * plain types in `aws/eventbridge/types`.
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
  /**
   * Creates a new `M3LEventBridgeOperations` wrapping the given raw SDK
   * client.
   *
   * @param client - A constructed `EventBridgeClient` (e.g. `script.aws.clients.eventBridge`).
   */
  constructor(private readonly client: EventBridgeClient) {}

  /**
   * Lists rules on an event bus, optionally filtered by name prefix. Issues
   * a single `ListRules` request — draining every page (looping on
   * `nextToken`) is a caller decision, mirroring
   * `M3LSQSOperations.receive`'s one-shot-call convention.
   *
   * @param options - Listing filters/pagination; see {@link M3LEventBridgeListRulesOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `ListRules` call fails.
   */
  listRules(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeListRulesOptions,
  ): Promise<M3LEventBridgeListRulesResult> {
    void this.client;
    throw new M3LEventBridgeOperationError(
      "listRules: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
  }

  /**
   * Retrieves the full detail of one rule, including its creating account.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `DescribeRule` call fails.
   */
  describeRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<M3LEventBridgeRuleDetail> {
    throw new M3LEventBridgeOperationError(
      "describeRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
  }

  /**
   * Creates a new rule or updates an existing one with the same name.
   *
   * @param input - The rule definition; see {@link M3LEventBridgePutRuleInput}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `PutRule` call fails.
   */
  putRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    input: M3LEventBridgePutRuleInput,
  ): Promise<M3LEventBridgePutRuleResult> {
    throw new M3LEventBridgeOperationError(
      "putRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
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
  deleteRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeDeleteRuleOptions,
  ): Promise<void> {
    throw new M3LEventBridgeOperationError(
      "deleteRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
  }

  /**
   * Enables a rule so EventBridge resumes matching events against it.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `EnableRule` call fails.
   */
  enableRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<void> {
    throw new M3LEventBridgeOperationError(
      "enableRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
  }

  /**
   * Disables a rule so EventBridge stops matching events against it,
   * without deleting it or its targets.
   *
   * @param name - The rule's name.
   * @param options - Event-bus targeting; see {@link M3LEventBridgeEventBusOptions}.
   * @throws {@link M3LEventBridgeOperationError} if the underlying `DisableRule` call fails.
   */
  disableRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<void> {
    throw new M3LEventBridgeOperationError(
      "disableRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
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
  listTargetsByRule(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    ruleName: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeListTargetsOptions,
  ): Promise<M3LEventBridgeListTargetsResult> {
    throw new M3LEventBridgeOperationError(
      "listTargetsByRule: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
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
  putTargets(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    ruleName: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    targets: readonly M3LEventBridgeTarget[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeEventBusOptions,
  ): Promise<M3LEventBridgePutTargetsResult> {
    throw new M3LEventBridgeOperationError(
      "putTargets: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
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
  removeTargets(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    ruleName: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    targetIds: readonly string[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder signature; implementing-submodules wires the body
    options?: M3LEventBridgeRemoveTargetsOptions,
  ): Promise<M3LEventBridgeRemoveTargetsResult> {
    throw new M3LEventBridgeOperationError(
      "removeTargets: not yet implemented — see docs/reference/aws/eventbridge.md",
    );
  }
}
