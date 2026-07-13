import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { dumpQueue } from "../src/steps/dump-queue.js";
import { stubOutputStreams, writtenJsonlRecords } from "./support/fsFakes.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `dump-queue` row + design
 * decisions #4/#9/#10/#11. Long-polls `receive()` (10/call, waitTimeSeconds
 * 20) appending each page to `output` until `batchSize` is reached or an
 * empty page is returned (queue drained). `deleteAfterDump` additionally
 * `deleteBatch()`s each written page, confirm-gated ONCE before the first
 * delete of the run (not per page).
 */

function message(index: number): AWS.M3LSQSReceivedMessage {
  return {
    messageId: `msg-${String(index)}`,
    receiptHandle: `rh-${String(index)}`,
    body: `{"n":${String(index)}}`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dumpQueue", () => {
  test("stops when receive() returns an empty page (queue drained), not an error", async () => {
    const { streams } = stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1), message(2), message(3)])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-1",
      sqsOperations,
      prompt,
    });

    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenNthCalledWith(1, "https://sqs.example/q", {
      maxMessages: 10,
      waitTimeSeconds: 20,
    });
    const [output] = streams;
    expect(output).toBeDefined();
    if (output !== undefined) {
      expect(writtenJsonlRecords(output)).toHaveLength(3);
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).not.toHaveBeenCalled();
  });

  test("stops once the cumulative received count reaches 'batchSize'", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1), message(2), message(3)])
      .mockResolvedValueOnce([message(4), message(5), message(6)])
      .mockResolvedValueOnce([message(7)]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      batchSize: 6,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-2",
      sqsOperations,
      prompt,
    });

    expect(receive).toHaveBeenCalledTimes(2);
  });

  test("passes 'visibilityTimeoutSeconds' through to receive() only when set", async () => {
    stubOutputStreams();
    const receive = vi.fn().mockResolvedValue([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      visibilityTimeoutSeconds: 30,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-3",
      sqsOperations,
      prompt,
    });

    expect(receive).toHaveBeenCalledWith("https://sqs.example/q", {
      maxMessages: 10,
      waitTimeSeconds: 20,
      visibilityTimeout: 30,
    });
  });

  test("deleteAfterDump=true bypassed by yes=true deletes each written page without prompting", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1), message(2)])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      deleteAfterDump: true,
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-4",
      sqsOperations,
      prompt,
    });

    expect(confirm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
    const [queueUrl, entries] = (
      sqsOperations.deleteBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSDeleteEntry[]];
    expect(queueUrl).toBe("https://sqs.example/q");
    expect(entries).toEqual([
      { id: "0", receiptHandle: "rh-1" },
      { id: "1", receiptHandle: "rh-2" },
    ]);
  });

  test("deleteAfterDump=true, yes=false confirms exactly ONCE across multiple deleted pages", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([message(2)])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      deleteAfterDump: true,
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-5",
      sqsOperations,
      prompt,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(2);
  });

  test("a declined confirmation aborts the run, but the already-appended page's output survives", async () => {
    const { streams } = stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      deleteAfterDump: true,
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    let thrown: unknown;
    try {
      await dumpQueue({
        config,
        paths,
        logger,
        correlationId: "run-6",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).not.toHaveBeenCalled();
    const [output] = streams;
    expect(output).toBeDefined();
    if (output !== undefined) {
      expect(writtenJsonlRecords(output)).toHaveLength(1);
    }
  });

  test("caps the receive() request itself to the remaining 'batchSize' budget, not just the written/deleted count", async () => {
    stubOutputStreams();
    // 'receive()' is a fake and does not itself enforce 'maxMessages' — it
    // returns a full 5-message page regardless of what was requested, so the
    // ONLY way this assertion can pass is if the request itself was capped.
    const receive = vi
      .fn()
      .mockResolvedValueOnce([
        message(1),
        message(2),
        message(3),
        message(4),
        message(5),
      ])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      batchSize: 3,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-batch-cap",
      sqsOperations,
      prompt,
    });

    expect(receive).toHaveBeenNthCalledWith(1, "https://sqs.example/q", {
      maxMessages: 3,
      waitTimeSeconds: 20,
    });
  });

  test("a deleteBatch() failure during deleteAfterDump is surfaced via logger.warning, not silently discarded", async () => {
    stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1), message(2)])
      .mockResolvedValueOnce([]);
    const failedDeleteEntry: AWS.M3LSQSDeleteEntry = {
      id: "1",
      receiptHandle: "rh-2",
    };
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: "0", receiptHandle: "rh-1" }],
      failed: [
        {
          entry: failedDeleteEntry,
          code: "InternalError",
          senderFault: false,
        },
      ],
    });
    const sqsOperations = createFakeSqsOperations({ receive, deleteBatch });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      deleteAfterDump: true,
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");
    const prompt = new Core.M3LPrompt();

    await dumpQueue({
      config,
      paths,
      logger,
      correlationId: "run-delete-failure",
      sqsOperations,
      prompt,
    });

    const calls = warning.mock.calls as unknown[][];
    const mentionsFailure = calls.some((call) =>
      call.some((arg) => JSON.stringify(arg).includes("rh-2")),
    );
    expect(mentionsFailure).toBe(true);
  });

  test("a writer.close() failure does not mask the original declined-confirmation error", async () => {
    const { streams } = stubOutputStreams();
    const receive = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([]);
    const sqsOperations = createFakeSqsOperations({ receive });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      output: "out.jsonl",
      deleteAfterDump: true,
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const closeFailure = new Error("simulated close failure");
    vi.spyOn(prompt, "confirm").mockImplementation(() => {
      const output = streams[streams.length - 1];
      output?.armCloseFailure(closeFailure);
      return Promise.resolve(false);
    });

    let thrown: unknown;
    try {
      await dumpQueue({
        config,
        paths,
        logger,
        correlationId: "run-close-fail",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
  });

  test.each(["queueUrl", "output"] as const)(
    "throws ERR_SQS_ETL_CONFIG when '%s' is missing, never calling receive()",
    async (missing) => {
      stubOutputStreams();
      const receive = vi.fn().mockResolvedValue([]);
      const sqsOperations = createFakeSqsOperations({ receive });
      const base: Record<string, unknown> = {
        queueUrl: "https://sqs.example/q",
        output: "out.jsonl",
      };
      delete base[missing];
      const config = buildConfig(base);
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();

      let thrown: unknown;
      try {
        await dumpQueue({
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
