import { describe, test, expect, vi, expectTypeOf } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
import {
  getItem,
  putItem,
  updateItem,
  deleteItem,
  queryItems,
  scanSegment,
  batchWriteItems,
  batchDeleteItems,
  describeTable,
  M3LDynamoDBOperationError,
  M3LDynamoDBOperations,
  type DynamoDBPage,
} from "../src/aws/dynamodb/index.js";

/**
 * Full contract suite for `aws/dynamodb` (W2 library friction: dynamodb-crud
 * needs item operations without importing the AWS SDK directly), per
 * `docs/reference/aws/dynamodb.md`.
 */
describe("aws/dynamodb", () => {
  test("getItem returns the stored item (happy path)", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({ Item: { id: "42", status: "paid" } }),
    } as unknown as DynamoDBDocumentClient;

    const result = await getItem(client, "orders", { id: "42" });

    expect(result).toEqual({ id: "42", status: "paid" });
  });

  test("every thrown error is an M3LDynamoDBOperationError with code ERR_DYNAMODB_OPERATION", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as DynamoDBDocumentClient;

    await expect(getItem(client, "orders", { id: "42" })).rejects.toThrow(
      M3LDynamoDBOperationError,
    );
    await expect(getItem(client, "orders", { id: "42" })).rejects.toMatchObject(
      { code: "ERR_DYNAMODB_OPERATION" },
    );
  });

  test("queryItems yields pages shaped as { items, lastEvaluatedKey } (type contract)", () => {
    expectTypeOf(queryItems).returns.toEqualTypeOf<
      AsyncGenerator<DynamoDBPage>
    >();
  });

  describe("getItem", () => {
    test("constructs a GetCommand with the table name and key (command shape)", async () => {
      const send = vi
        .fn()
        .mockResolvedValue({ Item: { id: "42", status: "paid" } });
      const client = { send } as unknown as DynamoDBDocumentClient;

      await getItem(client, "orders", { id: "42" });

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0] as GetCommand;
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input).toEqual({ TableName: "orders", Key: { id: "42" } });
    });

    test("returns undefined when no item exists at the key", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await getItem(client, "orders", { id: "missing" });

      expect(result).toBeUndefined();
    });

    test("wraps a rejected GetCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ProvisionedThroughputExceeded");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await getItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await getItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });
  });

  describe("putItem", () => {
    test("constructs a PutCommand with the table name and item (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await putItem(client, "orders", {
        id: "42",
        status: "paid",
      });

      expect(result).toBeUndefined();
      const command = send.mock.calls[0]?.[0] as PutCommand;
      expect(command).toBeInstanceOf(PutCommand);
      expect(command.input).toEqual({
        TableName: "orders",
        Item: { id: "42", status: "paid" },
      });
    });

    test("wraps a rejected PutCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ConditionalCheckFailed");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await putItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await putItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });
  });

  describe("updateItem", () => {
    test("builds a placeholder-everything UpdateExpression from the patch (happy path)", async () => {
      const send = vi
        .fn()
        .mockResolvedValue({ Attributes: { id: "42", status: "shipped" } });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await updateItem(
        client,
        "orders",
        { id: "42" },
        { status: "shipped", amount: 100 },
      );

      expect(result).toEqual({ id: "42", status: "shipped" });
      const command = send.mock.calls[0]?.[0] as UpdateCommand;
      expect(command).toBeInstanceOf(UpdateCommand);
      expect(command.input).toEqual({
        TableName: "orders",
        Key: { id: "42" },
        UpdateExpression: "SET #n0 = :v0, #n1 = :v1",
        ExpressionAttributeNames: { "#n0": "status", "#n1": "amount" },
        ExpressionAttributeValues: { ":v0": "shipped", ":v1": 100 },
        ReturnValues: "ALL_NEW",
      });
    });

    test("returns undefined when the underlying UpdateCommand returns no Attributes", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await updateItem(
        client,
        "orders",
        { id: "42" },
        { status: "shipped" },
      );

      expect(result).toBeUndefined();
    });

    test("throws a precondition M3LDynamoDBOperationError for an empty patch, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await updateItem(client, "orders", { id: "42" }, {});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).message).toMatch(
        /patch must not be empty/i,
      );
      expect(send).not.toHaveBeenCalled();
    });

    test("wraps a rejected UpdateCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ItemNotFound");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await updateItem(client, "orders", { id: "42" }, { status: "shipped" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await updateItem(client, "orders", { id: "42" }, { status: "shipped" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });
  });

  describe("deleteItem", () => {
    test("constructs a DeleteCommand with the table name and key (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await deleteItem(client, "orders", { id: "42" });

      expect(result).toBeUndefined();
      const command = send.mock.calls[0]?.[0] as DeleteCommand;
      expect(command).toBeInstanceOf(DeleteCommand);
      expect(command.input).toEqual({ TableName: "orders", Key: { id: "42" } });
    });

    test("wraps a rejected DeleteCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ResourceNotFound");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await deleteItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await deleteItem(client, "orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });
  });

  describe("queryItems", () => {
    test("builds a placeholder-everything equality KeyConditionExpression (happy path, single page)", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [{ userId: "42", status: "paid" }],
        LastEvaluatedKey: undefined,
      });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      for await (const page of queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42", status: "paid" },
        indexName: "byUser",
        pageSize: 10,
      })) {
        pages.push(page);
      }

      expect(pages).toEqual([
        {
          items: [{ userId: "42", status: "paid" }],
          lastEvaluatedKey: undefined,
        },
      ]);
      const command = send.mock.calls[0]?.[0] as QueryCommand;
      expect(command).toBeInstanceOf(QueryCommand);
      expect(command.input).toEqual({
        TableName: "orders",
        KeyConditionExpression: "#k0 = :k0 AND #k1 = :k1",
        ExpressionAttributeNames: { "#k0": "userId", "#k1": "status" },
        ExpressionAttributeValues: { ":k0": "42", ":k1": "paid" },
        IndexName: "byUser",
        Limit: 10,
      });
    });

    test("does not call send until the generator is iterated", () => {
      const send = vi.fn().mockResolvedValue({ Items: [] });
      const client = { send } as unknown as DynamoDBDocumentClient;

      queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42" },
      });

      expect(send).not.toHaveBeenCalled();
    });

    test("paginates across multiple pages, carrying ExclusiveStartKey forward, and terminates", async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({
          Items: [{ userId: "42", seq: 1 }],
          LastEvaluatedKey: { userId: "42", seq: 1 },
        })
        .mockResolvedValueOnce({
          Items: [{ userId: "42", seq: 2 }],
          LastEvaluatedKey: undefined,
        });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      const generator = queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42" },
      });
      for await (const page of generator) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toEqual({
        items: [{ userId: "42", seq: 1 }],
        lastEvaluatedKey: { userId: "42", seq: 1 },
      });
      expect(pages[1]).toEqual({
        items: [{ userId: "42", seq: 2 }],
        lastEvaluatedKey: undefined,
      });
      expect(send).toHaveBeenCalledTimes(2);
      const secondCommand = send.mock.calls[1]?.[0] as QueryCommand;
      expect(secondCommand.input.ExclusiveStartKey).toEqual({
        userId: "42",
        seq: 1,
      });

      const done = await generator.next();
      expect(done).toEqual({ done: true, value: undefined });
    });

    test("rejects with M3LDynamoDBOperationError on iteration when the underlying QueryCommand rejects", async () => {
      const sdkError = new Error("ThrottlingException");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      const generator = queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42" },
      });

      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      const generator = queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42" },
      });

      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });

    test("yields items: [] when the response omits the Items key entirely", async () => {
      const send = vi.fn().mockResolvedValue({ LastEvaluatedKey: undefined });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      for await (const page of queryItems(client, {
        tableName: "orders",
        keyCondition: { userId: "42" },
      })) {
        pages.push(page);
      }

      expect(pages).toEqual([{ items: [], lastEvaluatedKey: undefined }]);
    });

    test("throws a precondition M3LDynamoDBOperationError for an empty keyCondition, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;

      const generator = queryItems(client, {
        tableName: "orders",
        keyCondition: {},
      });

      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("scanSegment", () => {
    test("constructs a ScanCommand with segment/totalSegments/limit (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [{ id: "1" }],
        LastEvaluatedKey: undefined,
      });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      for await (const page of scanSegment(client, {
        tableName: "orders",
        parallel: { segment: 0, totalSegments: 4 },
        pageSize: 50,
      })) {
        pages.push(page);
      }

      expect(pages).toEqual([
        { items: [{ id: "1" }], lastEvaluatedKey: undefined },
      ]);
      const command = send.mock.calls[0]?.[0] as ScanCommand;
      expect(command).toBeInstanceOf(ScanCommand);
      expect(command.input).toEqual({
        TableName: "orders",
        Segment: 0,
        TotalSegments: 4,
        Limit: 50,
      });
    });

    test("paginates across multiple pages and terminates", async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({
          Items: [{ id: "1" }],
          LastEvaluatedKey: { id: "1" },
        })
        .mockResolvedValueOnce({
          Items: [{ id: "2" }],
          LastEvaluatedKey: undefined,
        });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      const generator = scanSegment(client, { tableName: "orders" });
      for await (const page of generator) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
      const done = await generator.next();
      expect(done).toEqual({ done: true, value: undefined });
    });

    test("rejects with M3LDynamoDBOperationError on iteration when the underlying ScanCommand rejects", async () => {
      const sdkError = new Error("InternalServerError");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      const generator = scanSegment(client, { tableName: "orders" });

      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      const generator = scanSegment(client, { tableName: "orders" });

      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });

    test("yields items: [] when the response omits the Items key entirely", async () => {
      const send = vi.fn().mockResolvedValue({ LastEvaluatedKey: undefined });
      const client = { send } as unknown as DynamoDBDocumentClient;

      const pages: DynamoDBPage[] = [];
      for await (const page of scanSegment(client, { tableName: "orders" })) {
        pages.push(page);
      }

      expect(pages).toEqual([{ items: [], lastEvaluatedKey: undefined }]);
    });
  });

  describe("batchWriteItems", () => {
    test("constructs a BatchWriteCommand of PutRequests and maps written/unprocessed (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({
        UnprocessedItems: { orders: [{ PutRequest: { Item: { id: "2" } } }] },
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const items = [{ id: "1" }, { id: "2" }];

      const result = await batchWriteItems(client, "orders", items);

      expect(result).toEqual({ written: 1, unprocessed: [{ id: "2" }] });
      const command = send.mock.calls[0]?.[0] as BatchWriteCommand;
      expect(command).toBeInstanceOf(BatchWriteCommand);
      expect(command.input).toEqual({
        RequestItems: {
          orders: [
            { PutRequest: { Item: { id: "1" } } },
            { PutRequest: { Item: { id: "2" } } },
          ],
        },
      });
    });

    test("rejects with a cap-specific message when given more than 25 items, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;
      const items = Array.from({ length: 26 }, (_, i) => ({ id: String(i) }));

      await expect(batchWriteItems(client, "orders", items)).rejects.toThrow(
        /at most 25 items/i,
      );
      expect(send).not.toHaveBeenCalled();
    });

    test("short-circuits to { written: 0, unprocessed: [] } for an empty items array, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await batchWriteItems(client, "orders", []);

      expect(result).toEqual({ written: 0, unprocessed: [] });
      expect(send).not.toHaveBeenCalled();
    });

    test("wraps a rejected BatchWriteCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ProvisionedThroughputExceeded");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchWriteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchWriteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });

    test("treats a response with no UnprocessedItems key as fully written", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;
      const items = [{ id: "1" }, { id: "2" }];

      const result = await batchWriteItems(client, "orders", items);

      expect(result).toEqual({ written: 2, unprocessed: [] });
    });

    test("throws M3LDynamoDBOperationError when an UnprocessedItems entry is missing PutRequest.Item", async () => {
      const send = vi.fn().mockResolvedValue({
        UnprocessedItems: { orders: [{ PutRequest: {} }] },
      });
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchWriteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
    });
  });

  describe("batchDeleteItems", () => {
    test("constructs a BatchWriteCommand of DeleteRequests and maps deleted/unprocessed (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({
        UnprocessedItems: { orders: [{ DeleteRequest: { Key: { id: "2" } } }] },
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const keys = [{ id: "1" }, { id: "2" }];

      const result = await batchDeleteItems(client, "orders", keys);

      expect(result).toEqual({ deleted: 1, unprocessed: [{ id: "2" }] });
      const command = send.mock.calls[0]?.[0] as BatchWriteCommand;
      expect(command).toBeInstanceOf(BatchWriteCommand);
      expect(command.input).toEqual({
        RequestItems: {
          orders: [
            { DeleteRequest: { Key: { id: "1" } } },
            { DeleteRequest: { Key: { id: "2" } } },
          ],
        },
      });
    });

    test("rejects with a cap-specific message when given more than 25 keys, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;
      const keys = Array.from({ length: 26 }, (_, i) => ({ id: String(i) }));

      await expect(batchDeleteItems(client, "orders", keys)).rejects.toThrow(
        /at most 25 items/i,
      );
      expect(send).not.toHaveBeenCalled();
    });

    test("short-circuits to { deleted: 0, unprocessed: [] } for an empty keys array, without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as DynamoDBDocumentClient;

      const result = await batchDeleteItems(client, "orders", []);

      expect(result).toEqual({ deleted: 0, unprocessed: [] });
      expect(send).not.toHaveBeenCalled();
    });

    test("wraps a rejected BatchWriteCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ProvisionedThroughputExceeded");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchDeleteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchDeleteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });

    test("treats a response with no UnprocessedItems key as fully deleted", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;
      const keys = [{ id: "1" }, { id: "2" }];

      const result = await batchDeleteItems(client, "orders", keys);

      expect(result).toEqual({ deleted: 2, unprocessed: [] });
    });

    test("throws M3LDynamoDBOperationError when an UnprocessedItems entry is missing DeleteRequest.Key", async () => {
      const send = vi.fn().mockResolvedValue({
        UnprocessedItems: { orders: [{ DeleteRequest: {} }] },
      });
      const client = { send } as unknown as DynamoDBDocumentClient;

      let thrown: unknown;
      try {
        await batchDeleteItems(client, "orders", [{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
    });
  });

  describe("describeTable", () => {
    test("constructs a DescribeTableCommand and maps itemCount/tableStatus (happy path)", async () => {
      const send = vi.fn().mockResolvedValue({
        Table: { ItemCount: 1234, TableStatus: "ACTIVE" },
      });
      const client = { send } as unknown as DynamoDBClient;

      const result = await describeTable(client, "orders");

      expect(result).toEqual({ itemCount: 1234, tableStatus: "ACTIVE" });
      const command = send.mock.calls[0]?.[0] as DescribeTableCommand;
      expect(command).toBeInstanceOf(DescribeTableCommand);
      expect(command.input).toEqual({ TableName: "orders" });
    });

    test("defaults to { itemCount: 0, tableStatus: 'UNKNOWN' } when Table exists but ItemCount/TableStatus are absent", async () => {
      const send = vi.fn().mockResolvedValue({ Table: {} });
      const client = { send } as unknown as DynamoDBClient;

      const result = await describeTable(client, "orders");

      expect(result).toEqual({ itemCount: 0, tableStatus: "UNKNOWN" });
    });

    test("throws M3LDynamoDBOperationError when the response has no Table key at all", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBClient;

      let thrown: unknown;
      try {
        await describeTable(client, "orders");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
    });

    test("wraps a rejected DescribeTableCommand in M3LDynamoDBOperationError, chaining the cause", async () => {
      const sdkError = new Error("ResourceNotFoundException");
      const send = vi.fn().mockRejectedValue(sdkError);
      const client = { send } as unknown as DynamoDBClient;

      let thrown: unknown;
      try {
        await describeTable(client, "orders");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).cause).toBe(sdkError);
    });

    test("re-throws an already-constructed M3LDynamoDBOperationError unchanged, without re-wrapping", async () => {
      const alreadyWrapped = new M3LDynamoDBOperationError(
        "some prior failure",
        {
          context: { tableName: "orders" },
        },
      );
      const send = vi.fn().mockRejectedValue(alreadyWrapped);
      const client = { send } as unknown as DynamoDBClient;

      let thrown: unknown;
      try {
        await describeTable(client, "orders");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(alreadyWrapped);
    });
  });
});

