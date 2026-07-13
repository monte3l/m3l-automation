import { describe, expect, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { purgeQueue } from "../src/steps/purge-queue.js";
import { buildConfig, createFakeSqsOperations } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `purge-queue` row +
 * design decision #8/#10. Calls `sqsOperations.purgeQueue(queueUrl)`;
 * confirm-gated (bypassed by `yes`); a `PurgeQueueInProgress` cooldown
 * rejection surfaces as the typed `M3LSQSOperationError` the library already
 * throws, not retried.
 */

describe("purgeQueue", () => {
  test("yes=true bypasses the prompt and purges the queue", async () => {
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      yes: true,
    });
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const logger = new Core.M3LLogger([]);

    await purgeQueue({
      config,
      logger,
      correlationId: "run-1",
      sqsOperations,
      prompt,
    });

    expect(confirm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
      "https://sqs.example/q",
    );
  });

  test("yes=false prompts for confirmation before purging", async () => {
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      yes: false,
    });
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const logger = new Core.M3LLogger([]);

    await purgeQueue({
      config,
      logger,
      correlationId: "run-2",
      sqsOperations,
      prompt,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
      "https://sqs.example/q",
    );
  });

  test("a declined confirmation aborts before purging", async () => {
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      yes: false,
    });
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await purgeQueue({
        config,
        logger,
        correlationId: "run-3",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.purgeQueue).not.toHaveBeenCalled();
  });

  test("throws ERR_SQS_ETL_CONFIG when 'queueUrl' is missing, never calling the prompt or SQS", async () => {
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({ yes: true });
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await purgeQueue({
        config,
        logger,
        correlationId: "run-4",
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
    expect(sqsOperations.purgeQueue).not.toHaveBeenCalled();
  });

  test("a PurgeQueueInProgress cooldown rejection propagates as the typed M3LSQSOperationError", async () => {
    const cooldownError = new AWS.M3LSQSOperationError(
      "purgeQueue: PurgeQueue failed for queueUrl=https://sqs.example/q",
      { cause: new Error("PurgeQueueInProgress") },
    );
    const sqsOperations = createFakeSqsOperations({
      purgeQueue: vi.fn().mockRejectedValue(cooldownError),
    });
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      yes: true,
    });
    const prompt = new Core.M3LPrompt();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await purgeQueue({
        config,
        logger,
        correlationId: "run-5",
        sqsOperations,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LSQSOperationError);
  });
});
