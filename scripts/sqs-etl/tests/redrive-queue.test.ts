import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { redriveQueue } from "../src/steps/redrive-queue.js";
import { stubOutputStreams, writtenJsonlRecords } from "./support/fsFakes.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `redrive-queue` row + design
 * decision #12. Receives from `dlqUrl` (10/waitTimeSeconds 20, up to
 * `batchSize` or empty), maps each page to `M3LSQSSendEntry` (body only —
 * FIFO passthrough deliberately out of scope), `sendBatch()`s to `queueUrl`,
 * then `deleteBatch()`s from `dlqUrl` only the messages whose send succeeded
 * (matched by chunk-position id); unsent DLQ messages are left alone and
 * logged to `failed.jsonl`. Confirm-gated once before any delete.
 */

function dlqMessage(index: number): AWS.M3LSQSReceivedMessage {
  return {
    messageId: `msg-${String(index)}`,
    receiptHandle: `rh-${String(index)}`,
    body: `{"n":${String(index)}}`,
  };
}

function bypassPrompt(): Core.M3LPrompt {
  const prompt = new Core.M3LPrompt();
  vi.spyOn(prompt, "confirm").mockResolvedValue(true);
  return prompt;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redriveQueue", () => {
  test("maps each DLQ page to M3LSQSSendEntry (body only) and sends it to queueUrl", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([dlqMessage(1), dlqMessage(2)])
      .mockResolvedValueOnce([]);
    const sendBatchMock = vi.fn().mockResolvedValue({
      successful: [
        { id: "0", body: dlqMessage(1).body },
        { id: "1", body: dlqMessage(2).body },
      ],
      failed: [],
    });
    const sqsOperations = createFakeSqsOperations({
      receive,
      sendBatch: sendBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      dlqUrl: "https://sqs.example/dlq",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await redriveQueue({
      config,
      paths,
      logger,
      correlationId: "run-1",
      sqsOperations,
      prompt,
    });

    const [sendQueueUrl, sendEntries] = sendBatchMock.mock.calls[0] as [
      string,
      readonly AWS.M3LSQSSendEntry[],
    ];
    expect(sendQueueUrl).toBe("https://sqs.example/q");
    expect(sendEntries).toEqual([
      { id: "0", body: dlqMessage(1).body },
      { id: "1", body: dlqMessage(2).body },
    ]);
  });

  test("deletes from dlqUrl only the messages whose send succeeded", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([dlqMessage(1), dlqMessage(2)])
      .mockResolvedValueOnce([]);
    const sendBatchMock = vi.fn().mockResolvedValue({
      successful: [{ id: "0", body: dlqMessage(1).body }],
      failed: [
        {
          entry: { id: "1", body: dlqMessage(2).body },
          code: "InternalError",
          senderFault: false,
        },
      ],
    });
    const deleteBatchMock = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const sqsOperations = createFakeSqsOperations({
      receive,
      sendBatch: sendBatchMock,
      deleteBatch: deleteBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      dlqUrl: "https://sqs.example/dlq",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await redriveQueue({
      config,
      paths,
      logger,
      correlationId: "run-2",
      sqsOperations,
      prompt,
    });

    expect(deleteBatchMock).toHaveBeenCalledTimes(1);
    const [deleteQueueUrl, deleteEntries] = deleteBatchMock.mock.calls[0] as [
      string,
      readonly AWS.M3LSQSDeleteEntry[],
    ];
    expect(deleteQueueUrl).toBe("https://sqs.example/dlq");
    expect(deleteEntries).toEqual([{ id: "0", receiptHandle: "rh-1" }]);
  });

  test("a DLQ message whose send failed is logged to failed.jsonl instead of deleted", async () => {
    const { streams } = stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([dlqMessage(1)])
      .mockResolvedValueOnce([]);
    const failedSendEntry: AWS.M3LSQSSendEntry = {
      id: "0",
      body: dlqMessage(1).body,
    };
    const sendBatchMock = vi.fn().mockResolvedValue({
      successful: [],
      failed: [
        { entry: failedSendEntry, code: "InternalError", senderFault: false },
      ],
    });
    const deleteBatchMock = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const sqsOperations = createFakeSqsOperations({
      receive,
      sendBatch: sendBatchMock,
      deleteBatch: deleteBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      dlqUrl: "https://sqs.example/dlq",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await redriveQueue({
      config,
      paths,
      logger,
      correlationId: "run-3",
      sqsOperations,
      prompt,
    });

    expect(deleteBatchMock).not.toHaveBeenCalled();
    // Search on the failed entry's own top-level 'id' field, not the nested
    // 'body' string's content — body is itself JSON-stringified inside the
    // outer JSON.stringify, so its raw text is backslash-escaped in the
    // written line and would never match a literal search.
    const failedStream = streams.find((stream) =>
      stream.content().includes(`"id":"${failedSendEntry.id}"`),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      expect(writtenJsonlRecords(failedStream)).toEqual([failedSendEntry]);
    }
  });

  test("confirms exactly once even across multiple deleted pages", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([dlqMessage(1)])
      .mockResolvedValueOnce([dlqMessage(2)])
      .mockResolvedValueOnce([]);
    const sendBatchMock = vi
      .fn()
      .mockImplementation(
        (_queueUrl: string, entries: readonly AWS.M3LSQSSendEntry[]) =>
          Promise.resolve({ successful: [...entries], failed: [] }),
      );
    const deleteBatchMock = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const sqsOperations = createFakeSqsOperations({
      receive,
      sendBatch: sendBatchMock,
      deleteBatch: deleteBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      dlqUrl: "https://sqs.example/dlq",
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await redriveQueue({
      config,
      paths,
      logger,
      correlationId: "run-4",
      sqsOperations,
      prompt,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteBatchMock).toHaveBeenCalledTimes(2);
  });

  test("a declined confirmation aborts before any deleteBatch call, but the send already happened", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([dlqMessage(1)])
      .mockResolvedValueOnce([]);
    const sendBatchMock = vi.fn().mockResolvedValue({
      successful: [{ id: "0", body: dlqMessage(1).body }],
      failed: [],
    });
    const deleteBatchMock = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const sqsOperations = createFakeSqsOperations({
      receive,
      sendBatch: sendBatchMock,
      deleteBatch: deleteBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      dlqUrl: "https://sqs.example/dlq",
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    let thrown: unknown;
    try {
      await redriveQueue({
        config,
        paths,
        logger,
        correlationId: "run-5",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
    expect(sendBatchMock).toHaveBeenCalledTimes(1);
    expect(deleteBatchMock).not.toHaveBeenCalled();
  });

  test.each(["queueUrl", "dlqUrl"] as const)(
    "throws ERR_SQS_ETL_CONFIG when '%s' is missing, never calling receive()",
    async (missing) => {
      stubOutputStreams();
      const receive = vi.fn().mockResolvedValue([]);
      const sqsOperations = createFakeSqsOperations({ receive });
      const base: Record<string, unknown> = {
        queueUrl: "https://sqs.example/q",
        dlqUrl: "https://sqs.example/dlq",
        yes: true,
      };
      delete base[missing];
      const config = buildConfig(base);
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = bypassPrompt();

      let thrown: unknown;
      try {
        await redriveQueue({
          config,
          paths,
          logger,
          correlationId: `run-missing-${missing}`,
          sqsOperations,
          prompt,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_CONFIG");
      expect(receive).not.toHaveBeenCalled();
    },
  );
});
