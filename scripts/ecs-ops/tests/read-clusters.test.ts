import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readClusters } from "../src/steps/read-clusters.js";
import { createFakeEcsOperations } from "./support/ecsFakes.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `read-clusters` row —
 * `list-clusters` (`listClusters({ nextToken })`) and `describe-cluster`
 * (`describeCluster(cluster)`), never gated, read-only context. Deps arrive
 * already guard-checked/resolved by `run-ecs-ops` — this step takes no raw
 * `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readClusters — list-clusters", () => {
  test("calls operations.listClusters({ nextToken }) and returns the result unchanged", async () => {
    const result: AWS.M3LECSListClustersResult = {
      clusterArns: ["arn:aws:ecs:us-east-1:123:cluster/my-cluster"],
      nextToken: "next-token",
    };
    const listClusters = vi.fn().mockResolvedValue(result);
    const operations = createFakeEcsOperations({ listClusters });

    const returned = await readClusters({
      operations,
      operation: "list-clusters",
      cluster: undefined,
      nextToken: "prev-token",
    });

    expect(listClusters).toHaveBeenCalledTimes(1);
    const call = listClusters.mock.calls[0] as [{ nextToken?: string }?];
    expect(call[0]?.nextToken).toBe("prev-token");
    expect(returned).toEqual(result);
  });

  test("omits nextToken from the call when unset", async () => {
    const listClusters = vi.fn().mockResolvedValue({ clusterArns: [] });
    const operations = createFakeEcsOperations({ listClusters });

    await readClusters({
      operations,
      operation: "list-clusters",
      cluster: undefined,
      nextToken: undefined,
    });

    const call = listClusters.mock.calls[0] as [{ nextToken?: string }?];
    expect(call[0]?.nextToken).toBeUndefined();
  });
});

describe("readClusters — describe-cluster", () => {
  test("calls operations.describeCluster(cluster) and returns the summary unchanged", async () => {
    const summary: AWS.M3LECSClusterSummary = {
      clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
      clusterName: "my-cluster",
      status: "ACTIVE",
    };
    const describeCluster = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEcsOperations({ describeCluster });

    const returned = await readClusters({
      operations,
      operation: "describe-cluster",
      cluster: "my-cluster",
      nextToken: undefined,
    });

    expect(describeCluster).toHaveBeenCalledWith("my-cluster");
    expect(returned).toEqual(summary);
  });

  test("throws ERR_ECS_OPS_CONFIG when cluster is undefined, never calling describeCluster", async () => {
    const describeCluster = vi.fn();
    const operations = createFakeEcsOperations({ describeCluster });

    let thrown: unknown;
    try {
      await readClusters({
        operations,
        operation: "describe-cluster",
        cluster: undefined,
        nextToken: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ECS_OPS_CONFIG");
    expect(describeCluster).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readClusters resolves the list-or-describe result union", () => {
    expectTypeOf(readClusters).returns.resolves.toEqualTypeOf<
      AWS.M3LECSListClustersResult | AWS.M3LECSClusterSummary
    >();
  });

  test("readClusters's deps shape is exactly operations/operation/cluster/nextToken — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readClusters>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LECSOperations;
      readonly operation: "list-clusters" | "describe-cluster";
      readonly cluster: string | undefined;
      readonly nextToken: string | undefined;
    }>();
  });
});
