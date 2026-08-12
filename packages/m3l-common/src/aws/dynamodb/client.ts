/**
 * `aws/dynamodb/client` — {@link M3LDynamoDBOperations}, a thin per-instance
 * wrapper over the free functions in `aws/dynamodb/operations` so a caller
 * holding a pair of already-provisioned clients (e.g.
 * `provider.services.dynamoDBOperations`) doesn't have to keep re-passing
 * them to every call (ADR-0038 AWS service tier).
 *
 * Constructed from TWO clients — a `DynamoDBDocumentClient` for every
 * item-level method, and a raw `DynamoDBClient` for `describeTable` only,
 * mirroring `aws/dynamodb/operations`'s own two-client split.
 *
 * @packageDocumentation
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type {
  BatchDeleteResult,
  BatchWriteResult,
  DynamoDBItem,
  DynamoDBKey,
  DynamoDBPage,
  QueryItemsOptions,
  ScanSegmentOptions,
  TableDescription,
} from "./operations.js";
import {
  batchDeleteItems,
  batchWriteItems,
  deleteItem,
  describeTable,
  getItem,
  putItem,
  queryItems,
  scanSegment,
  updateItem,
} from "./operations.js";

/**
 * Typed operations over an already-provisioned pair of DynamoDB clients: get,
 * put, update, delete, query, scan, batch-write, batch-delete, and
 * describe-table — every method thinly delegates to the matching free
 * function in `aws/dynamodb/operations`, forwarding `this.documentClient` (or,
 * for `describeTable` only, `this.rawClient`) as the first argument.
 *
 * @example
 * ```ts
 * import { M3LDynamoDBOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const dynamoDBOperations = new M3LDynamoDBOperations(
 *   script.aws.clients.dynamoDBDocument,
 *   script.aws.clients.dynamoDB,
 * );
 * const order = await dynamoDBOperations.getItem("orders", { id: "42" });
 * ```
 */
export class M3LDynamoDBOperations {
  /**
   * Creates a new `M3LDynamoDBOperations` wrapping the given raw SDK clients.
   *
   * @param documentClient - A constructed `DynamoDBDocumentClient` (e.g.
   *   `script.aws.clients.dynamoDBDocument`), used by every method except
   *   `describeTable`.
   * @param rawClient - A constructed `DynamoDBClient` (e.g.
   *   `script.aws.clients.dynamoDB`), used only by `describeTable`.
   */
  constructor(
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly rawClient: DynamoDBClient,
  ) {}

  /**
   * Fetches a single item by key. See {@link getItem}.
   *
   * @param tableName - Target table.
   * @param key - The item's primary key.
   * @returns The item, or `undefined` when no item exists at `key`.
   * @throws {@link M3LDynamoDBOperationError} when the underlying `GetCommand` rejects.
   * @example
   * ```ts
   * const order = await dynamoDBOperations.getItem("orders", { id: "42" });
   * ```
   */
  getItem(
    tableName: string,
    key: DynamoDBKey,
  ): Promise<DynamoDBItem | undefined> {
    return getItem(this.documentClient, tableName, key);
  }

  /**
   * Writes (creates or fully replaces) an item. See {@link putItem}.
   *
   * @param tableName - Target table.
   * @param item - The item to write, including its key attribute(s).
   * @throws {@link M3LDynamoDBOperationError} when the underlying `PutCommand` rejects.
   * @example
   * ```ts
   * await dynamoDBOperations.putItem("orders", { id: "42", status: "paid" });
   * ```
   */
  putItem(tableName: string, item: DynamoDBItem): Promise<void> {
    return putItem(this.documentClient, tableName, item);
  }

  /**
   * Merge-patches an existing item. See {@link updateItem}.
   *
   * @param tableName - Target table.
   * @param key - The item's primary key.
   * @param patch - Fields to set; each key becomes one `SET` clause.
   * @returns The item's attributes after the update.
   * @throws {@link M3LDynamoDBOperationError} when the underlying `UpdateCommand` rejects.
   * @example
   * ```ts
   * await dynamoDBOperations.updateItem("orders", { id: "42" }, { status: "shipped" });
   * ```
   */
  updateItem(
    tableName: string,
    key: DynamoDBKey,
    patch: DynamoDBItem,
  ): Promise<DynamoDBItem | undefined> {
    return updateItem(this.documentClient, tableName, key, patch);
  }

