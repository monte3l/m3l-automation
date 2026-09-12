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

/**
 * A non-sensitive default `awsTarget` fixture — the per-script
 * `(target) => target.profile.toLowerCase().includes("prod")` predicate
 * `deleteMessages` wires into `Core.confirmDestructive` never classifies this
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
      reportRecovery: vi.fn(),
      awsTarget: nonSensitiveTarget,
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
      reportRecovery: vi.fn(),
      awsTarget: nonSensitiveTarget,
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
      reportRecovery: vi.fn(),
      awsTarget: nonSensitiveTarget,
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
        reportRecovery: vi.fn(),
        awsTarget: nonSensitiveTarget,
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
    const reportRecovery = vi.fn();

    await deleteMessages({
      config,
      paths,
      logger,
      correlationId: "run-5",
      sqsOperations,
      prompt,
      reportRecovery,
      awsTarget: nonSensitiveTarget,
    });

    const failedStream = streams.find((stream) =>
      stream.content().includes("rh2"),
    );
    expect(failedStream).toBeDefined();
    if (failedStream !== undefined) {
      expect(writtenJsonlRecords(failedStream)).toEqual([failedEntry]);
    }

    // item is the delete-entry's receiptHandle, not the chunk-scoped id.
    expect(reportRecovery).toHaveBeenCalledWith({
      item: "rh2",
      error: [
        expect.objectContaining({ name: "M3LError", message: "InternalError" }),
      ],
      recordedAt: expect.any(String) as string,
    });
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
        reportRecovery: vi.fn(),
        awsTarget: nonSensitiveTarget,
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
          reportRecovery: vi.fn(),
          awsTarget: nonSensitiveTarget,
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

  test("throws ERR_SQS_ETL_CONFIG when 'batchSize' is stored as a non-number (required-variant wrong-type rejection)", async () => {
    stubInput("");
    stubOutputStreams();
    const sqsOperations = createFakeSqsOperations();
    const config = buildConfig({
      queueUrl: "https://sqs.example/q",
      input: "in.jsonl",
      yes: true,
      batchSize: "one-hundred",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");

    await expect(
      deleteMessages({
        config,
        paths,
        logger,
        correlationId: "run-batchsize-wrong-type",
        sqsOperations,
        prompt,
        reportRecovery: vi.fn(),
        awsTarget: nonSensitiveTarget,
      }),
    ).rejects.toMatchObject({ code: "ERR_SQS_ETL_CONFIG" });
    expect(confirm).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqsOperations.deleteBatch).not.toHaveBeenCalled();
  });

  /**
   * Contract: ADR-0048's target-graded destructive-confirmation gate (Issue
   * #483, A2b), wired into `deleteMessages`'s existing `Core.confirmDestructive`
   * call via a per-script `awsTarget: Core.M3LDestructiveTarget` dep and an
   * inline `isSensitiveTarget` predicate,
   * `(target) => target.profile.toLowerCase().includes("prod")`.
   */
  describe("target-graded escalation", () => {
    test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
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
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });

      await deleteMessages({
        config,
        paths,
        logger,
        correlationId: "run-escalate",
        sqsOperations,
        prompt,
        reportRecovery: vi.fn(),
        awsTarget: { profile: "prod" },
      });

      expect(text).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
    });

    test("throws ERR_SQS_ETL_ABORTED when the typed-echo input doesn't match the profile", async () => {
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
      const { prompt } = targetGatePrompt({ textResponse: "not-prod" });

      let thrown: unknown;
      try {
        await deleteMessages({
          config,
          paths,
          logger,
          correlationId: "run-escalate-mismatch",
          sqsOperations,
          prompt,
          reportRecovery: vi.fn(),
          awsTarget: { profile: "prod" },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_ABORTED");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.deleteBatch).not.toHaveBeenCalled();
    });

    test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
      stubInput(JSON.stringify({ receiptHandle: "rh1" }));
      stubOutputStreams();
      const sqsOperations = createFakeSqsOperations();
      const config = buildConfig({
        queueUrl: "https://sqs.example/q",
        input: "in.jsonl",
        yes: true,
        yesSensitive: true,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });

      await deleteMessages({
        config,
        paths,
        logger,
        correlationId: "run-bypass-sensitive",
        sqsOperations,
        prompt,
        reportRecovery: vi.fn(),
        awsTarget: { profile: "prod" },
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["absent", undefined],
      ["false", false],
    ])(
      "still escalates when yes:true but yesSensitive is %s, for a sensitive target",
      async (_label, yesSensitiveValue) => {
        stubInput(JSON.stringify({ receiptHandle: "rh1" }));
        stubOutputStreams();
        const sqsOperations = createFakeSqsOperations();
        const configValues: Record<string, unknown> = {
          queueUrl: "https://sqs.example/q",
          input: "in.jsonl",
          yes: true,
        };
        if (yesSensitiveValue !== undefined) {
          configValues["yesSensitive"] = yesSensitiveValue;
        }
        const config = buildConfig(configValues);
        const paths = new Core.M3LPaths();
        const logger = new Core.M3LLogger([]);
        const { prompt, confirm, text } = targetGatePrompt({
          textResponse: "prod",
        });

        await deleteMessages({
          config,
          paths,
          logger,
          correlationId: "run-still-escalates",
          sqsOperations,
          prompt,
          reportRecovery: vi.fn(),
          awsTarget: { profile: "prod" },
        });

        expect(text).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
        expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
      },
    );

    test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
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
      const { prompt, confirm, text } = targetGatePrompt({ confirmed: true });

      await deleteMessages({
        config,
        paths,
        logger,
        correlationId: "run-not-sensitive",
        sqsOperations,
        prompt,
        reportRecovery: vi.fn(),
        awsTarget: { profile: "dev-sandbox" },
      });

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
      expect(sqsOperations.deleteBatch).toHaveBeenCalledTimes(1);
    });
  });
});
