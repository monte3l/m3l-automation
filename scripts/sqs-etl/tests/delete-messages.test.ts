import * as fsp from "node:fs/promises";
import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { deleteMessages } from "../src/steps/delete-messages.js";
import {
  stubInput,
  stubOutputStreams,
  writtenJsonlRecords,
} from "./support/fsFakes.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `delete-messages` row +
 * design decisions #4/#5/#9/#10. Streams `input` JSONL (`{ receiptHandle }`
 * rows), chunks into <=10-entry M3LSQSDeleteEntry batches, deleteBatch()s
 * each; per-entry failures append to failed.jsonl. Confirm-gated.
 */

function bypassPrompt(): Core.M3LPrompt {
  const prompt = new Core.M3LPrompt();
  vi.spyOn(prompt, "confirm").mockResolvedValue(true);
  return prompt;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteMessages", () => {
  test("maps each { receiptHandle } row to a chunk-scoped-id M3LSQSDeleteEntry and deletes it", async () => {
    stubInput(
      [
        JSON.stringify({ receiptHandle: "rh1" }),
        JSON.stringify({ receiptHandle: "rh2" }),
      ].join("\n"),
    );
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await deleteMessages({
      config,
      paths,
      logger,
      correlationId: "run-1",
      sqsOperations,
      prompt,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
    const [queueUrl, entries] = (
      sqsOperations.deleteBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSDeleteEntry[]];
    expect(queueUrl).toBe("https://sqs.example/q");
    expect(entries).toEqual([
      { id: "0", receiptHandle: "rh1" },
      { id: "1", receiptHandle: "rh2" },
    ]);
  });

  test("a row missing/mistyped 'receiptHandle' is a malformed-record skip, not a throw", async () => {
    stubInput(
      [
        JSON.stringify({ receiptHandle: "rh1" }),
        JSON.stringify({ notReceiptHandle: "oops" }),
        JSON.stringify({ receiptHandle: 42 }),
        JSON.stringify({ receiptHandle: "rh2" }),
      ].join("\n"),
    );
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await deleteMessages({
      config,
      paths,
      logger,
      correlationId: "run-2",
      sqsOperations,
      prompt,
    });

    const [, entries] = (
      sqsOperations.deleteBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSDeleteEntry[]];
    expect(entries.map((entry) => entry.receiptHandle)).toEqual(["rh1", "rh2"]);
  });

  test("chunks entries into <=10-entry batches, resetting the positional id per chunk", async () => {
    const lines = Array.from({ length: 12 }, (_unused, index) =>
      JSON.stringify({ receiptHandle: `rh${String(index)}` }),
    );
    stubInput(lines.join("\n"));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      batchSize: 12,
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await deleteMessages({
      config,
      paths,
      logger,
      correlationId: "run-3",
      sqsOperations,
      prompt,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(2);
    const calls = (
      sqsOperations.deleteBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls as [string, readonly AWS.M3LSQSDeleteEntry[]][];
    expect(calls[0]?.[1]).toHaveLength(10);
    expect(calls[1]?.[1]).toHaveLength(2);
    expect(calls[1]?.[1].map((entry) => entry.id)).toEqual(["0", "1"]);
  });

  test("a declined confirmation aborts before any deleteBatch call", async () => {
    stubInput(JSON.stringify({ receiptHandle: "rh1" }));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    let thrown: unknown;
    try {
      await deleteMessages({
        config,
        paths,
        logger,
        correlationId: "run-4",
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
  });

  test("per-entry delete failures are appended to failed.jsonl", async () => {
    stubInput(
      [
        JSON.stringify({ receiptHandle: "rh1" }),
        JSON.stringify({ receiptHandle: "rh2" }),
      ].join("\n"),
    );
    const { streams } = stubOutputStreams();
    const failedEntry: AWS.M3LSQSDeleteEntry = {
      id: "1",
      receiptHandle: "rh2",
    };
    const sqsOperations = createFakeSqsOperations({
      deleteBatch: vi.fn().mockResolvedValue({
        successful: [{ id: "0", receiptHandle: "rh1" }],
        failed: [
          { entry: failedEntry, code: "InternalError", senderFault: false },
        ],
      }),
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    await deleteMessages({
      config,
      paths,
      logger,
      correlationId: "run-5",
      sqsOperations,
      prompt,
    });

    const failedStream = streams.find((stream) =>
      stream.content().includes("rh2"),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      expect(writtenJsonlRecords(failedStream)).toEqual([failedEntry]);
    }
  });

  test("a writer.close() failure does not mask the original deleteBatch() rejection", async () => {
    stubInput(JSON.stringify({ receiptHandle: "rh1" }));
    const { streams } = stubOutputStreams();
    const originalFailure = new Error("aws deleteBatch unavailable");
    const closeFailure = new Error("simulated close failure");
    const deleteBatchMock = vi.fn().mockImplementation(() => {
      const failedStream = streams[streams.length - 1];
      failedStream?.armCloseFailure(closeFailure);
      return Promise.reject(originalFailure);
    });
    const sqsOperations = createFakeSqsOperations({
      deleteBatch: deleteBatchMock,
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = bypassPrompt();

    let thrown: unknown;
    try {
      await deleteMessages({
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

    expect(thrown).toBe(originalFailure);
  });

  test.each(["queueUrl", "input"] as const)(
    "throws ERR_SQS_ETL_CONFIG when '%s' is missing, never prompting or calling deleteBatch",
    async (missing) => {
      stubInput("");
      stubOutputStreams();
      const sqsOperations = createFakeSqsOperations();
      const base: Record<string, unknown> = {
        queueUrl: "https://sqs.example/q",
        input: "in.jsonl",
        yes: true,
      };
      delete base[missing];
      const config = buildConfig(base);
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const prompt = new Core.M3LPrompt();
      const confirm = vi.spyOn(prompt, "confirm");

      let thrown: unknown;
      try {
        await deleteMessages({
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
      expect(confirm).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.deleteBatch).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );
});
