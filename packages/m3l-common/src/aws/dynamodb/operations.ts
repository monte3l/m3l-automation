import type {
  DynamoDBDocumentClient,
  NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { M3LDynamoDBOperationError } from "./error.js";

/**
 * DynamoDB's own `BatchWriteItem` cap — the maximum number of items or keys
 * a single `batchWriteItems`/`batchDeleteItems` call may carry.
 */
const BATCH_WRITE_ITEM_CAP = 25;

/** A DynamoDB primary key — attribute name(s) to value, plain JS objects (no `AttributeValue` wrappers). */
export type DynamoDBKey = Record<string, unknown>;

/** A DynamoDB item — plain JS object (no `AttributeValue` wrappers). */
export type DynamoDBItem = Record<string, unknown>;

/**
 * Fetches a single item by key.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param key - The item's primary key.
 * @returns The item, or `undefined` when no item exists at `key`.
 * @throws {@link M3LDynamoDBOperationError} when the underlying `GetCommand` rejects.
 * @example
 * ```ts
 * import { getItem } from "@m3l-automation/m3l-common/aws";
 *
 * const order = await getItem(script.aws.clients.dynamoDBDocument, "orders", { id: "42" });
 * ```
 */
export async function getItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: DynamoDBKey,
): Promise<DynamoDBItem | undefined> {
  try {
    const response = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: key as Record<string, NativeAttributeValue>,
      }),
    );
    return response.Item as DynamoDBItem | undefined;
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("getItem failed", {
      cause,
      context: { tableName, key },
    });
  }
}

/**
 * Writes (creates or fully replaces) an item.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param item - The item to write, including its key attribute(s).
 * @throws {@link M3LDynamoDBOperationError} when the underlying `PutCommand` rejects.
 * @example
 * ```ts
 * import { putItem } from "@m3l-automation/m3l-common/aws";
 *
 * await putItem(script.aws.clients.dynamoDBDocument, "orders", { id: "42", status: "paid" });
 * ```
 */
export async function putItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  item: DynamoDBItem,
): Promise<void> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item as Record<string, NativeAttributeValue>,
      }),
    );
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("putItem failed", {
      cause,
      context: { tableName, item },
    });
  }
}

/**
 * Merge-patches an existing item: each top-level field of `patch` becomes a
 * generated `SET` clause in the underlying `UpdateCommand`'s
 * `UpdateExpression`.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param key - The item's primary key.
 * @param patch - Fields to set; each key becomes one `SET` clause.
 * @returns The item's attributes after the update.
 * @throws {@link M3LDynamoDBOperationError} when the underlying `UpdateCommand` rejects.
 * @example
 * ```ts
 * import { updateItem } from "@m3l-automation/m3l-common/aws";
 *
 * await updateItem(script.aws.clients.dynamoDBDocument, "orders", { id: "42" }, { status: "shipped" });
 * ```
 */
export async function updateItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: DynamoDBKey,
  patch: DynamoDBItem,
): Promise<DynamoDBItem | undefined> {
  const entries = Object.entries(patch);
  if (entries.length === 0) {
    throw new M3LDynamoDBOperationError("updateItem: patch must not be empty", {
      context: { tableName, key },
    });
  }

  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, NativeAttributeValue> = {};
  const setClauses: string[] = [];
  entries.forEach(([name, value], index) => {
    const namePlaceholder = `#n${String(index)}`;
    const valuePlaceholder = `:v${String(index)}`;
    expressionAttributeNames[namePlaceholder] = name;
    expressionAttributeValues[valuePlaceholder] = value;
    setClauses.push(`${namePlaceholder} = ${valuePlaceholder}`);
  });

  try {
    const response = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key as Record<string, NativeAttributeValue>,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );
    return response.Attributes as DynamoDBItem | undefined;
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("updateItem failed", {
      cause,
      context: { tableName, key, patch },
    });
  }
}

/**
 * Deletes a single item by key.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param key - The item's primary key.
 * @throws {@link M3LDynamoDBOperationError} when the underlying `DeleteCommand` rejects.
 * @example
 * ```ts
 * import { deleteItem } from "@m3l-automation/m3l-common/aws";
 *
 * await deleteItem(script.aws.clients.dynamoDBDocument, "orders", { id: "42" });
 * ```
 */
