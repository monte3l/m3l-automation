import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `drainQueue` (`src/steps/drain-queue.ts`) — reads a queue's current depth,
 * pages `M3LSQSOperations.receive` up to a caller-supplied budget, dedupes
 * by `messageId`, archives the full drained set before returning, and
 * checks `signal.aborted` at the top of every page.
 *
 * `writeJsonArtifact` is mocked via `vi.hoisted()` (the static-import
 * mocking gotcha `run-sqs-dead-letter-triage.test.ts` already documents) so
 * this file never touches the real filesystem.
 */

const { writeJsonArtifactMock } = vi.hoisted(() => ({
  writeJsonArtifactMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/steps/write-artifact.js", () => ({
  writeJsonArtifact: writeJsonArtifactMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import {
  DRAIN_BYTE_BUDGET,
  DRAIN_CODE,
  drainQueue,
} from "../src/steps/drain-queue.js";
import type { DrainQueueDeps } from "../src/steps/drain-queue.js";
import {
  createFakeSqsOperations,
  createRecordingLogger,
} from "./support/aws-fakes.js";

const paths = new Core.M3LPaths();

/** Builds one `M3LSQSReceivedMessage`-shaped fixture. */
function received(messageId: string, body = `body-${messageId}`) {
  return { messageId, receiptHandle: `rh-${messageId}`, body };
}

function baseDeps(overrides: Partial<DrainQueueDeps> = {}): DrainQueueDeps {
  const { logger } = createRecordingLogger();
  return {
    sqs: createFakeSqsOperations(),
    paths,
    logger,
    queueUrl: "https://sqs.example/orders-dlq",
    queue: "orders-dlq",
    maxMessages: 100,
    visibilityTimeout: 1800,
    signal: undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  writeJsonArtifactMock.mockReset();
  writeJsonArtifactMock.mockResolvedValue(undefined);
});

describe("drainQueue — happy path", () => {
  it("dedupes a messageId repeated across two pages, stopping on the empty page", async () => {
    const receive = vi
      .fn()
      .mockResolvedValueOnce([received("m1"), received("m2")])
      .mockResolvedValueOnce([received("m2"), received("m3")])
      .mockResolvedValueOnce([]);
    const deps = baseDeps({
      sqs: createFakeSqsOperations({
        receive,
        getQueueAttributes: vi.fn().mockResolvedValue({
          approximateNumberOfMessages: 3,
          approximateNumberOfMessagesNotVisible: 0,
          approximateNumberOfMessagesDelayed: 0,
          queueArn: "arn:aws:sqs:us-east-1:000000000000:orders-dlq",
        }),
      }),
    });

    const result = await drainQueue(deps);

    expect(result.messages.map((message) => message.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(result.depth).toBe(3);
    expect(receive).toHaveBeenCalledTimes(3);
  });

  it("writes the archive artifact and returns its relative path", async () => {
    const deps = baseDeps({
      sqs: createFakeSqsOperations({
        receive: vi
          .fn()
          .mockResolvedValueOnce([received("m1")])
          .mockResolvedValueOnce([]),
      }),
    });

    const result = await drainQueue(deps);

    expect(writeJsonArtifactMock).toHaveBeenCalledTimes(1);
    const [, name, value] = writeJsonArtifactMock.mock.calls[0] as [
      unknown,
      string,
      unknown,
    ];
    expect(name).toBe(result.archivePath);
    expect(name.startsWith("orders-dlq/drain-")).toBe(true);
    expect(name.endsWith(".json")).toBe(true);
    // The archive keeps every field, including the full raw body and the
    // receipt handle — only the persisted report is ever excerpted.
    expect(JSON.stringify(value)).toContain("body-m1");
  });
});

describe("drainQueue — paging budget", () => {
  it("stops at the maxMessages budget, clamping the final page and never requesting more than 10", async () => {
    const receive = vi.fn().mockImplementation((_queueUrl: string, options) => {
      const requested = (options as { maxMessages?: number }).maxMessages ?? 10;
      return Promise.resolve(
        Array.from({ length: requested }, (_unused, index) =>
          received(`m-${String(receive.mock.calls.length)}-${String(index)}`),
        ),
      );
    });
    const deps = baseDeps({
      maxMessages: 15,
      sqs: createFakeSqsOperations({ receive }),
    });

    const result = await drainQueue(deps);

    expect(result.messages).toHaveLength(15);
    expect(receive).toHaveBeenCalledTimes(2);
    const firstOptions = receive.mock.calls[0]?.[1] as { maxMessages?: number };
    const secondOptions = receive.mock.calls[1]?.[1] as {
      maxMessages?: number;
    };
    expect(firstOptions.maxMessages).toBe(10);
    expect(secondOptions.maxMessages).toBe(5);
    for (const call of receive.mock.calls) {
      const options = call[1] as { maxMessages?: number };
      expect(options.maxMessages ?? 0).toBeLessThanOrEqual(10);
    }
  });
});

describe("drainQueue — ordering: archive before anything can consume the messages", () => {
  it("writes the archive before logging the drain-complete step line", async () => {
    const { logger } = createRecordingLogger();
    const stepSpy = vi.spyOn(logger, "step");
    const deps = baseDeps({
      logger,
      sqs: createFakeSqsOperations({
        receive: vi
          .fn()
          .mockResolvedValueOnce([received("m1")])
          .mockResolvedValueOnce([]),
      }),
    });

    await drainQueue(deps);

    const archiveOrder = writeJsonArtifactMock.mock.invocationCallOrder[0];
    const stepOrder = stepSpy.mock.invocationCallOrder[0];
    expect(archiveOrder).toBeDefined();
    expect(stepOrder).toBeDefined();
    expect(archiveOrder).toBeLessThan(stepOrder as number);
  });
});

describe("drainQueue — failure path: an unarchived drain must fail the run", () => {
  it("propagates a rejecting archive write rather than returning the drained messages", async () => {
    const archiveFailure = new Error("disk full");
    writeJsonArtifactMock.mockRejectedValueOnce(archiveFailure);
    const deps = baseDeps({
      sqs: createFakeSqsOperations({
        receive: vi
          .fn()
          .mockResolvedValueOnce([received("m1")])
          .mockResolvedValueOnce([]),
      }),
    });

    await expect(drainQueue(deps)).rejects.toBe(archiveFailure);
  });
});

describe("drainQueue — cancellation", () => {
  it("throws M3LOperationAbortedError before the first receive when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const receive = vi.fn();
    const deps = baseDeps({
      signal: controller.signal,
      sqs: createFakeSqsOperations({ receive }),
    });

    await expect(drainQueue(deps)).rejects.toBeInstanceOf(
      Core.M3LOperationAbortedError,
    );
    expect(receive).not.toHaveBeenCalled();
    expect(writeJsonArtifactMock).not.toHaveBeenCalled();
  });
});

describe("drainQueue — livelock regression: a page with no new ids terminates the loop", () => {
  // Reachable in production via the legal `visibilityTimeout=0`: a drained
  // message stays immediately visible, so an unbroken paging loop would
  // re-receive the same full page forever. `receive` here always resolves
  // the same message, forever — if the "no new ids" break regresses this
  // hangs, so the test carries an explicit short timeout to fail fast
  // instead of stalling CI.
  it("resolves instead of paging forever when every page redelivers the same message", async () => {
    const receive = vi.fn().mockResolvedValue([received("m1")]);
    const deps = baseDeps({
      visibilityTimeout: 0,
      sqs: createFakeSqsOperations({ receive }),
    });

    const result = await drainQueue(deps);

    expect(result.messages.map((message) => message.messageId)).toEqual(["m1"]);
    expect(receive.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 2000);
});

describe("drainQueue — byte budget", () => {
  // Sized so exactly two received messages cross DRAIN_BYTE_BUDGET without
  // maxMessages intervening first: one body alone stays under the budget,
  // two sum past it. Derived from the real constant so a retune of
  // DRAIN_BYTE_BUDGET keeps this test honest instead of silently testing a
  // stale hard-coded threshold.
  const bodySize = Math.floor(DRAIN_BYTE_BUDGET / 2) + 1;
  const bigBody = "x".repeat(bodySize);

  it("stops paging once accumulated body bytes cross DRAIN_BYTE_BUDGET, before maxMessages is reached", async () => {
    const receive = vi
      .fn()
      .mockResolvedValueOnce([
        received("m1", bigBody),
        received("m2", bigBody),
      ]);
    const deps = baseDeps({
      maxMessages: 10_000,
      sqs: createFakeSqsOperations({ receive }),
    });

    const result = await drainQueue(deps);

    expect(result.messages).toHaveLength(2);
    expect(result.messages.length).toBeLessThan(deps.maxMessages);
    expect(receive).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("marks both the returned result and the log line as truncated when the budget is reached", async () => {
    const { logger } = createRecordingLogger();
    const stepSpy = vi.spyOn(logger, "step");
    const receive = vi
      .fn()
      .mockResolvedValueOnce([
        received("m1", bigBody),
        received("m2", bigBody),
      ]);
    const deps = baseDeps({
      logger,
      maxMessages: 10_000,
      sqs: createFakeSqsOperations({ receive }),
    });

    const result = await drainQueue(deps);

    expect(result.truncated).toBe(true);
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const [message, data] = stepSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain(String(DRAIN_BYTE_BUDGET));
    expect(message.toLowerCase()).toContain("byte budget");
    expect(data["truncated"]).toBe(true);
  }, 10_000);

  it("does not mark an ordinary small drain as truncated, on the result or the log line", async () => {
    const { logger } = createRecordingLogger();
    const stepSpy = vi.spyOn(logger, "step");
    const deps = baseDeps({
      logger,
      sqs: createFakeSqsOperations({
        receive: vi
          .fn()
          .mockResolvedValueOnce([received("m1"), received("m2")])
          .mockResolvedValueOnce([]),
      }),
    });

    const result = await drainQueue(deps);

    expect(result.truncated).toBe(false);
    expect(stepSpy).toHaveBeenCalledTimes(1);
    const [, data] = stepSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data["truncated"]).toBe(false);
  });

  it("still writes the full archive artifact when the drain is truncated by the byte budget", async () => {
    const receive = vi
      .fn()
      .mockResolvedValueOnce([
        received("m1", bigBody),
        received("m2", bigBody),
      ]);
    const deps = baseDeps({
      maxMessages: 10_000,
      sqs: createFakeSqsOperations({ receive }),
    });

    const result = await drainQueue(deps);

    expect(writeJsonArtifactMock).toHaveBeenCalledTimes(1);
    const [, name, value] = writeJsonArtifactMock.mock.calls[0] as [
      unknown,
      string,
      { truncated: boolean; messages: readonly unknown[] },
    ];
    expect(name).toBe(result.archivePath);
    expect(value.truncated).toBe(true);
    expect(value.messages).toHaveLength(2);
  }, 10_000);
});

describe("DRAIN_CODE", () => {
  it("is exported as the documented literal", () => {
    expect(DRAIN_CODE).toBe("ERR_DLQ_TRIAGE_DRAIN");
  });
});
