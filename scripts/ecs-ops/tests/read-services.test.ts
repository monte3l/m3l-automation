import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readServices } from "../src/steps/read-services.js";
import { createFakeEcsOperations } from "./support/ecsFakes.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `read-services` row —
 * `list-services` (`listServices({ cluster, nextToken })`) and
 * `describe-service` (`describeService(cluster, service)`), never gated (no
 * `prompt`/`destructive-gate` dependency at all — the deps shape below
 * structurally cannot reach either). Deps arrive already
 * guard-checked/resolved by `run-ecs-ops` — this step takes no raw
 * `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readServices — list-services", () => {
  test("calls operations.listServices({ cluster, nextToken }) and returns the result unchanged", async () => {
    const result: AWS.M3LECSListServicesResult = {
      serviceArns: ["arn:aws:ecs:us-east-1:123:service/my-cluster/svc-a"],
      nextToken: "next-token",
    };
    const listServices = vi.fn().mockResolvedValue(result);
    const operations = createFakeEcsOperations({ listServices });

    const returned = await readServices({
      operations,
      operation: "list-services",
      cluster: "my-cluster",
      service: undefined,
      nextToken: "prev-token",
    });

    expect(listServices).toHaveBeenCalledTimes(1);
    const call = listServices.mock.calls[0] as [
      { cluster?: string; nextToken?: string }?,
    ];
    expect(call[0]?.cluster).toBe("my-cluster");
    expect(call[0]?.nextToken).toBe("prev-token");
    expect(returned).toEqual(result);
  });

  test("omits cluster/nextToken from the call when unset", async () => {
    const listServices = vi.fn().mockResolvedValue({ serviceArns: [] });
    const operations = createFakeEcsOperations({ listServices });

    await readServices({
      operations,
      operation: "list-services",
      cluster: undefined,
      service: undefined,
      nextToken: undefined,
    });

    const call = listServices.mock.calls[0] as [
      { cluster?: string; nextToken?: string }?,
    ];
    expect(call[0]?.cluster).toBeUndefined();
    expect(call[0]?.nextToken).toBeUndefined();
  });
});

describe("readServices — describe-service", () => {
  test("calls operations.describeService(cluster, service) and returns the description unchanged", async () => {
    const description: AWS.M3LECSServiceDescription = {
      serviceArn: "arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc",
      serviceName: "my-svc",
      clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
      status: "ACTIVE",
      desiredCount: 2,
      runningCount: 2,
      pendingCount: 0,
    };
    const describeService = vi.fn().mockResolvedValue(description);
    const operations = createFakeEcsOperations({ describeService });

    const returned = await readServices({
      operations,
      operation: "describe-service",
      cluster: "my-cluster",
      service: "my-svc",
      nextToken: undefined,
    });

    expect(describeService).toHaveBeenCalledWith("my-cluster", "my-svc");
    expect(returned).toEqual(description);
  });

  test("throws ERR_ECS_OPS_CONFIG when cluster is undefined, never calling describeService", async () => {
    const describeService = vi.fn();
    const operations = createFakeEcsOperations({ describeService });

    let thrown: unknown;
    try {
      await readServices({
        operations,
        operation: "describe-service",
        cluster: undefined,
        service: "my-svc",
        nextToken: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ECS_OPS_CONFIG");
    expect(describeService).not.toHaveBeenCalled();
  });

  test("throws ERR_ECS_OPS_CONFIG when service is undefined, never calling describeService", async () => {
    const describeService = vi.fn();
    const operations = createFakeEcsOperations({ describeService });

    await expect(
      readServices({
        operations,
        operation: "describe-service",
        cluster: "my-cluster",
        service: undefined,
        nextToken: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_ECS_OPS_CONFIG" });
    expect(describeService).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readServices resolves the list-or-describe result union", () => {
    expectTypeOf(readServices).returns.resolves.toEqualTypeOf<
      AWS.M3LECSListServicesResult | AWS.M3LECSServiceDescription
    >();
  });

  test("readServices's deps shape is exactly operations/operation/cluster/service/nextToken — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readServices>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LECSOperations;
      readonly operation: "list-services" | "describe-service";
      readonly cluster: string | undefined;
      readonly service: string | undefined;
      readonly nextToken: string | undefined;
    }>();
  });
});
