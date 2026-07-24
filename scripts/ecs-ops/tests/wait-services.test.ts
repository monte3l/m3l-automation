import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { waitServices } from "../src/steps/wait-services.js";
import { createFakeEcsOperations } from "./support/ecsFakes.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `wait-services` row —
 * `wait-services-stable`: calls
 * `waitUntilServicesStable(cluster, services, { maxWaitTime })` and returns
 * the `M3LECSWaiterResult` unchanged. It does NOT itself inspect or throw on
 * a non-`SUCCESS` state — that is `run-ecs-ops`'s decision, once the result
 * has flowed back to the dispatcher — so this file must NOT assert a throw
 * here for TIMEOUT/ABORTED.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("waitServices", () => {
  test("calls waitUntilServicesStable(cluster, services, { maxWaitTime }) when maxWaitTime is set", async () => {
    const result: AWS.M3LECSWaiterResult = { state: "SUCCESS" };
    const waitUntilServicesStable = vi.fn().mockResolvedValue(result);
    const operations = createFakeEcsOperations({ waitUntilServicesStable });

    const returned = await waitServices({
      operations,
      cluster: "my-cluster",
      services: ["svc-a", "svc-b"],
      maxWaitTime: 120,
    });

    expect(waitUntilServicesStable).toHaveBeenCalledWith(
      "my-cluster",
      ["svc-a", "svc-b"],
      { maxWaitTime: 120 },
    );
    expect(returned).toEqual(result);
  });

  test("omits maxWaitTime from the options object when unset (conditional spread, exactOptionalPropertyTypes-safe)", async () => {
    const waitUntilServicesStable = vi
      .fn()
      .mockResolvedValue({ state: "SUCCESS" });
    const operations = createFakeEcsOperations({ waitUntilServicesStable });

    await waitServices({
      operations,
      cluster: "my-cluster",
      services: ["svc-a"],
      maxWaitTime: undefined,
    });

    const call = waitUntilServicesStable.mock.calls[0] as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];
    expect(call[2]).not.toHaveProperty("maxWaitTime");
  });

  test.each(["TIMEOUT", "ABORTED"] as const)(
    "returns a non-SUCCESS '%s' result unchanged, without throwing",
    async (state) => {
      const result: AWS.M3LECSWaiterResult = { state, reason: "boom" };
      const waitUntilServicesStable = vi.fn().mockResolvedValue(result);
      const operations = createFakeEcsOperations({ waitUntilServicesStable });

      const returned = await waitServices({
        operations,
        cluster: "my-cluster",
        services: ["svc-a"],
        maxWaitTime: undefined,
      });

      expect(returned).toEqual(result);
    },
  );

  test("propagates a rejection from waitUntilServicesStable unchanged", async () => {
    const cause = new Error("DescribeServices polling failed");
    const waitUntilServicesStable = vi.fn().mockRejectedValue(cause);
    const operations = createFakeEcsOperations({ waitUntilServicesStable });

    await expect(
      waitServices({
        operations,
        cluster: "my-cluster",
        services: ["svc-a"],
        maxWaitTime: undefined,
      }),
    ).rejects.toBe(cause);
  });
});

describe("type contract", () => {
  test("waitServices resolves M3LECSWaiterResult", () => {
    expectTypeOf(
      waitServices,
    ).returns.resolves.toEqualTypeOf<AWS.M3LECSWaiterResult>();
  });

  test("waitServices's deps shape is exactly operations/cluster/services/maxWaitTime", () => {
    expectTypeOf<Parameters<typeof waitServices>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LECSOperations;
      readonly cluster: string;
      readonly services: readonly string[];
      readonly maxWaitTime: number | undefined;
    }>();
  });
});
