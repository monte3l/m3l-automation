import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommonModule from "@m3l-automation/m3l-common";

/**
 * Contract: docs/reference/scripts/dynamo-crud.md, `single-item-ops` row +
 * docs/reference/aws/dynamodb.md (`getItem`/`putItem`/`updateItem`/`deleteItem`).
 * `get`/`put`/`update`/`delete` against one key/item via the mocked `AWS.*`
 * item operations. This step does NOT call the destructive-operation gate
 * itself — the `run-dynamo-crud` orchestrator decides whether to gate
 * `delete`/`update` before invoking this step. `key`/`item` arrive already
 * JSON-parsed plain objects (parsing happens in the orchestrator, not here).
 */

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommonModule>();
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      getItem: vi.fn(),
      putItem: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import {
  runSingleItemOp,
  type SingleItemOperation,
} from "../src/steps/single-item-ops.js";

const FAKE_DOCUMENT_CLIENT = {} as Parameters<typeof AWS.getItem>[0];
const TABLE_NAME = "orders";

afterEach(() => {
  vi.clearAllMocks();
});

describe("runSingleItemOp", () => {
  test("'get' calls AWS.getItem with the key and returns its resolved item", async () => {
    const resolvedItem = { id: "42", status: "paid" };
    vi.mocked(AWS.getItem).mockResolvedValue(resolvedItem);

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "get",
      tableName: TABLE_NAME,
      key: { id: "42" },
      item: undefined,
    });

    expect(AWS.getItem).toHaveBeenCalledWith(FAKE_DOCUMENT_CLIENT, TABLE_NAME, {
      id: "42",
    });
    expect(result).toEqual({ item: resolvedItem });
  });

  test("'get' propagates undefined from AWS.getItem for a missing item, not an error", async () => {
    vi.mocked(AWS.getItem).mockResolvedValue(undefined);

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "get",
      tableName: TABLE_NAME,
      key: { id: "missing" },
      item: undefined,
    });

    expect(result).toEqual({ item: undefined });
  });

  test("'get' throws ERR_DYNAMO_CRUD_CONFIG when key is undefined", async () => {
    await expect(
      runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "get",
        tableName: TABLE_NAME,
        key: undefined,
        item: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_DYNAMO_CRUD_CONFIG" });
    expect(AWS.getItem).not.toHaveBeenCalled();
  });

  test("'put' calls AWS.putItem with the item and echoes it back", async () => {
    vi.mocked(AWS.putItem).mockResolvedValue(undefined);
    const item = { id: "42", status: "paid" };

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "put",
      tableName: TABLE_NAME,
      key: undefined,
      item,
    });

    expect(AWS.putItem).toHaveBeenCalledWith(
      FAKE_DOCUMENT_CLIENT,
      TABLE_NAME,
      item,
    );
    expect(result).toEqual({ item });
  });

  test("'put' throws ERR_DYNAMO_CRUD_CONFIG when item is undefined", async () => {
    await expect(
      runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "put",
        tableName: TABLE_NAME,
        key: undefined,
        item: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_DYNAMO_CRUD_CONFIG" });
    expect(AWS.putItem).not.toHaveBeenCalled();
  });

  test("'update' calls AWS.updateItem with key and item-as-patch, returning the post-update attributes", async () => {
    const postUpdateAttributes = { id: "42", status: "shipped" };
    vi.mocked(AWS.updateItem).mockResolvedValue(postUpdateAttributes);
    const key = { id: "42" };
    const patch = { status: "shipped" };

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "update",
      tableName: TABLE_NAME,
      key,
      item: patch,
    });

    expect(AWS.updateItem).toHaveBeenCalledWith(
      FAKE_DOCUMENT_CLIENT,
      TABLE_NAME,
      key,
      patch,
    );
    expect(result).toEqual({ item: postUpdateAttributes });
  });

  test("'update' propagates undefined post-update attributes from AWS.updateItem", async () => {
    vi.mocked(AWS.updateItem).mockResolvedValue(undefined);

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "update",
      tableName: TABLE_NAME,
      key: { id: "42" },
      item: { status: "shipped" },
    });

    expect(result).toEqual({ item: undefined });
  });

  test("'update' throws ERR_DYNAMO_CRUD_CONFIG naming 'key' when key is undefined", async () => {
    let thrown: unknown;
    try {
      await runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "update",
        tableName: TABLE_NAME,
        key: undefined,
        item: { status: "shipped" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect((thrown as Core.M3LError).message).toMatch(/key/i);
    expect(AWS.updateItem).not.toHaveBeenCalled();
  });

  test("'update' throws ERR_DYNAMO_CRUD_CONFIG naming 'item' when item (the patch) is undefined", async () => {
    let thrown: unknown;
    try {
      await runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "update",
        tableName: TABLE_NAME,
        key: { id: "42" },
        item: undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect((thrown as Core.M3LError).message).toMatch(/item/i);
    expect(AWS.updateItem).not.toHaveBeenCalled();
  });

  test("'delete' calls AWS.deleteItem with the key and returns an undefined item", async () => {
    vi.mocked(AWS.deleteItem).mockResolvedValue(undefined);
    const key = { id: "42" };

    const result = await runSingleItemOp({
      dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
      operation: "delete",
      tableName: TABLE_NAME,
      key,
      item: undefined,
    });

    expect(AWS.deleteItem).toHaveBeenCalledWith(
      FAKE_DOCUMENT_CLIENT,
      TABLE_NAME,
      key,
    );
    expect(result).toEqual({ item: undefined });
  });

  test("'delete' throws ERR_DYNAMO_CRUD_CONFIG when key is undefined", async () => {
    await expect(
      runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "delete",
        tableName: TABLE_NAME,
        key: undefined,
        item: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_DYNAMO_CRUD_CONFIG" });
    expect(AWS.deleteItem).not.toHaveBeenCalled();
  });

  test("an AWS.M3LDynamoDBOperationError from AWS.getItem propagates unmodified, not caught/rewrapped", async () => {
    const operationError = new AWS.M3LDynamoDBOperationError("getItem failed", {
      cause: new Error("network blip"),
    });
    vi.mocked(AWS.getItem).mockRejectedValue(operationError);

    let thrown: unknown;
    try {
      await runSingleItemOp({
        dynamoDBDocument: FAKE_DOCUMENT_CLIENT,
        operation: "get",
        tableName: TABLE_NAME,
        key: { id: "42" },
        item: undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(operationError);
  });
});

describe("type contract", () => {
  test("SingleItemOperation is a closed union of the four literal operation names", () => {
    expectTypeOf<SingleItemOperation>().toEqualTypeOf<
      "get" | "put" | "update" | "delete"
    >();
  });

  test("runSingleItemOp resolves { item: Record<string, unknown> | undefined }", () => {
    expectTypeOf(runSingleItemOp).returns.resolves.toEqualTypeOf<{
      readonly item: Record<string, unknown> | undefined;
    }>();
  });
});
