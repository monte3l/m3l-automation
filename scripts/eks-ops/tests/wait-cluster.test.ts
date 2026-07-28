import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { waitCluster } from "../src/steps/wait-cluster.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/wait-cluster.ts` — `wait-cluster-active`
 * (`waitUntilClusterActive(cluster, { maxWaitTime })`) and
 * `wait-cluster-deleted` (`waitUntilClusterDeleted(cluster, { maxWaitTime })`).
 * Returns the `M3LEKSWaiterResult` UNCHANGED regardless of `state` — this
 * step never throws or inspects `state`; that decision belongs to
 * `run-eks-ops` (per `docs/reference/scripts/eks-ops.md`).
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("waitCluster — wait-cluster-active", () => {
  test("calls waitUntilClusterActive(cluster, { maxWaitTime })", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilClusterActive = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilClusterActive });

    const returned = await waitCluster({
      operations,
      operation: "wait-cluster-active",
      cluster: "my-cluster",
      maxWaitTime: 600,
    });

    expect(waitUntilClusterActive).toHaveBeenCalledWith("my-cluster", {
      maxWaitTime: 600,
    });
    expect(returned).toEqual(result);
  });
});

describe("waitCluster — wait-cluster-deleted", () => {
  test("calls waitUntilClusterDeleted(cluster, { maxWaitTime })", async () => {
    const result: AWS.M3LEKSWaiterResult = { state: "SUCCESS" };
    const waitUntilClusterDeleted = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ waitUntilClusterDeleted });

    const returned = await waitCluster({
      operations,
      operation: "wait-cluster-deleted",
      cluster: "my-cluster",
      maxWaitTime: 1200,
    });

    expect(waitUntilClusterDeleted).toHaveBeenCalledWith("my-cluster", {
      maxWaitTime: 1200,
    });
    expect(returned).toEqual(result);
  });
});

describe("waitCluster — returns every terminal state unchanged, never throwing or inspecting state", () => {
  test.each(["SUCCESS", "TIMEOUT", "ABORTED"] as const)(
    "returns state '%s' unchanged, without throwing",
    async (state) => {
      const result: AWS.M3LEKSWaiterResult = {
        state,
        ...(state !== "SUCCESS" && { reason: `waiter ${state.toLowerCase()}` }),
      };
      const waitUntilClusterActive = vi.fn().mockResolvedValue(result);
      const operations = createFakeEKSOperations({ waitUntilClusterActive });

      const returned = await waitCluster({
        operations,
        operation: "wait-cluster-active",
        cluster: "my-cluster",
        maxWaitTime: 600,
      });

      expect(returned).toEqual(result);
    },
  );
});

describe("type contract", () => {
  test("waitCluster resolves M3LEKSWaiterResult", () => {
    expectTypeOf(
      waitCluster,
    ).returns.resolves.toEqualTypeOf<AWS.M3LEKSWaiterResult>();
  });
});