/**
 * TDD seam for `aws/dynamodb`'s `M3LDynamoDBOperations` class (ADR-0038 AWS
 * service tier), per the hub's contract message: a thin wrapper delegating
 * to the free functions above, constructed from TWO clients — a
 * `DynamoDBDocumentClient` for item-level methods and a raw `DynamoDBClient`
 * for `describeTable` only. Reuses the same mock fixtures the free-function
 * tests above already established.
 *
 * Scaffold stage: `M3LDynamoDBOperations` does not exist yet in
 * `src/aws/dynamodb/client.ts`, so the import above fails module resolution
 * (TS2724) until `code-implementer` adds it and re-exports it from
 * `src/aws/dynamodb/index.ts`.
 */
describe("M3LDynamoDBOperations", () => {
  test("constructs with a DynamoDBDocumentClient and a raw DynamoDBClient — no throw", () => {
    const documentClient = {
      send: vi.fn(),
    } as unknown as DynamoDBDocumentClient;
    const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;

    expect(
      () => new M3LDynamoDBOperations(documentClient, rawClient),
    ).not.toThrow();
  });

  describe("getItem", () => {
    test("returns the stored item (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({ Item: { id: "42", status: "paid" } }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.getItem("orders", { id: "42" });

      expect(result).toEqual({ id: "42", status: "paid" });
    });

    test("propagates M3LDynamoDBOperationError with code ERR_DYNAMODB_OPERATION on SDK rejection (failure path)", async () => {
      const documentClient = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      let thrown: unknown;
      try {
        await operations.getItem("orders", { id: "42" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).code).toBe(
        "ERR_DYNAMODB_OPERATION",
      );
    });
  });

  describe("putItem", () => {
    test("writes an item (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      await expect(
        operations.putItem("orders", { id: "42", status: "paid" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("updateItem", () => {
    test("merge-patches an item and returns its post-update attributes (happy path)", async () => {
      const documentClient = {
        send: vi
          .fn()
          .mockResolvedValue({ Attributes: { id: "42", status: "shipped" } }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.updateItem(
        "orders",
        { id: "42" },
        { status: "shipped" },
      );

      expect(result).toEqual({ id: "42", status: "shipped" });
    });
  });

  describe("deleteItem", () => {
    test("deletes a single item by key (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      await expect(
        operations.deleteItem("orders", { id: "42" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("queryItems", () => {
    test("yields pages of matching items (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({
          Items: [{ userId: "42", status: "paid" }],
          LastEvaluatedKey: undefined,
        }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const pages: DynamoDBPage[] = [];
      for await (const page of operations.queryItems({
        tableName: "orders",
        keyCondition: { userId: "42" },
      })) {
        pages.push(page);
      }

      expect(pages).toEqual([
        {
          items: [{ userId: "42", status: "paid" }],
          lastEvaluatedKey: undefined,
        },
      ]);
    });

    test("is a genuine async generator — exposes Symbol.asyncIterator and drains via for-await", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({
          Items: [{ userId: "42" }],
          LastEvaluatedKey: undefined,
        }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const generator = operations.queryItems({
        tableName: "orders",
        keyCondition: { userId: "42" },
      });

      expect(typeof generator[Symbol.asyncIterator]).toBe("function");
      const pages: DynamoDBPage[] = [];
      for await (const page of generator) {
        pages.push(page);
      }
      expect(pages).toHaveLength(1);
    });
  });

  describe("scanSegment", () => {
    test("yields pages of scanned items (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({
          Items: [{ id: "1" }],
          LastEvaluatedKey: undefined,
        }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const pages: DynamoDBPage[] = [];
      for await (const page of operations.scanSegment({
        tableName: "orders",
      })) {
        pages.push(page);
      }

      expect(pages).toEqual([
        { items: [{ id: "1" }], lastEvaluatedKey: undefined },
      ]);
    });

    test("is a genuine async generator — exposes Symbol.asyncIterator and drains via for-await", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({
          Items: [{ id: "1" }],
          LastEvaluatedKey: undefined,
        }),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const generator = operations.scanSegment({ tableName: "orders" });

      expect(typeof generator[Symbol.asyncIterator]).toBe("function");
      const pages: DynamoDBPage[] = [];
      for await (const page of generator) {
        pages.push(page);
      }
      expect(pages).toHaveLength(1);
    });
  });

  describe("batchWriteItems", () => {
    test("writes a batch of items (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.batchWriteItems("orders", [
        { id: "1" },
        { id: "2" },
      ]);

      expect(result).toEqual({ written: 2, unprocessed: [] });
    });
  });

  describe("batchDeleteItems", () => {
    test("deletes a batch of keys (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = { send: vi.fn() } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.batchDeleteItems("orders", [
        { id: "1" },
        { id: "2" },
      ]);

      expect(result).toEqual({ deleted: 2, unprocessed: [] });
    });
  });

  describe("describeTable", () => {
    test("maps itemCount/tableStatus (happy path)", async () => {
      const documentClient = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = {
        send: vi.fn().mockResolvedValue({
          Table: { ItemCount: 1234, TableStatus: "ACTIVE" },
        }),
      } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.describeTable("orders");

      expect(result).toEqual({ itemCount: 1234, tableStatus: "ACTIVE" });
    });

    test("routes through the raw DynamoDBClient constructor argument, NOT the document client — the document client's send is never called", async () => {
      const documentSend = vi
        .fn()
        .mockRejectedValue(
          new Error("describeTable must not use the document client's send"),
        );
      const documentClient = {
        send: documentSend,
      } as unknown as DynamoDBDocumentClient;
      const rawSend = vi
        .fn()
        .mockResolvedValue({ Table: { ItemCount: 7, TableStatus: "ACTIVE" } });
      const rawClient = { send: rawSend } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      const result = await operations.describeTable("orders");

      expect(result).toEqual({ itemCount: 7, tableStatus: "ACTIVE" });
      expect(rawSend).toHaveBeenCalledTimes(1);
      const command = rawSend.mock.calls[0]?.[0] as DescribeTableCommand;
      expect(command).toBeInstanceOf(DescribeTableCommand);
      expect(documentSend).not.toHaveBeenCalled();
    });

    test("propagates M3LDynamoDBOperationError with code ERR_DYNAMODB_OPERATION on SDK rejection (failure path)", async () => {
      const documentClient = {
        send: vi.fn(),
      } as unknown as DynamoDBDocumentClient;
      const rawClient = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as DynamoDBClient;
      const operations = new M3LDynamoDBOperations(documentClient, rawClient);

      let thrown: unknown;
      try {
        await operations.describeTable("orders");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LDynamoDBOperationError);
      expect((thrown as M3LDynamoDBOperationError).code).toBe(
        "ERR_DYNAMODB_OPERATION",
      );
    });
  });
});
