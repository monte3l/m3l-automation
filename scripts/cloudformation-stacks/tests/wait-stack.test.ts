import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { waitStack } from "../src/steps/wait-stack.js";
import { createFakeCloudFormationOperations } from "./support/cloudformationFakes.js";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md `wait-stack`
 * row — the three `wait-stack-*-complete` operations, a pure passthrough
 * to the matching waiter method (`waitUntilStackCreateComplete`/
 * `UpdateComplete`/`DeleteComplete(stackName, { maxWaitTime })`), returning
 * the `M3LCloudFormationWaiterResult` unchanged. It does NOT itself inspect
 * or throw on a non-`SUCCESS` state — that is `run-cloudformation-stacks`'s
 * decision, once the result has flowed back to the dispatcher — so this
 * file must NOT assert a throw here for TIMEOUT/ABORTED.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("waitStack — wait-stack-create-complete", () => {
  test("calls waitUntilStackCreateComplete(stackName, { maxWaitTime }) when maxWaitTime is set", async () => {
    const result: AWS.M3LCloudFormationWaiterResult = { state: "SUCCESS" };
    const waitUntilStackCreateComplete = vi.fn().mockResolvedValue(result);
    const operations = createFakeCloudFormationOperations({
      waitUntilStackCreateComplete,
    });

    const returned = await waitStack({
      operations,
      operation: "wait-stack-create-complete",
      stackName: "my-stack",
      maxWaitTime: 120,
    });

    expect(waitUntilStackCreateComplete).toHaveBeenCalledWith("my-stack", {
      maxWaitTime: 120,
    });
    expect(returned).toEqual(result);
  });
});

describe("waitStack — wait-stack-update-complete", () => {
  test("calls waitUntilStackUpdateComplete(stackName, { maxWaitTime })", async () => {
    const result: AWS.M3LCloudFormationWaiterResult = { state: "SUCCESS" };
    const waitUntilStackUpdateComplete = vi.fn().mockResolvedValue(result);
    const operations = createFakeCloudFormationOperations({
      waitUntilStackUpdateComplete,
    });

    const returned = await waitStack({
      operations,
      operation: "wait-stack-update-complete",
      stackName: "my-stack",
      maxWaitTime: undefined,
    });

    expect(waitUntilStackUpdateComplete).toHaveBeenCalledWith(
      "my-stack",
      expect.anything(),
    );
    expect(returned).toEqual(result);
  });

  test("omits maxWaitTime from the options object when unset", async () => {
    const waitUntilStackUpdateComplete = vi
      .fn()
      .mockResolvedValue({ state: "SUCCESS" });
    const operations = createFakeCloudFormationOperations({
      waitUntilStackUpdateComplete,
    });

    await waitStack({
      operations,
      operation: "wait-stack-update-complete",
      stackName: "my-stack",
      maxWaitTime: undefined,
    });

    const call = waitUntilStackUpdateComplete.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).not.toHaveProperty("maxWaitTime");
  });
});

describe("waitStack — wait-stack-delete-complete", () => {
  test("calls waitUntilStackDeleteComplete(stackName, { maxWaitTime })", async () => {
    const result: AWS.M3LCloudFormationWaiterResult = { state: "SUCCESS" };
    const waitUntilStackDeleteComplete = vi.fn().mockResolvedValue(result);
    const operations = createFakeCloudFormationOperations({
      waitUntilStackDeleteComplete,
    });

    const returned = await waitStack({
      operations,
      operation: "wait-stack-delete-complete",
      stackName: "my-stack",
      maxWaitTime: 60,
    });

    expect(waitUntilStackDeleteComplete).toHaveBeenCalledWith("my-stack", {
      maxWaitTime: 60,
    });
    expect(returned).toEqual(result);
  });
});

describe("waitStack — passthrough of non-SUCCESS states (no inspection/throw here)", () => {
  test.each(["TIMEOUT", "ABORTED"] as const)(
    "returns a non-SUCCESS '%s' result unchanged, without throwing",
    async (state) => {
      const result: AWS.M3LCloudFormationWaiterResult = {
        state,
        reason: "boom",
      };
      const waitUntilStackCreateComplete = vi.fn().mockResolvedValue(result);
      const operations = createFakeCloudFormationOperations({
        waitUntilStackCreateComplete,
      });

      const returned = await waitStack({
        operations,
        operation: "wait-stack-create-complete",
        stackName: "my-stack",
        maxWaitTime: undefined,
      });

      expect(returned).toEqual(result);
    },
  );

  test("propagates a rejection from the waiter method unchanged", async () => {
    const cause = new Error("waiter polling failed");
    const waitUntilStackCreateComplete = vi.fn().mockRejectedValue(cause);
    const operations = createFakeCloudFormationOperations({
      waitUntilStackCreateComplete,
    });

    await expect(
      waitStack({
        operations,
        operation: "wait-stack-create-complete",
        stackName: "my-stack",
        maxWaitTime: undefined,
      }),
    ).rejects.toBe(cause);
  });
});

describe("type contract", () => {
  test("waitStack resolves M3LCloudFormationWaiterResult", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof waitStack>>
    >().toEqualTypeOf<AWS.M3LCloudFormationWaiterResult>();
  });

  test("waitStack's deps shape is exactly operations/operation/stackName/maxWaitTime/signal", () => {
    expectTypeOf<Parameters<typeof waitStack>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCloudFormationOperations;
      readonly operation:
        | "wait-stack-create-complete"
        | "wait-stack-update-complete"
        | "wait-stack-delete-complete";
      readonly stackName: string;
      readonly maxWaitTime: number | undefined;
      readonly signal?: AbortSignal;
    }>();
  });
});

describe("waitStack — signal forwarding (ADR-0049 cooperative cancellation)", () => {
  test("forwards deps.signal into the waiter options when supplied", async () => {
    const controller = new AbortController();
    const waitUntilStackCreateComplete = vi
      .fn()
      .mockResolvedValue({ state: "SUCCESS" });
    const operations = createFakeCloudFormationOperations({
      waitUntilStackCreateComplete,
    });

    await waitStack({
      operations,
      operation: "wait-stack-create-complete",
      stackName: "my-stack",
      maxWaitTime: undefined,
      signal: controller.signal,
    });

    const call = waitUntilStackCreateComplete.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(call[1]["signal"]).toBe(controller.signal);
  });

  test("omits the signal key from the options object when deps.signal is not supplied", async () => {
    const waitUntilStackCreateComplete = vi
      .fn()
      .mockResolvedValue({ state: "SUCCESS" });
    const operations = createFakeCloudFormationOperations({
      waitUntilStackCreateComplete,
    });

    await waitStack({
      operations,
      operation: "wait-stack-create-complete",
      stackName: "my-stack",
      maxWaitTime: undefined,
    });

    const call = waitUntilStackCreateComplete.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).not.toHaveProperty("signal");
  });
});
