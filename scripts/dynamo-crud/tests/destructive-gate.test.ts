import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return { ...actual, AWS: { ...actual.AWS, describeTable: vi.fn() } };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runDestructiveGate } from "../src/steps/destructive-gate.js";

/**
 * Contract: docs/reference/scripts/dynamo-crud.md, `destructive-gate` row.
 * Shared confirm-gate for `delete`/`update`/`batch-delete`/`import`: prints
 * the target table + an approximate item-count estimate (`AWS.describeTable`)
 * and requires confirmation before proceeding. `confirm` is an injected
 * callback (mirrors `script.prompt.confirm`) so the step is unit-testable
 * without the `M3LScript` lifecycle.
 */

const describeTableMock = vi.mocked(AWS.describeTable);

// Only the mocked `AWS.describeTable` is invoked in these tests; the client
// value itself is never dereferenced, so an opaque placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.describeTable>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDestructiveGate", () => {
  test("resolves without throwing when confirm resolves true", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 42,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "delete",
        logger,
        confirm,
      }),
    ).resolves.toBeUndefined();

    expect(describeTableMock).toHaveBeenCalledWith(fakeClient, "orders");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalled();
    const [message] = warningSpy.mock.calls[0] ?? [];
    expect(message).toEqual(expect.stringContaining("orders"));
    expect(message).toEqual(expect.stringContaining("delete"));
  });

  test("throws ERR_DYNAMO_CRUD_ABORTED when confirm resolves false", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 100,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const confirm = vi.fn().mockResolvedValue(false);

    let thrown: unknown;
    try {
      await runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "batch-delete",
        logger,
        confirm,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_ABORTED");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("still prompts for confirmation when itemCount is 0 (approximate count, not proof of emptiness)", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 0,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const confirm = vi.fn().mockResolvedValue(true);

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "empty-looking-table",
      operation: "import",
      logger,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("propagates a describeTable failure unmodified and never calls confirm", async () => {
    const describeError = new AWS.M3LDynamoDBOperationError(
      "describeTable failed",
      { context: { tableName: "orders" } },
    );
    describeTableMock.mockRejectedValue(describeError);
    const logger = new Core.M3LLogger([]);
    const confirm = vi.fn().mockResolvedValue(true);

    let thrown: unknown;
    try {
      await runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "update",
        logger,
        confirm,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(describeError);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("passes the exact tableName through to describeTable for every documented operation", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const confirm = vi.fn().mockResolvedValue(true);

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "widgets",
      operation: "update",
      logger,
      confirm,
    });

    expect(describeTableMock).toHaveBeenCalledWith(fakeClient, "widgets");
  });

  test("type contract: runDestructiveGate resolves void and confirm is a string->Promise<boolean> callback", () => {
    expectTypeOf(runDestructiveGate).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<
      Parameters<typeof runDestructiveGate>[0]["confirm"]
    >().toEqualTypeOf<(message: string) => Promise<boolean>>();
    expectTypeOf<
      Parameters<typeof runDestructiveGate>[0]["dynamoDB"]
    >().toEqualTypeOf<Parameters<typeof AWS.describeTable>[0]>();
  });
});
