import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      batchWriteItems: vi.fn(),
      batchDeleteItems: vi.fn(),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { BatchWriteTableResult } from "../src/steps/batch-write-table.js";
import { batchWriteTable } from "../src/steps/batch-write-table.js";

/**
 * Contract: docs/reference/scripts/dynamodb-crud.md, `batch-write-table` row.
 * Given an already-parsed `AsyncIterable<Record<string, unknown>>` (reading
 * the input file and writing `failed.jsonl` are out of scope for this step —
 * that's `run-dynamodb-crud`'s job), `batchWriteTable`:
 *  - chunks into groups of at most 25 items (DynamoDB's `BatchWriteItem` cap);
 *  - dispatches each chunk to `AWS.batchWriteItems` (mode "write") or
 *    `AWS.batchDeleteItems` (mode "delete") — never both;
 *  - retries a chunk's `unprocessed` subset (only that subset, not the whole
 *    chunk) through the injected `Core.M3LRetryRunner`, converting "still has
 *    unprocessed items" into a thrown/retriable signal internally;
 *  - bounds concurrent chunk processing by `maxInFlightBatches`;
 *  - returns `{ written, failed }` where `failed` is whatever is still
 *    unprocessed once the retry runner itself gives up, and `written` only
 *    counts items DynamoDB actually confirmed;
 *  - lets a hard (non-"unprocessed") AWS failure propagate out of
 *    `batchWriteTable` rather than being silently folded into `failed`.
 */

const batchWriteItemsMock = vi.mocked(AWS.batchWriteItems);
const batchDeleteItemsMock = vi.mocked(AWS.batchDeleteItems);

// Only the mocked AWS functions are invoked in these tests; the client value
// itself is never dereferenced, so an opaque placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.batchWriteItems>[0];

const logger = new Core.M3LLogger([]);

const item1 = { id: "1" };
const item2 = { id: "2" };
const item3 = { id: "3" };
const item4 = { id: "4" };
const item5 = { id: "5" };

/** A trivial pre-built retry runner: retries everything, no backoff delay. */
function makeRetryRunner(maxAttempts: number): Core.M3LRetryRunner {
  return new Core.M3LRetryRunner({
    classifier: () => "retriable",
    backoff: Core.M3LBackoff.constant(1),
    unknownDecision: "fatal",
    maxAttempts,
  });
}

async function* recordsOf(
  ...records: readonly Record<string, unknown>[]
): AsyncGenerator<Record<string, unknown>> {
  await Promise.resolve();
  yield* records;
}

async function* manyRecords(
  count: number,
): AsyncGenerator<Record<string, unknown>> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
    yield { id: String(index) };
  }
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear plain
  // vi.fn() mocks (batchWriteItems/batchDeleteItems, created inside the
  // top-level vi.mock() factory), so their call history would otherwise
  // leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.batchWriteItems).mockReset();
  vi.mocked(AWS.batchDeleteItems).mockReset();
});

