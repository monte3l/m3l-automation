/**
 * `aws/eventbridge/types` — plain, library-owned types at the EventBridge
 * rules-operations boundary. None of these carry an `@aws-sdk/client-eventbridge`
 * type; every {@link M3LEventBridgeOperations} method translates SDK
 * request/response shapes into these before returning.
 *
 * Scope: EventBridge **rules** (not the separate EventBridge Scheduler
 * service — see `docs/reference/aws/eventbridge.md` § Out of scope) and
 * basic target wiring (`id`/`arn`/`roleArn`/`input`/`inputPath`). The
 * per-service target parameter blocks (Kinesis, ECS, Batch, SQS, HTTP,
 * Redshift, SageMaker, dead-letter, retry policy, AppSync, input
 * transformer, run-command) are deliberately out of scope for this
 * iteration — add fields here when a consumer needs one (ADR-0027's
 * per-consumer-need pattern).
 *
 * @packageDocumentation
 */

/**
 * A rule's enabled/disabled state, mirroring the SDK's `RuleState` value set
 * without importing it.
 */
export type M3LEventBridgeRuleState =
  "DISABLED" | "ENABLED" | "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS";

/**
 * A rule as returned by {@link M3LEventBridgeOperations.listRules} or
 * {@link M3LEventBridgeOperations.putRule}'s subsequent reads. `name`/`arn`
 * default to `""` if the SDK response omits them (a real EventBridge
 * response always populates both).
 */
export interface M3LEventBridgeRule {
  /** The rule's name. */
  readonly name: string;
  /** The rule's Amazon Resource Name (ARN). */
  readonly arn: string;
  /** The event pattern, when the rule is pattern-matched rather than scheduled. */
  readonly eventPattern?: string;
  /** The schedule expression (`cron(...)` / `rate(...)`), when the rule is scheduled. */
  readonly scheduleExpression?: string;
  /** Whether the rule is enabled, disabled, or enabled-with-all-CloudTrail-events. */
  readonly state?: M3LEventBridgeRuleState;
  /** The rule's description. */
  readonly description?: string;
  /** The ARN of the IAM role used for target invocation, when set at the rule level. */
  readonly roleArn?: string;
  /** The AWS service principal that manages this rule, if it is a managed rule. */
  readonly managedBy?: string;
  /** The name or ARN of the event bus this rule is associated with. */
  readonly eventBusName?: string;
}

/**
 * The result of {@link M3LEventBridgeOperations.describeRule}: a
 * {@link M3LEventBridgeRule} plus the account that created it.
 */
export interface M3LEventBridgeRuleDetail extends M3LEventBridgeRule {
  /** The account ID that created the rule (relevant for cross-account rules). */
  readonly createdBy?: string;
}

/** Options shared by every per-rule operation that accepts a non-default event bus. */
export interface M3LEventBridgeEventBusOptions {
  /** The name or ARN of the event bus to operate against. Defaults to the account's default event bus. */
  readonly eventBusName?: string;
}

/** Options for {@link M3LEventBridgeOperations.listRules}. */
export interface M3LEventBridgeListRulesOptions extends M3LEventBridgeEventBusOptions {
  /** Only rules whose name starts with this prefix are returned. */
  readonly namePrefix?: string;
  /** Pagination token from a previous call's {@link M3LEventBridgeListRulesResult.nextToken}. */
  readonly nextToken?: string;
  /** Maximum number of rules to return in this call. */
  readonly limit?: number;
}

/**
 * The result of one {@link M3LEventBridgeOperations.listRules} call — a
 * single page. `listRules` issues one `ListRules` request; draining every
 * page (looping on `nextToken`) is a caller decision, mirroring
 * `M3LSQSOperations.receive`'s one-shot-call convention.
 */
