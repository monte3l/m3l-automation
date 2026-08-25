import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { waitNodegroup } from "../src/steps/wait-nodegroup.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/wait-nodegroup.ts` — `wait-nodegroup-active`
 * (`waitUntilNodegroupActive(cluster, nodegroup, { maxWaitTime })`) and
 * `wait-nodegroup-deleted`
 * (`waitUntilNodegroupDeleted(cluster, nodegroup, { maxWaitTime })`). Same
 * pass-through contract as `wait-cluster`: the `M3LEKSWaiterResult` is
 * returned UNCHANGED regardless of `state`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("waitNodegroup — wait-nodegroup-active", () => {
  test("calls waitUntilNodegroupActive(cluster, nodegroup, { maxWaitTime })", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilNodegroupActive = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilNodegroupActive });

    const returned = await waitNodegroup({
      operations,
      operation: "wait-nodegroup-active",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      maxWaitTime: 600,
    });

    expect(waitUntilNodegroupActive).toHaveBeenCalledWith(
      "my-cluster",
      "my-nodegroup",
      { maxWaitTime: 600 },
    );
    expect(returned).toEqual(result);
  });
});

describe("waitNodegroup — wait-nodegroup-deleted", () => {
  test("calls waitUntilNodegroupDeleted(cluster, nodegroup, { maxWaitTime })", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilNodegroupDeleted = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilNodegroupDeleted });

    const returned = await waitNodegroup({
      operations,
      operation: "wait-nodegroup-deleted",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      maxWaitTime: 1200,
    });

    expect(waitUntilNodegroupDeleted).toHaveBeenCalledWith(
      "my-cluster",
      "my-nodegroup",
      { maxWaitTime: 1200 },
    );
    expect(returned).toEqual(result);
  });
});

describe("waitNodegroup — returns every terminal state unchanged, never throwing or inspecting state", () => {
  test.each(["SUCCESS", "TIMEOUT", "ABORTED"] as const)(
    "returns state '%s' unchanged, without throwing",
    async (state) => {
      const result: AWS.M3LEKSWaiterResult = {
        state,
        ...(state !== "SUCCESS" && { reason: `waiter ${state.toLowerCase()}` }),
      };
      const waitUntilNodegroupActive = vi.fn().mockResolvedValue(result);
      const operations = createFakeEKSOperations({
        waitUntilNodegroupActive,
      });

      const returned = await waitNodegroup({
        operations,
        operation: "wait-nodegroup-active",
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        maxWaitTime: 600,
      });

      expect(returned).toEqual(result);
    },
  );
});

describe("waitNodegroup — signal forwarding", () => {
  test("forwards deps.signal into the waiter options when supplied", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilNodegroupActive = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilNodegroupActive });
    const controller = new AbortController();

    await waitNodegroup({
      operations,
      operation: "wait-nodegroup-active",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      maxWaitTime: 600,
      signal: controller.signal,
    });

    expect(waitUntilNodegroupActive).toHaveBeenCalledWith(
      "my-cluster",
      "my-nodegroup",
      { maxWaitTime: 600, signal: controller.signal },
    );
  });

  test("omits the signal key from the waiter options when not supplied", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilNodegroupActive = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilNodegroupActive });

    await waitNodegroup({
      operations,
      operation: "wait-nodegroup-active",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      maxWaitTime: 600,
    });

    const [, , options] = waitUntilNodegroupActive.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ maxWaitTime: 600 });
    expect(Object.hasOwn(options, "signal")).toBe(false);
  });
});

describe("type contract", () => {
  test("waitNodegroup resolves M3LEKSWaiterResult", () => {
    expectTypeOf(
      waitNodegroup,
    ).returns.resolves.toEqualTypeOf<AWS.M3LEKSWaiterResult>();
  });
});