export async function deleteItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: DynamoDBKey,
): Promise<void> {
  try {
    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key as Record<string, NativeAttributeValue>,
      }),
    );
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("deleteItem failed", {
      cause,
      context: { tableName, key },
    });
  }
}

/** Options for {@link queryItems}. */
export interface QueryItemsOptions {
  /** Target table. */
  readonly tableName: string;
  /** Equality key condition — partition key (and, optionally, sort key). */
  readonly keyCondition: DynamoDBKey;
  /** Optional GSI/LSI name. */
  readonly indexName?: string;
  /** Page size (`Limit`). */
  readonly pageSize?: number;
}

/** One page yielded by {@link queryItems} or {@link scanSegment}. */
export interface DynamoDBPage {
  /** Items in this page. */
  readonly items: readonly DynamoDBItem[];
  /** Cursor for the next page, or `undefined` when this was the last page. */
  readonly lastEvaluatedKey: DynamoDBKey | undefined;
}

/**
 * Queries items by an equality key condition, one page at a time.
 *
 * Yields pages (not individual items) so a caller can checkpoint on
 * `lastEvaluatedKey` between pages without buffering the whole result set.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param options - Query parameters.
 * @param exclusiveStartKey - Resume cursor from a prior page (`--resume`).
 * @throws {@link M3LDynamoDBOperationError} when the underlying `QueryCommand` rejects.
 * @example
 * ```ts
 * import { queryItems } from "@m3l-automation/m3l-common/aws";
 *
 * for await (const page of queryItems(client, { tableName: "orders", keyCondition: { userId: "42" } })) {
 *   for (const item of page.items) console.log(item);
 * }
 * ```
 */
export async function* queryItems(
  client: DynamoDBDocumentClient,
  options: QueryItemsOptions,
  exclusiveStartKey?: DynamoDBKey,
): AsyncGenerator<DynamoDBPage> {
  const keyConditionEntries = Object.entries(options.keyCondition);
  if (keyConditionEntries.length === 0) {
    throw new M3LDynamoDBOperationError(
      "queryItems: keyCondition must not be empty",
      { context: { tableName: options.tableName } },
    );
  }

  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, NativeAttributeValue> = {};
  const conditionClauses: string[] = [];
  keyConditionEntries.forEach(([name, value], index) => {
    const namePlaceholder = `#k${String(index)}`;
    const valuePlaceholder = `:k${String(index)}`;
    expressionAttributeNames[namePlaceholder] = name;
    expressionAttributeValues[valuePlaceholder] = value;
    conditionClauses.push(`${namePlaceholder} = ${valuePlaceholder}`);
  });

  let startKey = exclusiveStartKey;
  do {
    try {
      const response = await client.send(
        new QueryCommand({
          TableName: options.tableName,
          KeyConditionExpression: conditionClauses.join(" AND "),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ...(options.indexName !== undefined && {
            IndexName: options.indexName,
          }),
          ...(options.pageSize !== undefined && { Limit: options.pageSize }),
          ...(startKey !== undefined && {
            ExclusiveStartKey: startKey as Record<string, NativeAttributeValue>,
          }),
        }),
      );
      startKey = response.LastEvaluatedKey as DynamoDBKey | undefined;
      yield {
        items: (response.Items ?? []) as DynamoDBItem[],
        lastEvaluatedKey: startKey,
      };
    } catch (cause) {
      if (cause instanceof M3LDynamoDBOperationError) throw cause;
      throw new M3LDynamoDBOperationError("queryItems failed", {
        cause,
        context: { tableName: options.tableName, exclusiveStartKey: startKey },
      });
    }
  } while (startKey !== undefined);
}

/** Options for {@link scanSegment}. */
export interface ScanSegmentOptions {
  /** Target table. */
  readonly tableName: string;
  /**
   * This worker's segment index and the total parallel segment count
   * (`Segment`/`TotalSegments`). Omit for an unsegmented scan — the pair is
   * structural: both are required together, or neither.
   */
  readonly parallel?: {
    readonly segment: number;
    readonly totalSegments: number;
  };
  /** Page size (`Limit`). */
  readonly pageSize?: number;
}

