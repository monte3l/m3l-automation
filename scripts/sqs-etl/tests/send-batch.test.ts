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

import { sendBatch } from "../src/steps/send-batch.js";
import {
  stubInput,
  stubOutputStreams,
  writtenJsonlRecords,
} from "./support/fsFakes.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `send-batch` row + design
 * decisions #3 (record->entry mapping), #4 (chunk-scoped id synthesis), #9
 * (<=10-entry chunking, batchSize total cap). Streams `input` JSONL, chunks
 * into <=10-entry M3LSQSSendEntry batches, sendBatch()s each chunk;
 * per-entry failures append to failed.jsonl.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendBatch", () => {
  test("a record with no 'body' property becomes the entry body as a whole (stringified object)", async () => {
    stubInput(['{"id":1}', '{"id":2}'].join("\n"));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-1",
      sqsOperations,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.sendBatch).toHaveBeenCalledTimes(1);
    const [queueUrl, entries] = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSSendEntry[]];
    expect(queueUrl).toBe("https://sqs.example/q");
    expect(entries).toEqual([
      { id: "0", body: '{"id":1}' },
      { id: "1", body: '{"id":2}' },
    ]);
  });

  test("a bare string line becomes the entry body verbatim, not re-stringified", async () => {
    stubInput('"hello"');
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-2",
      sqsOperations,
    });

    const [, entries] = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSSendEntry[]];
    expect(entries).toEqual([{ id: "0", body: "hello" }]);
  });

  test("a record with a string 'body' uses it verbatim and passes through delaySeconds/messageGroupId when present", async () => {
    stubInput(
      JSON.stringify({
        body: "hello world",
        delaySeconds: 5,
        messageGroupId: "group-1",
      }),
    );
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-3",
      sqsOperations,
    });

    const [, entries] = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSSendEntry[]];
    expect(entries).toEqual([
      {
        id: "0",
        body: "hello world",
        delaySeconds: 5,
        messageGroupId: "group-1",
      },
    ]);
  });

  test("a record with a non-string 'body' JSON.stringifies just the body value", async () => {
    stubInput(JSON.stringify({ body: { nested: true } }));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-4",
      sqsOperations,
    });

    const [, entries] = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSSendEntry[]];
    expect(entries).toEqual([
      { id: "0", body: JSON.stringify({ nested: true }) },
    ]);
  });

  test("chunks entries into <=10-entry batches, resetting the positional id per chunk", async () => {
    const lines = Array.from({ length: 15 }, (_unused, index) =>
      JSON.stringify({ id: index }),
    );
    stubInput(lines.join("\n"));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      batchSize: 15,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-5",
      sqsOperations,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.sendBatch).toHaveBeenCalledTimes(2);
    const calls = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls as [string, readonly AWS.M3LSQSSendEntry[]][];
    expect(calls[0]?.[1]).toHaveLength(10);
    expect(calls[0]?.[1].map((entry) => entry.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(calls[1]?.[1]).toHaveLength(5);
    expect(calls[1]?.[1].map((entry) => entry.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  test("caps total processed entries at 'batchSize'", async () => {
    const lines = Array.from({ length: 8 }, (_unused, index) =>
      JSON.stringify({ id: index }),
    );
    stubInput(lines.join("\n"));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      batchSize: 5,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-6",
      sqsOperations,
    });

    const calls = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls as [string, readonly AWS.M3LSQSSendEntry[]][];
    const totalSent = calls.reduce(
      (sum, [, entries]) => sum + entries.length,
      0,
    );
    expect(totalSent).toBe(5);
  });

  test("a malformed JSONL line is a per-record skip; surviving records still send", async () => {
    stubInput(['{"id":1}', "not-json", '{"id":2}'].join("\n"));
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-7",
      sqsOperations,
    });

    const [, entries] = (
      sqsOperations.sendBatch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, readonly AWS.M3LSQSSendEntry[]];
    expect(entries).toHaveLength(2);
  });

  test("per-entry send failures are appended to failed.jsonl", async () => {
    stubInput(['{"id":1}', '{"id":2}'].join("\n"));
    const { streams } = stubOutputStreams();
    const failedEntry: AWS.M3LSQSSendEntry = { id: "1", body: '{"id":2}' };
    const sqsOperations = createFakeSqsOperations({
      sendBatch: vi.fn().mockResolvedValue({
        successful: [{ id: "0", body: '{"id":1}' }],
        failed: [
          { entry: failedEntry, code: "InternalError", senderFault: false },
        ],
      }),
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await sendBatch({
      config,
      paths,
      logger,
      correlationId: "run-8",
      sqsOperations,
    });

    // Search on the failed entry's own top-level 'id' field, not the nested
    // 'body' string's content — body is itself JSON-stringified inside the
    // outer JSON.stringify, so its raw text (e.g. '"id":2') is backslash-
    // escaped ('\"id\":2') in the written line and would never match.
    const failedStream = streams.find((stream) =>
      stream.content().includes('"id":"1"'),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      expect(writtenJsonlRecords(failedStream)).toEqual([failedEntry]);
    }
  });

  test.each(["queueUrl", "input"] as const)(
    "throws ERR_SQS_ETL_CONFIG when '%s' is missing, never calling sendBatch",
    async (missing) => {
      stubInput("");
      stubOutputStreams();
      const sqsOperations = createFakeSqsOperations();
      const base: Record<string, unknown> = {
        queueUrl: "https://sqs.example/q",
        input: "in.jsonl",
      };
      delete base[missing];
      const config = buildConfig(base);
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);

      let thrown: unknown;
      try {
        await sendBatch({
          config,
          paths,
          logger,
          correlationId: `run-missing-${missing}`,
          sqsOperations,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_CONFIG");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.sendBatch).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );
});