describe("batchWriteTable", () => {
  test("chunks records into groups of at most 25 and reports total written", async () => {
    const receivedLengths: number[] = [];
    batchWriteItemsMock.mockImplementation((_client, _table, items) => {
      receivedLengths.push(items.length);
      return Promise.resolve({ written: items.length, unprocessed: [] });
    });

    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: manyRecords(30),
      maxInFlightBatches: 4,
      retryRunner: makeRetryRunner(1),
      logger,
    });

    expect(receivedLengths).toEqual([25, 5]);
    expect(result.written).toBe(30);
    expect(result.failed).toEqual([]);
  });

  test("returns { written: 0, failed: [] } and never calls AWS for an empty record stream", async () => {
    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: recordsOf(),
      maxInFlightBatches: 4,
      retryRunner: makeRetryRunner(1),
      logger,
    });

    expect(result).toEqual({ written: 0, failed: [] });
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
    expect(batchDeleteItemsMock).not.toHaveBeenCalled();
  });

  test("mode 'write' calls AWS.batchWriteItems only, never batchDeleteItems", async () => {
    batchWriteItemsMock.mockResolvedValue({ written: 2, unprocessed: [] });

    await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: recordsOf(item1, item2),
      maxInFlightBatches: 4,
      retryRunner: makeRetryRunner(1),
      logger,
    });

    expect(batchWriteItemsMock).toHaveBeenCalledTimes(1);
    expect(batchWriteItemsMock).toHaveBeenCalledWith(
      fakeClient,
      "orders",
      expect.arrayContaining([item1, item2]) as unknown,
    );
    expect(batchDeleteItemsMock).not.toHaveBeenCalled();
  });

  test("mode 'delete' calls AWS.batchDeleteItems only, never batchWriteItems", async () => {
    batchDeleteItemsMock.mockResolvedValue({ deleted: 1, unprocessed: [] });

    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "delete",
      tableName: "orders",
      records: recordsOf(item1),
      maxInFlightBatches: 4,
      retryRunner: makeRetryRunner(1),
      logger,
    });

    expect(batchDeleteItemsMock).toHaveBeenCalledTimes(1);
    expect(batchDeleteItemsMock).toHaveBeenCalledWith(fakeClient, "orders", [
      item1,
    ]);
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
    expect(result.written).toBe(1);
  });

  test("retries only the unprocessed subset of a chunk and succeeds once DynamoDB confirms it", async () => {
    let secondCallItems: readonly Record<string, unknown>[] | undefined;
    batchWriteItemsMock
      .mockImplementationOnce((_client, _table, items) =>
        Promise.resolve({
          written: items.length - 2,
          unprocessed: [item4, item5],
        }),
      )
      .mockImplementationOnce((_client, _table, items) => {
        secondCallItems = items;
        return Promise.resolve({ written: items.length, unprocessed: [] });
      });

    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: recordsOf(item1, item2, item3, item4, item5),
      maxInFlightBatches: 1,
      retryRunner: makeRetryRunner(5),
      logger,
    });

    expect(batchWriteItemsMock).toHaveBeenCalledTimes(2);
    expect(secondCallItems).toEqual([item4, item5]);
    expect(result.written).toBe(5);
    expect(result.failed).toEqual([]);
  });

  test("puts items still unprocessed after the retry runner is exhausted into `failed`, counting only confirmed writes", async () => {
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({
        written: items.length - 1,
        unprocessed: [item3],
      }),
    );

    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: recordsOf(item1, item2, item3),
      maxInFlightBatches: 1,
      retryRunner: makeRetryRunner(2),
      logger,
    });

    expect(batchWriteItemsMock).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([item3]);
    expect(result.written).toBe(2);
  });

  test("maxInFlightBatches bounds concurrent chunk processing (serial when set to 1)", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    batchWriteItemsMock.mockImplementation(async (_client, _table, items) => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { written: items.length, unprocessed: [] };
    });

    const result = await batchWriteTable({
      dynamoDBDocument: fakeClient,
      mode: "write",
      tableName: "orders",
      records: manyRecords(75),
      maxInFlightBatches: 1,
      retryRunner: makeRetryRunner(1),
      logger,
    });

    expect(batchWriteItemsMock).toHaveBeenCalledTimes(3);
    expect(peakConcurrent).toBe(1);
    expect(result.written).toBe(75);
  });

  test("a persistent hard AWS failure propagates out of batchWriteTable rather than being folded into `failed`", async () => {
    batchWriteItemsMock.mockRejectedValue(
      new AWS.M3LDynamoDBOperationError("batchWriteItems failed", {
        context: { tableName: "orders" },
      }),
    );

    await expect(
      batchWriteTable({
        dynamoDBDocument: fakeClient,
        mode: "write",
        tableName: "orders",
        records: recordsOf(item1, item2),
        maxInFlightBatches: 1,
        retryRunner: makeRetryRunner(2),
        logger,
      }),
    ).rejects.toThrow();

    expect(batchWriteItemsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("logs the second concurrent chunk's hard failure while only the first propagates", async () => {
    const errorA = new AWS.M3LDynamoDBOperationError("chunk A failed", {
      context: { tableName: "orders", chunk: "A" },
    });
    const errorB = new AWS.M3LDynamoDBOperationError("chunk B failed", {
      context: { tableName: "orders", chunk: "B" },
    });

    // Neither mock call rejects until BOTH have started, guaranteeing they
    // are genuinely concurrent in-flight failures (rather than one settling
    // before the second chunk is even dispatched).
    let started = 0;
    let releaseBoth: () => void = () => {
      /* replaced below */
    };
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    batchWriteItemsMock.mockImplementation(async () => {
      started += 1;
      // Snapshot which error this call throws BEFORE awaiting bothStarted —
      // `started` is shared mutable state, and by the time the second call
      // increments it, the first call's continuation may not have resumed
      // yet, so reading `started` again after the await would see `2` for
      // both calls.
      const thisCallError = started === 1 ? errorA : errorB;
      if (started === 2) releaseBoth();
      await bothStarted;
      throw thisCallError;
    });

    const warningSpy = vi.spyOn(logger, "warning");

    let caught: unknown;
    try {
      await batchWriteTable({
        dynamoDBDocument: fakeClient,
        mode: "write",
        tableName: "orders",
        records: manyRecords(50),
        maxInFlightBatches: 2,
        retryRunner: makeRetryRunner(1),
        logger,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect([errorA, errorB]).toContain(caught);
    const otherError = caught === errorA ? errorB : errorA;

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("already failed"),
      { cause: otherError },
    );
  });

  test("type contract: BatchWriteTableResult.failed is readonly Record<string, unknown>[] and mode only accepts 'write' | 'delete'", () => {
    expectTypeOf<BatchWriteTableResult["failed"]>().toEqualTypeOf<
      readonly Record<string, unknown>[]
    >();
    expectTypeOf<Parameters<typeof batchWriteTable>[0]["mode"]>().toEqualTypeOf<
      "write" | "delete"
    >();
    expectTypeOf<
      Parameters<typeof batchWriteTable>[0]["dynamoDBDocument"]
    >().toEqualTypeOf<Parameters<typeof AWS.batchWriteItems>[0]>();
  });
});
