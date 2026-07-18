import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { destructiveGate } from "../../src/steps/destructive-gate.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md, `destructive-gate` row +
 * Behavioral contract's "Destructive-gate decline soft-lands" bullet. Shared
 * confirm-gate for `put`/`copy`/`delete`/`delete-batch`: prompts via
 * `script.prompt.confirm(description)` unless `yes` is `true`, in which case
 * the bypass is logged as a warning — "fleet convention from sqs-etl"
 * (mirrors scripts/sqs-etl/src/steps/destructive-gate.ts and its test file
 * exactly, per the task instructions).
 */

describe("destructiveGate", () => {
  test("yes: true bypasses the prompt entirely and logs the bypass as a warning", async () => {
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    await expect(
      destructiveGate({
        prompt,
        logger,
        description: "delete object reports/2026/07/summary.json",
        yes: true,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toMatch(/bypass/i);
  });

  test("yes: false, prompt confirms true, resolves without throwing", async () => {
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const logger = new Core.M3LLogger([]);

    await expect(
      destructiveGate({
        prompt,
        logger,
        description: "put object reports/2026/07/summary.json",
        yes: false,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain(
      "put object reports/2026/07/summary.json",
    );
  });

  test("yes: false, prompt confirms false, throws Core.M3LError coded ERR_S3_OBJECTS_ABORTED", async () => {
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await destructiveGate({
        prompt,
        logger,
        description: "delete-batch 1500 keys in reports",
        yes: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_S3_OBJECTS_ABORTED");
  });

  test("injected-deps parameter shape", () => {
    expectTypeOf(destructiveGate).parameter(0).toMatchTypeOf<{
      readonly prompt: Core.M3LPrompt;
      readonly logger: Core.M3LLogger;
      readonly description: string;
      readonly yes: boolean;
    }>();
    expectTypeOf(destructiveGate).returns.toMatchTypeOf<Promise<void>>();
  });
});
