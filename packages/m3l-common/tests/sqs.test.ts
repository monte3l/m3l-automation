/**
 * Tests for aws/sqs submodule.
 *
 * Contract source: docs/reference/aws/sqs.md, ADR-0026.
 *
 * Exports under test (from `../src/aws/sqs/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LSQSOperations, M3LSQSOperationError, and the M3LSQS* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-sqs` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/clients.test.ts`), extended with a `.send()` spy dispatching by
 * command class (no existing test mocks `.send()`; this is the first).
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ReceiveMessageCommand {
    constructor(readonly input: unknown) {}
  }
  class SendMessageBatchCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteMessageBatchCommand {
    constructor(readonly input: unknown) {}
  }
  class PurgeQueueCommand {
    constructor(readonly input: unknown) {}
  }
  class SQSClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    SQSClient,
    ReceiveMessageCommand,
    SendMessageBatchCommand,
    DeleteMessageBatchCommand,
    PurgeQueueCommand,
  };
});

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: h.SQSClient,
  ReceiveMessageCommand: h.ReceiveMessageCommand,
  SendMessageBatchCommand: h.SendMessageBatchCommand,
  DeleteMessageBatchCommand: h.DeleteMessageBatchCommand,
  PurgeQueueCommand: h.PurgeQueueCommand,
}));

import type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSSendEntry,
} from "../src/aws/sqs/index.js";
import {
  M3LSQSOperationError,
  M3LSQSOperations,
} from "../src/aws/sqs/index.js";

import type { SQSClient } from "@aws-sdk/client-sqs";

const QUEUE_URL =
  "https://sqs.eu-south-1.amazonaws.com/123456789012/test-queue";

/** Casts the hoisted fake `SQSClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): SQSClient {
  return new h.SQSClient() as unknown as SQSClient;
}

describe("M3LSQSOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  test("receive() resolves with plain M3LSQSReceivedMessage[] on a successful ReceiveMessage call", async () => {
    h.send.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "msg-1",
          ReceiptHandle: "receipt-1",
          Body: "hello",
          MD5OfBody: "abc123",
        },
      ],
    });

    const operations = new M3LSQSOperations(fakeClient());

    const result = await operations.receive(QUEUE_URL, { maxMessages: 10 });

    expect(result).toEqual([
      expect.objectContaining({
        messageId: "msg-1",
        receiptHandle: "receipt-1",
        body: "hello",
      }),
    ]);
  });

  test("receive() resolves to [] when Messages is an empty array", async () => {
    h.send.mockResolvedValueOnce({ Messages: [] });

    const operations = new M3LSQSOperations(fakeClient());

    await expect(operations.receive(QUEUE_URL)).resolves.toEqual([]);
  });

  test("receive() resolves to [] when the response omits Messages entirely", async () => {
    h.send.mockResolvedValueOnce({});

    const operations = new M3LSQSOperations(fakeClient());

    await expect(operations.receive(QUEUE_URL)).resolves.toEqual([]);
  });

  test("receive() defaults MaxNumberOfMessages to 10 and WaitTimeSeconds to 20, omitting optional fields, when called without options", async () => {
    h.send.mockResolvedValueOnce({ Messages: [] });

    const operations = new M3LSQSOperations(fakeClient());

    await operations.receive(QUEUE_URL);

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(command.input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    });
    expect(command.input.VisibilityTimeout).toBeUndefined();
    expect(command.input.MessageAttributeNames).toBeUndefined();
    expect(command.input.MessageSystemAttributeNames).toBeUndefined();
  });

  test("receive() maps explicit options onto the command input, honoring waitTimeSeconds: 0 (not coerced back to the default)", async () => {
    h.send.mockResolvedValueOnce({ Messages: [] });

    const operations = new M3LSQSOperations(fakeClient());
    const options: M3LSQSReceiveOptions = {
      maxMessages: 5,
      waitTimeSeconds: 0,
      visibilityTimeout: 30,
      messageAttributeNames: ["a"],
      systemAttributeNames: ["SentTimestamp"],
    };

    await operations.receive(QUEUE_URL, options);

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(command.input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 5,
      VisibilityTimeout: 30,
      MessageAttributeNames: ["a"],
      MessageSystemAttributeNames: ["SentTimestamp"],
    });
    // Explicit guard: waitTimeSeconds: 0 must be honored (`??`), not
    // silently coerced back to the 20-second default (`||` would do that).
    expect(command.input.WaitTimeSeconds).toBe(0);
  });

  test("receive() maps a full Message onto M3LSQSReceivedMessage, extracting StringValue-only message attributes", async () => {
    h.send.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "msg-1",
          ReceiptHandle: "receipt-1",
          Body: "hello",
          MD5OfBody: "abc123",
          Attributes: { SentTimestamp: "123" },
          MessageAttributes: {
            foo: { DataType: "String", StringValue: "bar" },
          },
        },
      ],
    });

    const operations = new M3LSQSOperations(fakeClient());

    const result = await operations.receive(QUEUE_URL);

    expect(result).toEqual([
      {
        messageId: "msg-1",
        receiptHandle: "receipt-1",
        body: "hello",
        md5OfBody: "abc123",
        attributes: { SentTimestamp: "123" },
        messageAttributes: { foo: "bar" },
      },
    ]);
  });

  test("receive() maps a Message missing MessageId/ReceiptHandle/Body to empty strings rather than throwing", async () => {
    h.send.mockResolvedValueOnce({ Messages: [{}] });

    const operations = new M3LSQSOperations(fakeClient());

    const result = await operations.receive(QUEUE_URL);

    expect(result).toEqual([{ messageId: "", receiptHandle: "", body: "" }]);
  });

  test("receive() rejects M3LSQSOperationError with cause chained, and is not retried (send called exactly once)", async () => {
    const sdkError = new Error("network blip");
    h.send.mockRejectedValueOnce(sdkError);

    const operations = new M3LSQSOperations(fakeClient());

    let thrown: unknown;
    try {
      await operations.receive(QUEUE_URL);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LSQSOperationError);
    expect((thrown as M3LSQSOperationError).cause).toBe(sdkError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("purgeQueue() rejects with M3LSQSOperationError (code ERR_SQS_OPERATION) when PurgeQueue rejects (e.g. cooldown)", async () => {
    h.send.mockRejectedValue(
      Object.assign(new Error("cooldown"), { name: "PurgeQueueInProgress" }),
    );

    const operations = new M3LSQSOperations(fakeClient());

    await expect(operations.purgeQueue(QUEUE_URL)).rejects.toMatchObject({
      code: "ERR_SQS_OPERATION",
    });
    await expect(operations.purgeQueue(QUEUE_URL)).rejects.toBeInstanceOf(
      M3LSQSOperationError,
    );
    // Distinguishes "really called PurgeQueue and got the cooldown rejection"
    // from the scaffold placeholder, which throws before ever calling send().
    expect(h.send).toHaveBeenCalled();
  });

  test("purgeQueue() rejects with cause chained, and is not retried (send called exactly once)", async () => {
    const cooldownError = Object.assign(new Error("cooldown"), {
      name: "PurgeQueueInProgress",
    });
    h.send.mockRejectedValueOnce(cooldownError);

    const operations = new M3LSQSOperations(fakeClient());

    let thrown: unknown;
    try {
      await operations.purgeQueue(QUEUE_URL);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LSQSOperationError);
    expect((thrown as M3LSQSOperationError).cause).toBe(cooldownError);
    // Unlike sendBatch/deleteBatch (which retry on throttling), purgeQueue
    // must call send exactly once — a cooldown rejection is a business
    // condition, not a transient fault to retry through.
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("purgeQueue() resolves to undefined on success, sending only QueueUrl", async () => {
    h.send.mockResolvedValueOnce({});

    const operations = new M3LSQSOperations(fakeClient());

    await expect(operations.purgeQueue(QUEUE_URL)).resolves.toBeUndefined();

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(command.input).toEqual({ QueueUrl: QUEUE_URL });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  describe("sendBatch()", () => {
    test("all-success: returns input entries by reference in successful[], maps id/body onto Id/MessageBody", async () => {
      const entries: M3LSQSSendEntry[] = [
        { id: "0", body: "hello" },
        { id: "1", body: "world" },
      ];
      h.send.mockResolvedValueOnce({
        Successful: [{ Id: "0" }, { Id: "1" }],
        Failed: [],
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.sendBatch(QUEUE_URL, entries);

      expect(result.successful).toHaveLength(2);
      expect(result.successful[0]).toBe(entries[0]);
      expect(result.successful[1]).toBe(entries[1]);
      expect(result.failed).toEqual([]);

      const [command] = h.send.mock.calls[0] as [
        { input: Record<string, unknown> },
      ];
      expect(command.input).toMatchObject({
        QueueUrl: QUEUE_URL,
        Entries: [
          { Id: "0", MessageBody: "hello" },
          { Id: "1", MessageBody: "world" },
        ],
      });
    });

    test("partial Failed[]: joins each failure back to the SAME original entry object, mapping code/senderFault/message", async () => {
      const entries: M3LSQSSendEntry[] = [
        { id: "0", body: "ok" },
        { id: "1", body: "bad" },
      ];
      h.send.mockResolvedValueOnce({
        Successful: [{ Id: "0" }],
        Failed: [
          {
            Id: "1",
            SenderFault: true,
            Code: "InvalidParameterValue",
            Message: "bad",
          },
        ],
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.sendBatch(QUEUE_URL, entries);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      const failure = result.failed[0];
      // Reference equality, not just deep equality: the failure must carry
      // the caller's original entry object, not a reconstructed copy.
      expect(failure?.entry).toBe(entries[1]);
      expect(failure?.code).toBe("InvalidParameterValue");
      expect(failure?.senderFault).toBe(true);
      expect(failure?.message).toBe("bad");
    });

    test("rejects M3LSQSOperationError when a Failed[] entry's Id doesn't match any input entry's id (orphaned failure)", async () => {
      const entries: M3LSQSSendEntry[] = [{ id: "0", body: "hello" }];
      h.send.mockResolvedValueOnce({
        Successful: [],
        Failed: [
          {
            Id: "nonexistent-id",
            SenderFault: true,
            Code: "SomeError",
          },
        ],
      });

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.sendBatch(QUEUE_URL, entries);
      } catch (error) {
        thrown = error;
      }

      // An orphaned Failed[].Id (no matching input entry) must surface as a
      // request-level failure, not be silently dropped from the result.
      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect(thrown).toMatchObject({ code: "ERR_SQS_OPERATION" });
    });

    test("rejects M3LSQSOperationError when given more than 10 entries, without calling send", async () => {
      const entries: M3LSQSSendEntry[] = Array.from(
        { length: 11 },
        (_unused, index) => ({
          id: String(index),
          body: `body-${String(index)}`,
        }),
      );
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.sendBatch(QUEUE_URL, entries),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("rejects M3LSQSOperationError on duplicate entry ids, without calling send", async () => {
      const entries: M3LSQSSendEntry[] = [
        { id: "dup", body: "one" },
        { id: "dup", body: "two" },
      ];
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.sendBatch(QUEUE_URL, entries),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        const entries: M3LSQSSendEntry[] = [{ id: "0", body: "x" }];
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] });

        const operations = new M3LSQSOperations(fakeClient());

        let result: M3LSQSBatchResult<M3LSQSSendEntry> | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.sendBatch(QUEUE_URL, entries);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result?.successful).toHaveLength(1);
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("exhausted retries: rejects M3LSQSOperationError with cause=throttle error after exactly 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const entries: M3LSQSSendEntry[] = [{ id: "0", body: "x" }];
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LSQSOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.sendBatch(QUEUE_URL, entries);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LSQSOperationError);
        expect((thrown as M3LSQSOperationError).cause).toBe(throttleError);
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });

    test("an unrecognized error name is fatal, not retried (send called exactly once)", async () => {
      const entries: M3LSQSSendEntry[] = [{ id: "0", body: "x" }];
      h.send.mockRejectedValue(
        Object.assign(new Error("denied"), { name: "AccessDenied" }),
      );

      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.sendBatch(QUEUE_URL, entries),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteBatch()", () => {
    test("all-success: returns input entries by reference in successful[], maps id/receiptHandle onto Id/ReceiptHandle", async () => {
      const entries: M3LSQSDeleteEntry[] = [
        { id: "0", receiptHandle: "r-0" },
        { id: "1", receiptHandle: "r-1" },
      ];
      h.send.mockResolvedValueOnce({
        Successful: [{ Id: "0" }, { Id: "1" }],
        Failed: [],
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.deleteBatch(QUEUE_URL, entries);

      expect(result.successful).toHaveLength(2);
      expect(result.successful[0]).toBe(entries[0]);
      expect(result.successful[1]).toBe(entries[1]);
      expect(result.failed).toEqual([]);

      const [command] = h.send.mock.calls[0] as [
        { input: Record<string, unknown> },
      ];
      expect(command.input).toMatchObject({
        QueueUrl: QUEUE_URL,
        Entries: [
          { Id: "0", ReceiptHandle: "r-0" },
          { Id: "1", ReceiptHandle: "r-1" },
        ],
      });
    });

    test("partial Failed[]: joins each failure back to the SAME original entry object, mapping code/senderFault/message", async () => {
      const entries: M3LSQSDeleteEntry[] = [
        { id: "0", receiptHandle: "r-0" },
        { id: "1", receiptHandle: "r-1" },
      ];
      h.send.mockResolvedValueOnce({
        Successful: [{ Id: "0" }],
        Failed: [
          {
            Id: "1",
            SenderFault: false,
            Code: "ReceiptHandleIsInvalid",
            Message: "bad handle",
          },
        ],
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.deleteBatch(QUEUE_URL, entries);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      const failure = result.failed[0];
      expect(failure?.entry).toBe(entries[1]);
      expect(failure?.code).toBe("ReceiptHandleIsInvalid");
      expect(failure?.senderFault).toBe(false);
      expect(failure?.message).toBe("bad handle");
    });

    test("rejects M3LSQSOperationError when given more than 10 entries, without calling send", async () => {
      const entries: M3LSQSDeleteEntry[] = Array.from(
        { length: 11 },
        (_unused, index) => ({
          id: String(index),
          receiptHandle: `r-${String(index)}`,
        }),
      );
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.deleteBatch(QUEUE_URL, entries),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("rejects M3LSQSOperationError on duplicate entry ids, without calling send", async () => {
      const entries: M3LSQSDeleteEntry[] = [
        { id: "dup", receiptHandle: "r-0" },
        { id: "dup", receiptHandle: "r-1" },
      ];
      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.deleteBatch(QUEUE_URL, entries),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        const entries: M3LSQSDeleteEntry[] = [
          { id: "0", receiptHandle: "r-0" },
        ];
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] });

        const operations = new M3LSQSOperations(fakeClient());

        let result: M3LSQSBatchResult<M3LSQSDeleteEntry> | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.deleteBatch(QUEUE_URL, entries);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result?.successful).toHaveLength(1);
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("exhausted retries: rejects M3LSQSOperationError with cause=throttle error after exactly 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const entries: M3LSQSDeleteEntry[] = [
          { id: "0", receiptHandle: "r-0" },
        ];
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LSQSOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.deleteBatch(QUEUE_URL, entries);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LSQSOperationError);
        expect((thrown as M3LSQSOperationError).cause).toBe(throttleError);
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("M3LSQSBatchFailure<T>.entry preserves the original input entry's type (send entries)", () => {
    expectTypeOf<
      M3LSQSBatchFailure<M3LSQSSendEntry>["entry"]
    >().toEqualTypeOf<M3LSQSSendEntry>();
  });

  test("M3LSQSBatchResult<T> shape: every entry lands in successful xor failed", () => {
    expectTypeOf<M3LSQSBatchResult<M3LSQSDeleteEntry>>().toEqualTypeOf<{
      readonly successful: readonly M3LSQSDeleteEntry[];
      readonly failed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
    }>();
  });

  test("M3LSQSReceiveOptions and M3LSQSReceivedMessage are fully optional/required as documented", () => {
    expectTypeOf<M3LSQSReceiveOptions>().toEqualTypeOf<{
      readonly maxMessages?: number;
      readonly waitTimeSeconds?: number;
      readonly visibilityTimeout?: number;
      readonly messageAttributeNames?: readonly string[];
      readonly systemAttributeNames?: readonly string[];
    }>();
    expectTypeOf<M3LSQSReceivedMessage>().toMatchTypeOf<{
      readonly messageId: string;
      readonly receiptHandle: string;
      readonly body: string;
    }>();
  });
});
