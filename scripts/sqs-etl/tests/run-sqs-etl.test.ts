import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Contract (hub-resolved design decision #2): `run-sqs-etl.ts` is a thin
 * dispatcher — reads `command` (already oneOf-validated by the declared
 * schema) and `switch`es to the matching step, passing `{ config, paths,
 * logger, correlationId, sqsOperations, prompt }` through unchanged. This
 * file asserts ONLY the dispatch — never a step's internal logic (that is
 * each step's own test file's job).
 */

const dumpQueueMock = vi.fn();
const sendBatchMock = vi.fn();
const redriveQueueMock = vi.fn();
const deleteMessagesMock = vi.fn();
const purgeQueueMock = vi.fn();
const transformRecordsMock = vi.fn();

vi.mock("../src/steps/dump-queue.js", () => ({ dumpQueue: dumpQueueMock }));
vi.mock("../src/steps/send-batch.js", () => ({ sendBatch: sendBatchMock }));
vi.mock("../src/steps/redrive-queue.js", () => ({
  redriveQueue: redriveQueueMock,
}));
vi.mock("../src/steps/delete-messages.js", () => ({
  deleteMessages: deleteMessagesMock,
}));
vi.mock("../src/steps/purge-queue.js", () => ({
  purgeQueue: purgeQueueMock,
}));
vi.mock("../src/steps/transform-records.js", () => ({
  transformRecords: transformRecordsMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runSqsEtl } from "../src/steps/run-sqs-etl.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("runSqsEtl dispatch", () => {
  test.each([
    ["dump", dumpQueueMock],
    ["send", sendBatchMock],
    ["redrive", redriveQueueMock],
    ["delete", deleteMessagesMock],
    ["purge", purgeQueueMock],
    ["transform", transformRecordsMock],
  ] as const)(
    "dispatches command '%s' to its matching step, passing deps through unchanged",
    async (command, mock) => {
      const config = buildConfig({ command });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const sqsOperations = createFakeSqsOperations();
      const prompt = new Core.M3LPrompt();

      await runSqsEtl({
        config,
        paths,
        logger,
        correlationId: "run-1",
        sqsOperations,
        prompt,
      });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          paths,
          logger,
          correlationId: "run-1",
          sqsOperations,
          prompt,
        }),
      );

      for (const other of [
        dumpQueueMock,
        sendBatchMock,
        redriveQueueMock,
        deleteMessagesMock,
        purgeQueueMock,
        transformRecordsMock,
      ]) {
        if (other !== mock) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  test("defensively rejects an unrecognized 'command' value with a typed M3LError", async () => {
    const config = buildConfig({ command: "unknown-command" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const sqsOperations = createFakeSqsOperations();
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      await runSqsEtl({
        config,
        paths,
        logger,
        correlationId: "run-2",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
  });
});