/**
 * Scans one segment of a table, one page at a time.
 *
 * Yields pages (not individual items) so a caller can checkpoint on
 * `lastEvaluatedKey` between pages without buffering the whole table.
 * Fanning out multiple segments in parallel is the caller's responsibility —
 * this function drives exactly one segment's page loop.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param options - Scan parameters.
 * @param exclusiveStartKey - Resume cursor from a prior page (`--resume`).
 * @throws {@link M3LDynamoDBOperationError} when the underlying `ScanCommand` rejects.
 * @example
 * ```ts
 * import { scanSegment } from "@m3l-automation/m3l-common/aws";
 *
 * for await (const page of scanSegment(client, { tableName: "orders" })) {
 *   for (const item of page.items) console.log(item);
 * }
 * ```
 */
export async function* scanSegment(
  client: DynamoDBDocumentClient,
  options: ScanSegmentOptions,
  exclusiveStartKey?: DynamoDBKey,
): AsyncGenerator<DynamoDBPage> {
  let startKey = exclusiveStartKey;
  do {
    try {
      const response = await client.send(
        new ScanCommand({
          TableName: options.tableName,
          ...(options.parallel !== undefined && {
            Segment: options.parallel.segment,
            TotalSegments: options.parallel.totalSegments,
          }),
          ...(options.pageSize !== undefined && { Limit: options.pageSize }),
          ...(startKey !== undefined && {
            ExclusiveStartKey: startKey as Record<string, NativeAttributeValue>,
          }),
        }),
      );
      startKey = response.LastEvaluatedKey as DynamoDBKey | undefined;
      yield {
        items: (response.Items ?? []) as DynamoDBItem[],
        lastEvaluatedKey: startKey,
      };
    } catch (cause) {
      if (cause instanceof M3LDynamoDBOperationError) throw cause;
      throw new M3LDynamoDBOperationError("scanSegment failed", {
        cause,
        context: { tableName: options.tableName, exclusiveStartKey: startKey },
      });
    }
  } while (startKey !== undefined);
}

/** Result of {@link batchWriteItems}. */
export interface BatchWriteResult {
  /** Items confirmed written. */
  readonly written: number;
  /** Items DynamoDB returned as `UnprocessedItems` — the caller retries these. */
  readonly unprocessed: readonly DynamoDBItem[];
}

/**
 * Writes up to 25 items in one `BatchWriteItem` request.
 *
 * Does **not** retry `UnprocessedItems` itself — that is the caller's
 * concern (typically via `Core.M3LRetryRunner`), so this function stays a
 * single, deterministic SDK round-trip.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param items - At most 25 items (the DynamoDB `BatchWriteItem` cap).
 * @throws {@link M3LDynamoDBOperationError} when the underlying `BatchWriteCommand` rejects, or when `items.length` exceeds 25.
 * @example
 * ```ts
 * import { batchWriteItems } from "@m3l-automation/m3l-common/aws";
 *
 * const { written, unprocessed } = await batchWriteItems(client, "orders", chunk);
 * ```
 */
export async function batchWriteItems(
  client: DynamoDBDocumentClient,
  tableName: string,
  items: readonly DynamoDBItem[],
): Promise<BatchWriteResult> {
  if (items.length > BATCH_WRITE_ITEM_CAP) {
    throw new M3LDynamoDBOperationError(
      "batchWriteItems: at most 25 items are allowed per batch",
      { context: { tableName, itemCount: items.length } },
    );
  }
  if (items.length === 0) {
    return { written: 0, unprocessed: [] };
  }

  try {
    const response = await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: items.map((item) => ({
            PutRequest: { Item: item as Record<string, NativeAttributeValue> },
          })),
        },
      }),
    );
    const unprocessed = (response.UnprocessedItems?.[tableName] ?? []).map(
      (request) => {
        const item = request.PutRequest?.Item;
        if (item === undefined) {
          throw new M3LDynamoDBOperationError(
            "batchWriteItems: malformed UnprocessedItems entry (missing PutRequest.Item)",
            { context: { tableName } },
          );
        }
        return item as DynamoDBItem;
      },
    );
    return {
      written: items.length - unprocessed.length,
      unprocessed,
    };
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("batchWriteItems failed", {
      cause,
      context: { tableName, itemCount: items.length },
    });
  }
}

