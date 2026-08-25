import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * Shared confirm-gate for `dynamodb-crud`'s destructive operations
 * (`delete`/`update`/`batch-delete`/`import`): describes the target table's
 * approximate size (`AWS.describeTable`) and delegates the actual
 * confirm/abort decision to the library's `Core.confirmDestructive`. Always
 * prompts, even when the approximate item count reads `0` —
 * `describeTable`'s count is periodically updated by DynamoDB, not a
 * real-time guarantee of emptiness.
 *
 * @param deps - The provisioned base `dynamoDB` client, the target table and
 *   operation name (named in the confirmation description), a logger, an
 *   injected `Core.M3LPrompt` (mirrors `script.prompt`, so this step is
 *   unit-testable without the `M3LScript` lifecycle), and the resolved
 *   `awsTarget` (mirrors `script.awsTarget`) used for target-graded
 *   confirmation — a target whose `profile` contains `"prod"` escalates to
 *   the typed-echo confirmation instead of the plain yes/no prompt.
 * @returns A promise that resolves once the operator has confirmed.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_ABORTED` —
 *   raised by `Core.confirmDestructive` (message
 *   `aborted: run '<operation>' on table '<tableName>' (~N item(s))`) — when
 *   the operator declines confirmation.
 * @throws A `describeTable` failure (e.g.
 *   `AWS.M3LDynamoDBOperationError`) propagates unmodified, and the prompt
 *   is never invoked in that case.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runDestructiveGate } from "./destructive-gate.js";
 *
 * await runDestructiveGate({
 *   dynamoDB: script.aws.clients.dynamoDB,
 *   tableName: "orders",
 *   operation: "delete",
 *   logger: new Core.M3LLogger([]),
 *   prompt: script.prompt,
 *   awsTarget: { profile: "prod" },
 * });
 * ```
 */
export async function runDestructiveGate(deps: {
  readonly dynamoDB: Parameters<typeof AWS.describeTable>[0];
  readonly tableName: string;
  readonly operation: string;
  readonly logger: Core.M3LLogger;
  readonly prompt: Core.M3LPrompt;
  readonly awsTarget: Core.M3LDestructiveTarget;
}): Promise<void> {
  const { itemCount } = await AWS.describeTable(deps.dynamoDB, deps.tableName);

  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description: `run '${deps.operation}' on table '${deps.tableName}' (~${String(itemCount)} item(s))`,
    yes: false,
    code: "ERR_DYNAMO_CRUD_ABORTED",
    target: deps.awsTarget,
    isSensitiveTarget: (target) =>
      target.profile.toLowerCase().includes("prod"),
  });
}
