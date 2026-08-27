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
  class ListQueuesCommand {
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
    ListQueuesCommand,
  };
});

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: h.SQSClient,
  ReceiveMessageCommand: h.ReceiveMessageCommand,
  SendMessageBatchCommand: h.SendMessageBatchCommand,
  DeleteMessageBatchCommand: h.DeleteMessageBatchCommand,
  PurgeQueueCommand: h.PurgeQueueCommand,
  ListQueuesCommand: h.ListQueuesCommand,
}));

import type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSListQueuesResult,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSRedriveDecision,
  M3LSQSRedriveOptions,
  M3LSQSRedriveProcessor,
  M3LSQSRedriveResult,
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
    expect(command.input["VisibilityTimeout"]).toBeUndefined();
    expect(command.input["MessageAttributeNames"]).toBeUndefined();
    expect(command.input["MessageSystemAttributeNames"]).toBeUndefined();
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
    expect(command.input["WaitTimeSeconds"]).toBe(0);
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

  describe("listQueues()", () => {
    test("resolves { queueUrls } with no nextToken key present when the response omits NextToken", async () => {
      h.send.mockResolvedValueOnce({ QueueUrls: ["url1", "url2"] });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.listQueues();

      expect(result).toEqual({ queueUrls: ["url1", "url2"] });
      expect(Object.hasOwn(result, "nextToken")).toBe(false);
    });

    test("resolves { queueUrls: [] } when QueueUrls is absent from the response entirely", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSQSOperations(fakeClient());

      await expect(operations.listQueues()).resolves.toEqual({
        queueUrls: [],
      });
    });

    test("round-trips a response NextToken into result.nextToken", async () => {
      h.send.mockResolvedValueOnce({
        QueueUrls: ["url1"],
        NextToken: "next-page-token",
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.listQueues();

      expect(result).toEqual({
        queueUrls: ["url1"],
        nextToken: "next-page-token",
      });
    });

    test("maps queueNamePrefix/nextToken/maxResults onto QueueNamePrefix/NextToken/MaxResults on the sent command", async () => {
      h.send.mockResolvedValueOnce({ QueueUrls: [] });

      const operations = new M3LSQSOperations(fakeClient());
      await operations.listQueues({
        queueNamePrefix: "dlq-",
        nextToken: "tok123",
        maxResults: 5,
      });

      const [command] = h.send.mock.calls[0] as [
        { input: Record<string, unknown> },
      ];
      expect(command.input).toEqual({
        QueueNamePrefix: "dlq-",
        NextToken: "tok123",
        MaxResults: 5,
      });
    });

    test("omits QueueNamePrefix/NextToken/MaxResults entirely (not undefined-valued) when called with no options", async () => {
      h.send.mockResolvedValueOnce({ QueueUrls: [] });

      const operations = new M3LSQSOperations(fakeClient());
      await operations.listQueues();

      const [command] = h.send.mock.calls[0] as [
        { input: Record<string, unknown> },
      ];
      expect(command.input).toEqual({});
      expect(Object.hasOwn(command.input, "QueueNamePrefix")).toBe(false);
      expect(Object.hasOwn(command.input, "NextToken")).toBe(false);
      expect(Object.hasOwn(command.input, "MaxResults")).toBe(false);
    });

    test("rejects M3LSQSOperationError with cause chained, and is not retried (send called exactly once), when ListQueues rejects", async () => {
      const sdkError = new Error("network blip");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.listQueues();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).cause).toBe(sdkError);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("M3LSQSListQueuesResult shape: queueUrls required, nextToken optional, both readonly", () => {
      expectTypeOf<M3LSQSListQueuesResult>().toEqualTypeOf<{
        readonly queueUrls: readonly string[];
        readonly nextToken?: string;
      }>();
    });
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

  describe("redrive()", () => {
    /** Builds a raw SDK `Message` shape for a `ReceiveMessage` mock response. */
    function sdkMessage(id: string): {
      MessageId: string;
      ReceiptHandle: string;
      Body: string;
    } {
      return {
        MessageId: id,
        ReceiptHandle: `receipt-${id}`,
        Body: `body-${id}`,
      };
    }

    /** All calls made to the mock client, cast to their command instances. */
    function calls(): unknown[] {
      return h.send.mock.calls.map(
        (callArgs: unknown[]) => (callArgs as [unknown])[0],
      );
    }

    test("issues no raw SDK call beyond ReceiveMessage/SendMessageBatch/DeleteMessageBatch commands", async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("m1"), sdkMessage("m2")],
        })
        .mockResolvedValueOnce({ Successful: [{ Id: "m1" }], Failed: [] })
        .mockResolvedValueOnce({ Successful: [{ Id: "m1" }], Failed: [] })
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) =>
        message.messageId === "m1"
          ? { action: "move", entry: { id: "m1", body: message.body } }
          : { action: "drop" };

      const operations = new M3LSQSOperations(fakeClient());
      await operations.redrive(QUEUE_URL, "https://dest", processMessage);

      for (const command of calls()) {
        expect(
          command instanceof h.ReceiveMessageCommand ||
            command instanceof h.SendMessageBatchCommand ||
            command instanceof h.DeleteMessageBatchCommand,
        ).toBe(true);
      }
    });

    test("pages the source queue, clamping the last page's receive cap to the remaining messageLimit budget", async () => {
      const page1 = Array.from({ length: 10 }, (_unused, index) =>
        sdkMessage(`p1-${String(index)}`),
      );
      const page2 = Array.from({ length: 5 }, (_unused, index) =>
        sdkMessage(`p2-${String(index)}`),
      );
      h.send
        .mockResolvedValueOnce({ Messages: page1 })
        .mockResolvedValueOnce({ Messages: page2 });

      const processMessage: M3LSQSRedriveProcessor = () => ({
        action: "retry",
      });
      const operations = new M3LSQSOperations(fakeClient());

      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
        { messageLimit: 15 },
      );

      expect(result.received).toBe(15);
      expect(result.retried).toBe(15);

      const [firstReceive, secondReceive] = calls() as [
        { input: Record<string, unknown> },
        { input: Record<string, unknown> },
      ];
      expect(firstReceive.input["MaxNumberOfMessages"]).toBe(10);
      expect(secondReceive.input["MaxNumberOfMessages"]).toBe(5);
    });

    test("per-page receive cap defaults to 10, or honors options.receiveOptions.maxMessages", async () => {
      h.send.mockResolvedValueOnce({ Messages: [] });
      const operations = new M3LSQSOperations(fakeClient());

      await operations.redrive(QUEUE_URL, "https://dest", () => ({
        action: "retry",
      }));

      const [command] = calls() as [{ input: Record<string, unknown> }];
      expect(command.input["MaxNumberOfMessages"]).toBe(10);
    });

    test("honors an explicit receiveOptions.maxMessages as the per-page cap", async () => {
      h.send.mockResolvedValueOnce({ Messages: [] });
      const operations = new M3LSQSOperations(fakeClient());

      await operations.redrive(
        QUEUE_URL,
        "https://dest",
        () => ({ action: "retry" }),
        { receiveOptions: { maxMessages: 3 } },
      );

      const [command] = calls() as [{ input: Record<string, unknown> }];
      expect(command.input["MaxNumberOfMessages"]).toBe(3);
    });

    test.each([0, -1, Number.NaN])(
      "messageLimit %s throws M3LSQSOperationError before issuing any call",
      async (messageLimit) => {
        const operations = new M3LSQSOperations(fakeClient());

        await expect(
          operations.redrive(
            QUEUE_URL,
            "https://dest",
            () => ({ action: "retry" }),
            { messageLimit },
          ),
        ).rejects.toMatchObject({ code: "ERR_SQS_OPERATION" });
        await expect(
          operations.redrive(
            QUEUE_URL,
            "https://dest",
            () => ({ action: "retry" }),
            { messageLimit },
          ),
        ).rejects.toBeInstanceOf(M3LSQSOperationError);
        expect(h.send).not.toHaveBeenCalled();
      },
    );

    test("awaits processMessage once per message, sequentially, in receive order", async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("first"), sdkMessage("second")],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const order: string[] = [];
      const processMessage: M3LSQSRedriveProcessor = async (
        message: M3LSQSReceivedMessage,
      ) => {
        order.push(message.messageId);
        await Promise.resolve();
        return { action: "retry" };
      };

      const operations = new M3LSQSOperations(fakeClient());
      await operations.redrive(QUEUE_URL, "https://dest", processMessage);

      expect(order).toEqual(["first", "second"]);
    });

    test("processMessage may return a decision synchronously (not just a Promise)", async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("sync-1")] })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor =
        (): M3LSQSRedriveDecision => ({
          action: "retry",
        });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(result.retried).toBe(1);
    });

    test('"move": a successfully sent-then-deleted entry increments moved, and the delete is matched back to receiptHandle via entry.id', async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("m1")] })
        .mockResolvedValueOnce({ Successful: [{ Id: "m1" }], Failed: [] })
        .mockResolvedValueOnce({ Successful: [{ Id: "m1" }], Failed: [] })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) => ({
        action: "move",
        entry: { id: "m1", body: message.body },
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(result.moved).toBe(1);
      expect(result.moveFailed).toEqual([]);
      expect(result.deleteFailed).toEqual([]);

      const [, sendCommand, deleteCommand] = calls() as [
        unknown,
        { input: Record<string, unknown> },
        { input: Record<string, unknown> },
      ];
      expect(sendCommand.input).toMatchObject({ QueueUrl: "https://dest" });
      expect(deleteCommand.input).toMatchObject({
        QueueUrl: QUEUE_URL,
        Entries: [{ Id: "m1", ReceiptHandle: "receipt-m1" }],
      });
    });

    test('"move": a sendBatch per-entry failure leaves the message untouched, attempts no delete, and is appended to moveFailed', async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("m1")] })
        .mockResolvedValueOnce({
          Successful: [],
          Failed: [
            { Id: "m1", SenderFault: true, Code: "Bad", Message: "nope" },
          ],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) => ({
        action: "move",
        entry: { id: "m1", body: message.body },
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(result.moved).toBe(0);
      expect(result.moveFailed).toHaveLength(1);
      expect(result.moveFailed[0]).toMatchObject({
        code: "Bad",
        senderFault: true,
        message: "nope",
      });
      expect(result.moveFailed[0]?.entry).toEqual({
        id: "m1",
        body: "body-m1",
      });

      for (const command of calls()) {
        expect(command instanceof h.DeleteMessageBatchCommand).toBe(false);
      }
    });

    test('"move": a delete failure after a successful send is appended to deleteFailed, counted in neither moved nor dropped', async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("m1")] })
        .mockResolvedValueOnce({ Successful: [{ Id: "m1" }], Failed: [] })
        .mockResolvedValueOnce({
          Successful: [],
          Failed: [
            {
              Id: "m1",
              SenderFault: false,
              Code: "ReceiptHandleIsInvalid",
              Message: "stale",
            },
          ],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) => ({
        action: "move",
        entry: { id: "m1", body: message.body },
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      // Canonical per docs/reference/aws/sqs.md and this contract's own
      // point 8: a send-succeeded-but-delete-failed entry counts in
      // NEITHER `moved` nor `dropped` — it is reported only via
      // `deleteFailed`, since it now lives (duplicated) in both queues.
      expect(result.moved).toBe(0);
      expect(result.dropped).toBe(0);
      expect(result.deleteFailed).toHaveLength(1);
      expect(result.deleteFailed[0]).toMatchObject({
        code: "ReceiptHandleIsInvalid",
        senderFault: false,
      });
      expect(result.moveFailed).toEqual([]);
    });

    test('"drop": deletes the message directly, no send, using a redrive-synthesized id', async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("d1")] })
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] })
        .mockResolvedValueOnce({ Messages: [] });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        () => ({ action: "drop" }),
      );

      expect(result.dropped).toBe(1);
      for (const command of calls()) {
        expect(command instanceof h.SendMessageBatchCommand).toBe(false);
      }

      const deleteCommand = calls().find(
        (command) => command instanceof h.DeleteMessageBatchCommand,
      ) as { input: Record<string, unknown> } | undefined;
      expect(deleteCommand?.input).toMatchObject({
        QueueUrl: QUEUE_URL,
        Entries: [{ ReceiptHandle: "receipt-d1" }],
      });
    });

    test('"drop": a delete failure leaves the message in place and is appended to deleteFailed', async () => {
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("d1")] })
        .mockResolvedValueOnce({
          Successful: [],
          Failed: [{ Id: "0", SenderFault: false, Code: "X", Message: "boom" }],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        () => ({ action: "drop" }),
      );

      expect(result.dropped).toBe(0);
      expect(result.deleteFailed).toHaveLength(1);
      expect(result.deleteFailed[0]).toMatchObject({ code: "X" });
    });

    test("a page mixing move and drop decisions issues two separate deleteBatch calls without id collision", async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("moved-1"), sdkMessage("dropped-1")],
        })
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] }) // sendBatch for the move entry, id "0"
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] }) // post-move deleteBatch, matched by entry.id "0"
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] }) // drop-path deleteBatch, synthesized id "0"
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) =>
        message.messageId === "moved-1"
          ? { action: "move", entry: { id: "0", body: message.body } }
          : { action: "drop" };

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(result.moved).toBe(1);
      expect(result.dropped).toBe(1);

      const deleteCommands = calls().filter(
        (command) => command instanceof h.DeleteMessageBatchCommand,
      ) as { input: { Entries: readonly { ReceiptHandle: string }[] } }[];
      expect(deleteCommands).toHaveLength(2);
      const receiptHandles = deleteCommands
        .flatMap((command) => command.input.Entries)
        .map((entry) => entry.ReceiptHandle)
        .toSorted();
      expect(receiptHandles).toEqual(["receipt-dropped-1", "receipt-moved-1"]);
    });

    test('"retry": performs no send/delete for that message', async () => {
      h.send.mockResolvedValueOnce({ Messages: [sdkMessage("r1")] });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        () => ({ action: "retry" }),
        { messageLimit: 1 },
      );

      expect(result.retried).toBe(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      const [onlyCall] = calls();
      expect(onlyCall instanceof h.ReceiveMessageCommand).toBe(true);
    });

    test("received === moved + dropped + retried + deduplicated is NOT a general invariant when moveFailed is non-empty", async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("ok"), sdkMessage("bad")],
        })
        .mockResolvedValueOnce({
          Successful: [{ Id: "ok" }],
          Failed: [
            { Id: "bad", SenderFault: true, Code: "X", Message: "nope" },
          ],
        })
        .mockResolvedValueOnce({ Successful: [{ Id: "ok" }], Failed: [] })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage: M3LSQSRedriveProcessor = (
        message: M3LSQSReceivedMessage,
      ) => ({
        action: "move",
        entry: { id: message.messageId, body: message.body },
      });

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(result.received).toBe(2);
      expect(result.moveFailed).toHaveLength(1);
      const sum =
        result.moved + result.dropped + result.retried + result.deduplicated;
      expect(sum).not.toBe(result.received);
    });

    test('deduplication defaults to "none": a repeated messageId is processed twice, deduplicated stays 0', async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("dup"), sdkMessage("dup")],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage = vi.fn<M3LSQSRedriveProcessor>(() => ({
        action: "retry",
      }));

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
      );

      expect(processMessage).toHaveBeenCalledTimes(2);
      expect(result.deduplicated).toBe(0);
      expect(result.retried).toBe(2);
    });

    test('deduplication "messageId": a repeated messageId within the same call skips processMessage and increments deduplicated', async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [sdkMessage("dup"), sdkMessage("dup")],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage = vi.fn<M3LSQSRedriveProcessor>(() => ({
        action: "retry",
      }));

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
        { deduplication: "messageId" },
      );

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(result.deduplicated).toBe(1);
      expect(result.retried).toBe(1);
      expect(result.received).toBe(2);
    });

    test('deduplication "messageId": an empty-string messageId is never treated as a duplicate of another empty-id message', async () => {
      h.send
        .mockResolvedValueOnce({
          Messages: [
            { MessageId: "", ReceiptHandle: "r-a", Body: "a" },
            { MessageId: "", ReceiptHandle: "r-b", Body: "b" },
          ],
        })
        .mockResolvedValueOnce({ Messages: [] });

      const processMessage = vi.fn<M3LSQSRedriveProcessor>(() => ({
        action: "retry",
      }));

      const operations = new M3LSQSOperations(fakeClient());
      const result = await operations.redrive(
        QUEUE_URL,
        "https://dest",
        processMessage,
        { deduplication: "messageId" },
      );

      expect(processMessage).toHaveBeenCalledTimes(2);
      expect(result.deduplicated).toBe(0);
      expect(result.retried).toBe(2);
    });

    test("a receive failure propagates as M3LSQSOperationError with cause chained, aborting the whole call with no partial result", async () => {
      const sdkError = new Error("network blip");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      let resolved = false;
      try {
        await operations.redrive(QUEUE_URL, "https://dest", () => ({
          action: "retry",
        }));
        resolved = true;
      } catch (error) {
        thrown = error;
      }

      expect(resolved).toBe(false);
      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      expect((thrown as M3LSQSOperationError).cause).toBe(sdkError);
    });

    test("a sendBatch request-level failure propagates as M3LSQSOperationError, same identity as sendBatch's own throw", async () => {
      const sdkError = Object.assign(new Error("denied"), {
        name: "AccessDenied",
      });
      h.send
        .mockResolvedValueOnce({ Messages: [sdkMessage("m1")] })
        .mockRejectedValueOnce(sdkError);

      const operations = new M3LSQSOperations(fakeClient());

      await expect(
        operations.redrive(
          QUEUE_URL,
          "https://dest",
          (message: M3LSQSReceivedMessage) => ({
            action: "move",
            entry: { id: "m1", body: message.body },
          }),
        ),
      ).rejects.toBeInstanceOf(M3LSQSOperationError);
    });

    test("a processMessage throw (including a non-Error value) propagates out of redrive uncaught and unwrapped", async () => {
      h.send.mockResolvedValueOnce({ Messages: [sdkMessage("m1")] });

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.redrive(QUEUE_URL, "https://dest", () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify redrive propagates processMessage's throw unwrapped
          throw "boom";
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe("boom");
      expect(thrown).not.toBeInstanceOf(M3LSQSOperationError);
    });

    test("a processMessage throw of a real Error propagates the same instance, not wrapped in M3LSQSOperationError", async () => {
      h.send.mockResolvedValueOnce({ Messages: [sdkMessage("m1")] });
      const processorError = new Error("processor exploded");

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.redrive(QUEUE_URL, "https://dest", () => {
          throw processorError;
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(processorError);
      expect(thrown).not.toBeInstanceOf(M3LSQSOperationError);
    });

    test("the defensive error for an unrecognized decision.action names only the action, never the whole decision value (a bare string decision must not leak into the message or cause)", async () => {
      h.send.mockResolvedValueOnce({ Messages: [sdkMessage("m1")] });

      // Deliberately not a real credential: split so no literal token/key
      // pattern appears in source, matching AWS's own documentation-example
      // access key id — this test only proves the value never reaches the
      // thrown message/cause, not that it is a live secret.
      const leaked =
        ["AKIA", "IOSFODNN7EXAMPLE"].join("") + "-should-not-appear-in-error";

      // A bare string bypasses the type system entirely (cast through
      // `unknown`, matching the file's established runtime-bypass pattern).
      // `String(decision)` on a string primitive returns it verbatim, so
      // a pre-fix implementation that stringified the whole decision would
      // leak `leaked` into the message; the fixed implementation reads only
      // `(decision as { action?: unknown }).action`, and a string primitive
      // has no `.action` property, so it reads `undefined`.
      const malformedProcessMessage = ((): unknown =>
        leaked) as unknown as M3LSQSRedriveProcessor;

      const operations = new M3LSQSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.redrive(
          QUEUE_URL,
          "https://dest",
          malformedProcessMessage,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSQSOperationError);
      const operationError = thrown as M3LSQSOperationError;
      expect(operationError.message).toContain("undefined");
      expect(operationError.message).not.toContain(leaked);
      // The malformed decision is a locally-detected invalid-input
      // condition, not a genuine underlying exception — it must not be
      // chained as `cause` (which would leak it via `error.toJSON()` or
      // `console.error(error)` even with a safe `.message`).
      expect(operationError.cause).toBeUndefined();
    });

    test("M3LSQSRedriveDecision is a 3-arm discriminated union on action", () => {
      expectTypeOf<M3LSQSRedriveDecision>().toEqualTypeOf<
        | { readonly action: "move"; readonly entry: M3LSQSSendEntry }
        | { readonly action: "drop" }
        | { readonly action: "retry" }
      >();
    });

    test("M3LSQSRedriveProcessor accepts both a sync-returning and an async-returning callback", () => {
      const sync: M3LSQSRedriveProcessor = () => ({ action: "retry" });
      const asynchronous: M3LSQSRedriveProcessor = async () =>
        Promise.resolve({ action: "retry" } as const);
      expectTypeOf(sync).toExtend<M3LSQSRedriveProcessor>();
      expectTypeOf(asynchronous).toExtend<M3LSQSRedriveProcessor>();
    });

    test("M3LSQSRedriveOptions and M3LSQSRedriveResult fields are all readonly", () => {
      expectTypeOf<M3LSQSRedriveOptions>().toEqualTypeOf<{
        readonly messageLimit?: number;
        readonly receiveOptions?: M3LSQSReceiveOptions;
        readonly deduplication?: "none" | "messageId";
      }>();
      expectTypeOf<M3LSQSRedriveResult>().toEqualTypeOf<{
        readonly received: number;
        readonly moved: number;
        readonly dropped: number;
        readonly retried: number;
        readonly deduplicated: number;
        readonly moveFailed: readonly M3LSQSBatchFailure<M3LSQSSendEntry>[];
        readonly deleteFailed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
      }>();
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
    expectTypeOf<M3LSQSReceivedMessage>().toExtend<{
      readonly messageId: string;
      readonly receiptHandle: string;
      readonly body: string;
    }>();
  });
});
