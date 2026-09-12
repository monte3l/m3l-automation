import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept writeFile —
// mirrors scripts/eventbridge-schedules/tests/describe-rule.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import { listQueues } from "../src/steps/list-queues.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract (issue #553, X5, PR 2): `list-queues` is a read-only step — no
 * `prompt`/`awsTarget`/`reportRecovery` field, never destructive-gated.
 * `listQueues(deps)` reads optional `queueNamePrefix`/`nextToken`/`output`
 * via `Core.M3LConfigAccessor.optionalString`, calls
 * `deps.sqsOperations.listQueues({...})` forwarding only the config values
 * that are actually set, optionally persists the raw result via
 * `Core.M3LJSONFileExporter` when `output` is configured (mirrors
 * `eventbridge-schedules`'s `describe-rule.ts` shape), and returns the raw
 * `AWS.M3LSQSListQueuesResult` unchanged.
 */

const emptyResult: AWS.M3LSQSListQueuesResult = { queueUrls: [] };

const populatedResult: AWS.M3LSQSListQueuesResult = {
  queueUrls: ["https://sqs.example/queue-a", "https://sqs.example/queue-b"],
  nextToken: "next-page-token",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listQueues", () => {
  test("happy path: returns the raw result and writes no file when 'output' is unset", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const sqsOperations = createFakeSqsOperations({
      listQueues: vi.fn().mockResolvedValue(populatedResult),
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const result = await listQueues({
      config,
      paths,
      logger,
      correlationId: "run-1",
      sqsOperations,
    });

    expect(result).toEqual(populatedResult);
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test("forwards 'queueNamePrefix' and 'nextToken' config values to sqsOperations.listQueues", async () => {
    const listQueuesMock = vi.fn().mockResolvedValue(emptyResult);
    const sqsOperations = createFakeSqsOperations({
      listQueues: listQueuesMock,
    });
    const config = buildConfig({
      queueNamePrefix: "prod-",
      nextToken: "abc123",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listQueues({
      config,
      paths,
      logger,
      correlationId: "run-2",
      sqsOperations,
    });

    expect(listQueuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queueNamePrefix: "prod-",
        nextToken: "abc123",
      }),
    );
  });

  test("calls sqsOperations.listQueues without queueNamePrefix/nextToken keys when both are unset", async () => {
    const listQueuesMock = vi.fn().mockResolvedValue(emptyResult);
    const sqsOperations = createFakeSqsOperations({
      listQueues: listQueuesMock,
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listQueues({
      config,
      paths,
      logger,
      correlationId: "run-3",
      sqsOperations,
    });

    const [options] = listQueuesMock.mock.calls[0] as [
      Record<string, unknown> | undefined,
    ];
    if (options !== undefined) {
      expect(options).not.toHaveProperty("queueNamePrefix");
      expect(options).not.toHaveProperty("nextToken");
    }
  });

  test("writes the result via M3LJSONFileExporter when 'output' is configured", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const sqsOperations = createFakeSqsOperations({
      listQueues: vi.fn().mockResolvedValue(populatedResult),
    });
    const config = buildConfig({ output: "queues.json" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listQueues({
      config,
      paths,
      logger,
      correlationId: "run-4",
      sqsOperations,
    });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const call = writeFileSpy.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("unreachable");
    const [, payload] = call;
    if (typeof payload !== "string") {
      throw new Error("expected a string payload");
    }
    expect(JSON.parse(payload)).toEqual(populatedResult);
  });

  test("does not write any file when 'output' is unset", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const sqsOperations = createFakeSqsOperations({
      listQueues: vi.fn().mockResolvedValue(emptyResult),
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listQueues({
      config,
      paths,
      logger,
      correlationId: "run-5",
      sqsOperations,
    });

    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test("propagates an AWS.M3LSQSOperationError from sqsOperations.listQueues unwrapped", async () => {
    const sdkError = new AWS.M3LSQSOperationError(
      "listQueues: ListQueues failed",
      { cause: new Error("Throttled") },
    );
    const sqsOperations = createFakeSqsOperations({
      listQueues: vi.fn().mockRejectedValue(sdkError),
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await listQueues({
        config,
        paths,
        logger,
        correlationId: "run-6",
        sqsOperations,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(sdkError);
  });

  test("throws ERR_SQS_ETL_CONFIG when 'queueNamePrefix' is stored as a non-string (wrong-type rejection)", async () => {
    const listQueuesMock = vi.fn().mockResolvedValue(emptyResult);
    const sqsOperations = createFakeSqsOperations({
      listQueues: listQueuesMock,
    });
    const config = buildConfig({ queueNamePrefix: 42 });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      listQueues({
        config,
        paths,
        logger,
        correlationId: "run-7",
        sqsOperations,
      }),
    ).rejects.toMatchObject({ code: "ERR_SQS_ETL_CONFIG" });
    expect(listQueuesMock).not.toHaveBeenCalled();
  });

  test("throws ERR_SQS_ETL_CONFIG when 'nextToken' is stored as a non-string (wrong-type rejection)", async () => {
    const listQueuesMock = vi.fn().mockResolvedValue(emptyResult);
    const sqsOperations = createFakeSqsOperations({
      listQueues: listQueuesMock,
    });
    const config = buildConfig({ nextToken: 42 });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      listQueues({
        config,
        paths,
        logger,
        correlationId: "run-8",
        sqsOperations,
      }),
    ).rejects.toMatchObject({ code: "ERR_SQS_ETL_CONFIG" });
    expect(listQueuesMock).not.toHaveBeenCalled();
  });
});
