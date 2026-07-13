import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * Shared confirm-gate for `dynamo-crud`'s destructive operations
 * (`delete`/`update`/`batch-delete`/`import`): describes the target table's
 * approximate size (`AWS.describeTable`) and requires operator confirmation
 * before the caller proceeds. Always prompts, even when the approximate
 * item count reads `0` — `describeTable`'s count is periodically updated by
 * DynamoDB, not a real-time guarantee of emptiness.
 *
 * @param deps - The provisioned base `dynamoDB` client, the target table and
 *   operation name (named in the warning), a logger, and an injected
 *   `confirm` callback (mirrors `script.prompt.confirm`, so this step is
 *   unit-testable without the `M3LScript` lifecycle).
 * @returns A promise that resolves once the operator has confirmed.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_ABORTED` when
 *   `confirm` resolves `false`.
 * @throws A `describeTable` failure (e.g.
 *   `AWS.M3LDynamoDBOperationError`) propagates unmodified, and `confirm` is
 *   never called in that case.
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
 *   confirm: (message) => script.prompt.confirm(message),
 * });
 * ```
 */
export async function runDestructiveGate(deps: {
  readonly dynamoDB: Parameters<typeof AWS.describeTable>[0];
  readonly tableName: string;
  readonly operation: string;
  readonly logger: Core.M3LLogger;
  readonly confirm: (message: string) => Promise<boolean>;
}): Promise<void> {
  const { itemCount } = await AWS.describeTable(deps.dynamoDB, deps.tableName);

  deps.logger.warning(
    `about to run '${deps.operation}' against table '${deps.tableName}' (~${String(itemCount)} item(s))`,
  );

  const confirmed = await deps.confirm(
    `Proceed with '${deps.operation}' on table '${deps.tableName}'?`,
  );
  if (!confirmed) {
    throw new Core.M3LError(
      `dynamo-crud: '${deps.operation}' on table '${deps.tableName}' aborted by operator`,
      { code: "ERR_DYNAMO_CRUD_ABORTED" },
    );
  }
}