  /**
   * Deletes a single item by key. See {@link deleteItem}.
   *
   * @param tableName - Target table.
   * @param key - The item's primary key.
   * @throws {@link M3LDynamoDBOperationError} when the underlying `DeleteCommand` rejects.
   * @example
   * ```ts
   * await dynamoDBOperations.deleteItem("orders", { id: "42" });
   * ```
   */
  deleteItem(tableName: string, key: DynamoDBKey): Promise<void> {
    return deleteItem(this.documentClient, tableName, key);
  }

  /**
   * Queries items by an equality key condition, one page at a time. See {@link queryItems}.
   *
   * @param options - Query parameters.
   * @param exclusiveStartKey - Resume cursor from a prior page (`--resume`).
   * @throws {@link M3LDynamoDBOperationError} when the underlying `QueryCommand` rejects.
   * @example
   * ```ts
   * for await (const page of dynamoDBOperations.queryItems({ tableName: "orders", keyCondition: { userId: "42" } })) {
   *   for (const item of page.items) console.log(item);
   * }
   * ```
   */
  queryItems(
    options: QueryItemsOptions,
    exclusiveStartKey?: DynamoDBKey,
  ): AsyncGenerator<DynamoDBPage> {
    return queryItems(this.documentClient, options, exclusiveStartKey);
  }

  /**
   * Scans one segment of a table, one page at a time. See {@link scanSegment}.
   *
   * @param options - Scan parameters.
   * @param exclusiveStartKey - Resume cursor from a prior page (`--resume`).
   * @throws {@link M3LDynamoDBOperationError} when the underlying `ScanCommand` rejects.
   * @example
   * ```ts
   * for await (const page of dynamoDBOperations.scanSegment({ tableName: "orders" })) {
   *   for (const item of page.items) console.log(item);
   * }
   * ```
   */
  scanSegment(
    options: ScanSegmentOptions,
    exclusiveStartKey?: DynamoDBKey,
  ): AsyncGenerator<DynamoDBPage> {
    return scanSegment(this.documentClient, options, exclusiveStartKey);
  }

  /**
   * Writes up to 25 items in one `BatchWriteItem` request. See {@link batchWriteItems}.
   *
   * @param tableName - Target table.
   * @param items - At most 25 items (the DynamoDB `BatchWriteItem` cap).
   * @throws {@link M3LDynamoDBOperationError} when the underlying `BatchWriteCommand` rejects, or when `items.length` exceeds 25.
   * @example
   * ```ts
   * const { written, unprocessed } = await dynamoDBOperations.batchWriteItems("orders", chunk);
   * ```
   */
  batchWriteItems(
    tableName: string,
    items: readonly DynamoDBItem[],
  ): Promise<BatchWriteResult> {
    return batchWriteItems(this.documentClient, tableName, items);
  }

  /**
   * Deletes up to 25 items in one `BatchWriteItem` request. See {@link batchDeleteItems}.
   *
   * @param tableName - Target table.
   * @param keys - At most 25 keys (the DynamoDB `BatchWriteItem` cap).
   * @throws {@link M3LDynamoDBOperationError} when the underlying `BatchWriteCommand` rejects, or when `keys.length` exceeds 25.
   * @example
   * ```ts
   * const { deleted, unprocessed } = await dynamoDBOperations.batchDeleteItems("orders", chunk);
   * ```
   */
  batchDeleteItems(
    tableName: string,
    keys: readonly DynamoDBKey[],
  ): Promise<BatchDeleteResult> {
    return batchDeleteItems(this.documentClient, tableName, keys);
  }

  /**
   * Describes a table. Routes through the raw `DynamoDBClient` constructor
   * argument, never the document client. See {@link describeTable}.
   *
   * @param tableName - Target table.
   * @throws {@link M3LDynamoDBOperationError} when the underlying `DescribeTableCommand` rejects.
   * @example
   * ```ts
   * const { itemCount } = await dynamoDBOperations.describeTable("orders");
   * ```
   */
  describeTable(tableName: string): Promise<TableDescription> {
    return describeTable(this.rawClient, tableName);
  }
}
