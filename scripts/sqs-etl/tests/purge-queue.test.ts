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

/**
 * A non-sensitive default `awsTarget` fixture — the per-script
 * `(target) => target.profile.toLowerCase().includes("prod")` predicate
 * `purgeQueue` wires into `Core.confirmDestructive` never classifies this
 * profile as sensitive, so every pre-existing (ungraded) test above keeps its
 * current plain yes/no `confirm` behavior once the src change lands.
 */
const nonSensitiveTarget: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

/**
 * Builds a `Core.M3LPrompt` with both `confirm` and `text` spied — the two
 * seams `Core.confirmDestructive` calls through for the ungraded and the
 * escalated typed-echo paths respectively.
 */
function targetGatePrompt(overrides?: {
  readonly confirmed?: boolean;
  readonly textResponse?: string;
}) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi
    .spyOn(prompt, "confirm")
    .mockResolvedValue(overrides?.confirmed ?? true);
  const text = vi
    .spyOn(prompt, "text")
    .mockResolvedValue(overrides?.textResponse ?? "");
  return { prompt, confirm, text };
}

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
      awsTarget: nonSensitiveTarget,
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
      awsTarget: nonSensitiveTarget,
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
        awsTarget: nonSensitiveTarget,
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
        awsTarget: nonSensitiveTarget,
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
        awsTarget: nonSensitiveTarget,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LSQSOperationError);
  });

  test("throws ERR_SQS_ETL_CONFIG when 'yes' is stored as a non-boolean (required-variant wrong-type rejection)", async () => {
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      yes: "yep",
    });
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const logger = new Core.M3LLogger([]);

    await expect(
      purgeQueue({
        config,
        logger,
        correlationId: "run-6",
        sqsOperations,
        prompt,
        awsTarget: nonSensitiveTarget,
      }),
    ).rejects.toMatchObject({ code: "ERR_SQS_ETL_CONFIG" });
    expect(confirm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.purgeQueue).not.toHaveBeenCalled();
  });

  /**
   * Contract: ADR-0048's target-graded destructive-confirmation gate (Issue
   * #483, A2b), wired into `purgeQueue`'s existing `Core.confirmDestructive`
   * call via a per-script `awsTarget: Core.M3LDestructiveTarget` dep and an
   * inline `isSensitiveTarget` predicate,
   * `(target) => target.profile.toLowerCase().includes("prod")`.
   */
  describe("target-graded escalation", () => {
    test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
      const sqsOperations = createFakeSqsOperations();
      const config = buildConfig({
        queueUrl: "https://sqs.example/q",
        yes: false,
      });
      const logger = new Core.M3LLogger([]);
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });

      await purgeQueue({
        config,
        logger,
        correlationId: "run-escalate",
        sqsOperations,
        prompt,
        awsTarget: { profile: "prod" },
      });

      expect(text).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
        "https://sqs.example/q",
      );
    });

    test("throws ERR_SQS_ETL_ABORTED when the typed-echo input doesn't match the profile", async () => {
      const sqsOperations = createFakeSqsOperations();
      const config = buildConfig({
        queueUrl: "https://sqs.example/q",
        yes: false,
      });
      const logger = new Core.M3LLogger([]);
      const { prompt } = targetGatePrompt({ textResponse: "not-prod" });

      let thrown: unknown;
      try {
        await purgeQueue({
          config,
          logger,
          correlationId: "run-escalate-mismatch",
          sqsOperations,
          prompt,
          awsTarget: { profile: "prod" },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.purgeQueue).not.toHaveBeenCalled();
    });

    test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
      const sqsOperations = createFakeSqsOperations();
      const config = buildConfig({
        queueUrl: "https://sqs.example/q",
        yes: true,
        yesSensitive: true,
      });
      const logger = new Core.M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });

      await purgeQueue({
        config,
        logger,
        correlationId: "run-bypass-sensitive",
        sqsOperations,
        prompt,
        awsTarget: { profile: "prod" },
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
        "https://sqs.example/q",
      );
    });

    test.each([
      ["absent", undefined],
      ["false", false],
    ])(
      "still escalates when yes:true but yesSensitive is %s, for a sensitive target",
      async (_label, yesSensitiveValue) => {
        const sqsOperations = createFakeSqsOperations();
        const configValues: Record<string, unknown> = {
          queueUrl: "https://sqs.example/q",
          yes: true,
        };
        if (yesSensitiveValue !== undefined) {
          configValues["yesSensitive"] = yesSensitiveValue;
        }
        const config = buildConfig(configValues);
        const logger = new Core.M3LLogger([]);
        const { prompt, confirm, text } = targetGatePrompt({
          textResponse: "prod",
        });

        await purgeQueue({
          config,
          logger,
          correlationId: "run-still-escalates",
          sqsOperations,
          prompt,
          awsTarget: { profile: "prod" },
        });

        expect(text).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
        expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
          "https://sqs.example/q",
        );
      },
    );

    test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
      const sqsOperations = createFakeSqsOperations();
      const config = buildConfig({
        queueUrl: "https://sqs.example/q",
        yes: false,
      });
      const logger = new Core.M3LLogger([]);
      const { prompt, confirm, text } = targetGatePrompt({ confirmed: true });

      await purgeQueue({
        config,
        logger,
        correlationId: "run-not-sensitive",
        sqsOperations,
        prompt,
        awsTarget: { profile: "dev-sandbox" },
      });

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.purgeQueue).toHaveBeenCalledWith(
        "https://sqs.example/q",
      );
    });
  });
});
