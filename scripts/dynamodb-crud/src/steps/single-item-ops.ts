import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * The four single-item DynamoDB operations this step drives: a plain
 * `getItem`/`putItem`/`updateItem`/`deleteItem` round-trip against one
 * key/item. `delete`/`update` are destructive — the orchestrator
 * (`run-dynamodb-crud`) decides whether to route them through the
 * destructive-operation gate before calling this step; this step never
 * gates itself.
 */
export type SingleItemOperation = "get" | "put" | "update" | "delete";

/**
 * Narrows an optional `key`/`item` field to its defined value, or throws a
 * typed config error naming the missing field.
 *
 * @param value - The already-JSON-parsed `key`/`item` value (parsing happens
 *   in the orchestrator, never here).
 * @param name - The field name to name in the thrown error's message.
 * @returns `value`, narrowed to non-`undefined`.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when
 *   `value` is `undefined`.
 */
function requireField(
  value: Record<string, unknown> | undefined,
  name: "key" | "item",
): Record<string, unknown> {
  if (value === undefined) {
    throw new Core.M3LError(
      `runSingleItemOp: '${name}' is required for this operation`,
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }
  return value;
}

/**
 * Runs one of the four single-item DynamoDB operations against `tableName`,
 * dispatching to the matching `AWS.getItem`/`putItem`/`updateItem`/
 * `deleteItem` high-level operation.
 *
 * `key`/`item` arrive as already-JSON-parsed plain objects — parsing the
 * config-supplied JSON strings is the orchestrator's job, not this step's.
 * An `AWS.M3LDynamoDBOperationError` from the underlying operation
 * propagates unmodified (this step never catches or rewraps it).
 *
 * @param deps - The provisioned document client, the operation to run, the
 *   target table, and the already-parsed `key`/`item`.
 * @returns The resulting item: the fetched item for `get`, the echoed input
 *   for `put`, the post-update attributes for `update`, or `undefined` for
 *   `delete`.
 * @throws {@link Core.M3LError} with code `ERR_DYNAMO_CRUD_CONFIG` when a
 *   required `key`/`item` field is missing for the requested operation.
 *
 * @example
 * ```typescript
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { runSingleItemOp } from "./single-item-ops.js";
 *
 * const { item } = await runSingleItemOp({
 *   dynamoDBDocument: script.aws.clients.dynamoDBDocument,
 *   operation: "get",
 *   tableName: "orders",
 *   key: { id: "42" },
 *   item: undefined,
 * });
 * ```
 */
export async function runSingleItemOp(deps: {
  readonly dynamoDBDocument: Parameters<typeof AWS.getItem>[0];
  readonly operation: SingleItemOperation;
  readonly tableName: string;
  readonly key: Record<string, unknown> | undefined;
  readonly item: Record<string, unknown> | undefined;
}): Promise<{ readonly item: Record<string, unknown> | undefined }> {
  switch (deps.operation) {
    case "get": {
      const key = requireField(deps.key, "key");
      const item = await AWS.getItem(
        deps.dynamoDBDocument,
        deps.tableName,
        key,
      );
      return { item };
    }
    case "put": {
      const item = requireField(deps.item, "item");
      await AWS.putItem(deps.dynamoDBDocument, deps.tableName, item);
      return { item };
    }
    case "update": {
      const key = requireField(deps.key, "key");
      const patch = requireField(deps.item, "item");
      const item = await AWS.updateItem(
        deps.dynamoDBDocument,
        deps.tableName,
        key,
        patch,
      );
      return { item };
    }
    case "delete": {
      const key = requireField(deps.key, "key");
      await AWS.deleteItem(deps.dynamoDBDocument, deps.tableName, key);
      return { item: undefined };
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(
        `unhandled single-item operation: ${String(exhaustive)}`,
        { code: "ERR_DYNAMO_CRUD_CONFIG" },
      );
    }
  }
}
