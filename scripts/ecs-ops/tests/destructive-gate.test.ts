import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { destructiveGate } from "../src/steps/destructive-gate.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `destructive-gate` row —
 * "mirrors `lambda-ops`'s" shared confirmation step exactly. Calls
 * `prompt.confirm(description)` unless `yes` is true (bypass logged as a
 * warning); throws `Core.M3LError({ code: "ERR_ECS_OPS_ABORTED" })` on
 * decline; resolves (no return value) on confirm or bypass.
 */

describe("destructiveGate", () => {
  test("prompts via prompt.confirm(description) and resolves when confirmed", async () => {
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const logger = new Core.M3LLogger([]);

    await expect(
      destructiveGate({
        prompt,
        logger,
        description: "delete-service cluster 'my-cluster' service 'my-svc'",
        yes: false,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("my-cluster");
  });

  test("throws Core.M3LError code ERR_ECS_OPS_ABORTED when the user declines", async () => {
    const prompt = new Core.M3LPrompt();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await destructiveGate({
        prompt,
        logger,
        description: "delete-service cluster 'my-cluster' service 'my-svc'",
        yes: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ECS_OPS_ABORTED");
  });

  test("yes=true bypasses the prompt entirely and logs the bypass", async () => {
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(false);
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");

    await expect(
      destructiveGate({
        prompt,
        logger,
        description: "create-service serviceName 'my-svc'",
        yes: true,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toMatch(/bypass/i);
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
