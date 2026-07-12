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
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LSQSOperations`'s
 * methods currently throw `M3LSQSOperationError("... not yet implemented")`
 * (see src/aws/sqs/client.ts). `implementing-submodules` turns them GREEN.
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

  test("purgeQueue() rejects with M3LSQSOperationError (code ERR_SQS_OPERATION) when PurgeQueue rejects (e.g. cooldown)", async () => {
    h.send.mockRejectedValueOnce(
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