/** Result of {@link batchDeleteItems}. */
export interface BatchDeleteResult {
  /** Keys confirmed deleted. */
  readonly deleted: number;
  /** Keys DynamoDB returned as `UnprocessedItems` — the caller retries these. */
  readonly unprocessed: readonly DynamoDBKey[];
}

/**
 * Deletes up to 25 items in one `BatchWriteItem` request (delete requests).
 *
 * Does **not** retry `UnprocessedItems` itself — same division of concerns
 * as {@link batchWriteItems}.
 *
 * @param client - A provisioned `dynamoDBDocument` client.
 * @param tableName - Target table.
 * @param keys - At most 25 keys (the DynamoDB `BatchWriteItem` cap).
 * @throws {@link M3LDynamoDBOperationError} when the underlying `BatchWriteCommand` rejects, or when `keys.length` exceeds 25.
 * @example
 * ```ts
 * import { batchDeleteItems } from "@m3l-automation/m3l-common/aws";
 *
 * const { deleted, unprocessed } = await batchDeleteItems(client, "orders", chunk);
 * ```
 */
export async function batchDeleteItems(
  client: DynamoDBDocumentClient,
  tableName: string,
  keys: readonly DynamoDBKey[],
): Promise<BatchDeleteResult> {
  if (keys.length > BATCH_WRITE_ITEM_CAP) {
    throw new M3LDynamoDBOperationError(
      "batchDeleteItems: at most 25 items (keys) are allowed per batch",
      { context: { tableName, keyCount: keys.length } },
    );
  }
  if (keys.length === 0) {
    return { deleted: 0, unprocessed: [] };
  }

  try {
    const response = await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: keys.map((key) => ({
            DeleteRequest: { Key: key as Record<string, NativeAttributeValue> },
          })),
        },
      }),
    );
    const unprocessed = (response.UnprocessedItems?.[tableName] ?? []).map(
      (request) => {
        const key = request.DeleteRequest?.Key;
        if (key === undefined) {
          throw new M3LDynamoDBOperationError(
            "batchDeleteItems: malformed UnprocessedItems entry (missing DeleteRequest.Key)",
            { context: { tableName } },
          );
        }
        return key as DynamoDBKey;
      },
    );
    return {
      deleted: keys.length - unprocessed.length,
      unprocessed,
    };
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("batchDeleteItems failed", {
      cause,
      context: { tableName, keyCount: keys.length },
    });
  }
}

/** Result of {@link describeTable}. */
export interface TableDescription {
  /** Approximate item count (updated periodically by DynamoDB, not real-time). */
  readonly itemCount: number;
  /** The table's current status (e.g. `"ACTIVE"`). */
  readonly tableStatus: string;
}

/**
 * Describes a table — used by a destructive-operation confirm gate to show
 * the target table's approximate size before a bulk delete/update/import.
 *
 * @param client - A provisioned base `dynamoDB` client (not the document client).
 * @param tableName - Target table.
 * @throws {@link M3LDynamoDBOperationError} when the underlying `DescribeTableCommand` rejects.
 * @example
 * ```ts
 * import { describeTable } from "@m3l-automation/m3l-common/aws";
 *
 * const { itemCount } = await describeTable(script.aws.clients.dynamoDB, "orders");
 * ```
 */
export async function describeTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<TableDescription> {
  try {
    const response = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    if (response.Table === undefined) {
      throw new M3LDynamoDBOperationError(
        "describeTable: response has no Table field",
        { context: { tableName } },
      );
    }
    return {
      itemCount: response.Table.ItemCount ?? 0,
      tableStatus: response.Table.TableStatus ?? "UNKNOWN",
    };
  } catch (cause) {
    if (cause instanceof M3LDynamoDBOperationError) throw cause;
    throw new M3LDynamoDBOperationError("describeTable failed", {
      cause,
      context: { tableName },
    });
  }
}
