import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readClusters } from "../src/steps/read-clusters.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/read-clusters.ts` — `list-clusters`
 * (`listClusters({ nextToken, maxResults, include })`) and `describe-cluster`
 * (`describeCluster(cluster)`), never gated. `describeCluster` may resolve
 * `undefined` (the wrapper's not-found convention) — this step returns that
 * `undefined` UNCHANGED; converting it into `ERR_EKS_OPS_NOT_FOUND` is
 * `run-eks-ops`'s job, not this step's (see `docs/reference/scripts/eks-ops.md`).
 * Deps arrive already guard-checked/resolved by `run-eks-ops` — this step
 * takes no raw `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readClusters — list-clusters", () => {
  test("calls operations.listClusters({ nextToken, maxResults, include }) and returns the result unchanged", async () => {
    const result: AWS.M3LEKSListClustersResult = {
      clusters: ["my-cluster"],
      nextToken: "next-token",
    };
    const listClusters = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ listClusters });

    const returned = await readClusters({
      operations,
      operation: "list-clusters",
      cluster: undefined,
      nextToken: "prev-token",
      maxResults: 25,
      include: ["all"],
    });

    expect(listClusters).toHaveBeenCalledTimes(1);
    const call = listClusters.mock.calls[0] as [
      {
        nextToken?: string;
        maxResults?: number;
        include?: readonly string[];
      }?,
    ];
    expect(call[0]?.nextToken).toBe("prev-token");
    expect(call[0]?.maxResults).toBe(25);
    expect(call[0]?.include).toEqual(["all"]);
    expect(returned).toEqual(result);
  });

  test("omits nextToken/maxResults/include from the call when unset", async () => {
    const listClusters = vi.fn().mockResolvedValue({ clusters: [] });
    const operations = createFakeEKSOperations({ listClusters });

    await readClusters({
      operations,
      operation: "list-clusters",
      cluster: undefined,
      nextToken: undefined,
      maxResults: undefined,
      include: undefined,
    });

    const call = listClusters.mock.calls[0] as [
      {
        nextToken?: string;
        maxResults?: number;
        include?: readonly string[];
      }?,
    ];
    expect(call[0]?.nextToken).toBeUndefined();
    expect(call[0]?.maxResults).toBeUndefined();
    expect(call[0]?.include).toBeUndefined();
  });
});

describe("readClusters — describe-cluster", () => {
  test("calls operations.describeCluster(cluster) and returns the summary unchanged", async () => {
    const summary: AWS.M3LEKSClusterSummary = {
      name: "my-cluster",
      arn: "arn:aws:eks:us-east-1:123:cluster/my-cluster",
      status: "ACTIVE",
    };
    const describeCluster = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ describeCluster });

    const returned = await readClusters({
      operations,
      operation: "describe-cluster",
      cluster: "my-cluster",
      nextToken: undefined,
      maxResults: undefined,
      include: undefined,
    });

    expect(describeCluster).toHaveBeenCalledWith("my-cluster");
    expect(returned).toEqual(summary);
  });

  test("passes through an undefined (not-found) resolution unchanged — does NOT convert it to an error", async () => {
    const describeCluster = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeEKSOperations({ describeCluster });

    const returned = await readClusters({
      operations,
      operation: "describe-cluster",
      cluster: "missing-cluster",
      nextToken: undefined,
      maxResults: undefined,
      include: undefined,
    });

    expect(returned).toBeUndefined();
  });

  test("throws ERR_EKS_OPS_CONFIG when cluster is undefined, never calling describeCluster", async () => {
    const describeCluster = vi.fn();
    const operations = createFakeEKSOperations({ describeCluster });

    let thrown: unknown;
    try {
      await readClusters({
        operations,
        operation: "describe-cluster",
        cluster: undefined,
        nextToken: undefined,
        maxResults: undefined,
        include: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_EKS_OPS_CONFIG");
    expect(describeCluster).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readClusters resolves the list-or-describe-or-undefined result union", () => {
    expectTypeOf(readClusters).returns.resolves.toEqualTypeOf<
      AWS.M3LEKSListClustersResult | AWS.M3LEKSClusterSummary | undefined
    >();
  });
});