export interface M3LEventBridgeListRulesResult {
  /** The rules on this page. */
  readonly rules: readonly M3LEventBridgeRule[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}

/**
 * Input for {@link M3LEventBridgeOperations.putRule} (creates or updates a
 * rule). A discriminated union on `eventPattern`/`scheduleExpression`: the
 * type enforces exactly one is provided, so both-set and neither-set are
 * compile-time errors rather than an EventBridge-side runtime rejection.
 */
export type M3LEventBridgePutRuleInput = M3LEventBridgeEventBusOptions & {
  /** The name of the rule to create or update. */
  readonly name: string;
  /** The rule's initial/updated state. Defaults to `ENABLED` on the EventBridge side when omitted on create. */
  readonly state?: M3LEventBridgeRuleState;
  /** A description of the rule. */
  readonly description?: string;
  /** The ARN of the IAM role used for target invocation. */
  readonly roleArn?: string;
} & (
    | {
        /** The event pattern. The type enforces exactly one of `eventPattern`/`scheduleExpression` is provided. */
        readonly eventPattern: string;
        readonly scheduleExpression?: never;
      }
    | {
        /** The schedule expression (`cron(...)` / `rate(...)`). The type enforces exactly one of `eventPattern`/`scheduleExpression` is provided. */
        readonly scheduleExpression: string;
        readonly eventPattern?: never;
      }
  );

/** The result of {@link M3LEventBridgeOperations.putRule}. */
export interface M3LEventBridgePutRuleResult {
  /** The Amazon Resource Name (ARN) of the created/updated rule. Defaults to `""` if the SDK response omits it. */
  readonly ruleArn: string;
}

/** Options for {@link M3LEventBridgeOperations.deleteRule}. */
export interface M3LEventBridgeDeleteRuleOptions extends M3LEventBridgeEventBusOptions {
  /**
   * Required `true` to delete a managed rule (one created on the caller's
   * behalf by an AWS service). Ignored for non-managed rules.
   */
  readonly force?: boolean;
}

/**
 * A target attached to a rule. Scoped to the fields every target type
 * shares (`id`/`arn`) plus the common invocation-tuning fields
 * (`roleArn`/`input`/`inputPath`) — see the module-level scope note for the
 * per-service parameter blocks this deliberately omits.
 */
export interface M3LEventBridgeTarget {
  /** Caller-assigned identifier, unique within the rule. */
  readonly id: string;
  /** The Amazon Resource Name (ARN) of the target. */
  readonly arn: string;
  /** The ARN of the IAM role used to invoke this specific target, when it differs from the rule-level role. */
  readonly roleArn?: string;
  /** Valid JSON text passed to the target verbatim, replacing the matched event. */
  readonly input?: string;
  /** A JSONPath expression extracting part of the matched event to pass to the target. */
  readonly inputPath?: string;
}

/** Options for {@link M3LEventBridgeOperations.listTargetsByRule}. */
export interface M3LEventBridgeListTargetsOptions extends M3LEventBridgeEventBusOptions {
  /** Pagination token from a previous call's {@link M3LEventBridgeListTargetsResult.nextToken}. */
  readonly nextToken?: string;
  /** Maximum number of targets to return in this call. */
  readonly limit?: number;
}

/**
 * The result of one {@link M3LEventBridgeOperations.listTargetsByRule} call
 * — a single page, mirroring {@link M3LEventBridgeListRulesResult}'s
 * one-shot-call convention.
 */
export interface M3LEventBridgeListTargetsResult {
  /** The targets on this page. */
  readonly targets: readonly M3LEventBridgeTarget[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}

/**
 * A single failed entry from {@link M3LEventBridgeOperations.putTargets},
 * joined back to the caller's original input target so it can be logged or
 * re-driven without any id bookkeeping on the caller's side.
 */
export interface M3LEventBridgePutTargetsFailure {
  /** The original input target that failed to be added/updated. */
  readonly target: M3LEventBridgeTarget;
  /** The EventBridge error code for this entry (e.g. `"ConcurrentModificationException"`). */
  readonly code: string;
  /** Human-readable failure detail, when EventBridge provides one. */
  readonly message?: string;
}

/**
 * The result of {@link M3LEventBridgeOperations.putTargets}: every input
 * target lands in exactly one of `successful` or `failed`.
 */
export interface M3LEventBridgePutTargetsResult {
  /** Targets EventBridge accepted. */
  readonly successful: readonly M3LEventBridgeTarget[];
  /** Targets EventBridge rejected, each joined back to its original input target. */
  readonly failed: readonly M3LEventBridgePutTargetsFailure[];
}

/** Options for {@link M3LEventBridgeOperations.removeTargets}. */
export interface M3LEventBridgeRemoveTargetsOptions extends M3LEventBridgeEventBusOptions {
  /**
   * Required `true` to remove targets from a managed rule (one created on
   * the caller's behalf by an AWS service). Ignored for non-managed rules.
   */
  readonly force?: boolean;
}

/**
 * A single failed entry from {@link M3LEventBridgeOperations.removeTargets},
 * joined back to the caller's original input target id.
 */
export interface M3LEventBridgeRemoveTargetsFailure {
  /** The original input target id that failed to be removed. */
  readonly targetId: string;
  /** The EventBridge error code for this entry (e.g. `"ConcurrentModificationException"`). */
  readonly code: string;
  /** Human-readable failure detail, when EventBridge provides one. */
  readonly message?: string;
}

/**
 * The result of {@link M3LEventBridgeOperations.removeTargets}: every input
 * target id lands in exactly one of `successful` or `failed`.
 */
export interface M3LEventBridgeRemoveTargetsResult {
  /** Target ids EventBridge removed. */
  readonly successful: readonly string[];
  /** Target ids EventBridge rejected, each joined back to its original input id. */
  readonly failed: readonly M3LEventBridgeRemoveTargetsFailure[];
}
