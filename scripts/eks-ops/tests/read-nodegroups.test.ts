import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readNodegroups } from "../src/steps/read-nodegroups.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/read-nodegroups.ts` — `list-nodegroups`
 * (`listNodegroups(cluster, { nextToken, maxResults })`) and
 * `describe-nodegroup` (`describeNodegroup(cluster, nodegroup)`), never
 * gated. Same `undefined`-on-not-found passthrough as `read-clusters` for
 * `describe-nodegroup`; `listNodegroups` itself THROWS (never resolves
 * `undefined`) on an unknown `cluster` — that failure propagates unchanged
 * as `AWS.M3LEKSOperationError`, this step performs no catch of its own.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readNodegroups — list-nodegroups", () => {
  test("calls operations.listNodegroups(cluster, { nextToken, maxResults }) and returns the result unchanged", async () => {
    const result: AWS.M3LEKSListNodegroupsResult = {
      nodegroups: ["my-nodegroup"],
      nextToken: "next-token",
    };
    const listNodegroups = vi.fn().mockResolvedValue(result);
    const operations = createFakeEKSOperations({ listNodegroups });

    const returned = await readNodegroups({
      operations,
      operation: "list-nodegroups",
      cluster: "my-cluster",
      nodegroup: undefined,
      nextToken: "prev-token",
      maxResults: 25,
    });

    expect(listNodegroups).toHaveBeenCalledTimes(1);
    const call = listNodegroups.mock.calls[0] as [
      string,
      { nextToken?: string; maxResults?: number }?,
    ];
    expect(call[0]).toBe("my-cluster");
    expect(call[1]?.nextToken).toBe("prev-token");
    expect(call[1]?.maxResults).toBe(25);
    expect(returned).toEqual(result);
  });

  test("propagates a thrown error for an unknown clusterName unchanged (no undefined-catching here)", async () => {
    const cause = new Core.M3LError("ListNodegroups failed", {
      code: "ERR_EKS_OPERATION",
    });
    const listNodegroups = vi.fn().mockRejectedValue(cause);
    const operations = createFakeEKSOperations({ listNodegroups });

    await expect(
      readNodegroups({
        operations,
        operation: "list-nodegroups",
        cluster: "unknown-cluster",
        nodegroup: undefined,
        nextToken: undefined,
        maxResults: undefined,
      }),
    ).rejects.toBe(cause);
  });
});

describe("readNodegroups — describe-nodegroup", () => {
  test("calls operations.describeNodegroup(cluster, nodegroup) and returns the summary unchanged", async () => {
    const summary: AWS.M3LEKSNodegroupSummary = {
      nodegroupName: "my-nodegroup",
      nodegroupArn:
        "arn:aws:eks:us-east-1:123:nodegroup/my-cluster/my-nodegroup/abc",
      status: "ACTIVE",
    };
    const describeNodegroup = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ describeNodegroup });

    const returned = await readNodegroups({
      operations,
      operation: "describe-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      nextToken: undefined,
      maxResults: undefined,
    });

    expect(describeNodegroup).toHaveBeenCalledWith(
      "my-cluster",
      "my-nodegroup",
    );
    expect(returned).toEqual(summary);
  });

  test("passes through an undefined (not-found) resolution unchanged — does NOT convert it to an error", async () => {
    const describeNodegroup = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeEKSOperations({ describeNodegroup });

    const returned = await readNodegroups({
      operations,
      operation: "describe-nodegroup",
      cluster: "my-cluster",
      nodegroup: "missing-nodegroup",
      nextToken: undefined,
      maxResults: undefined,
    });

    expect(returned).toBeUndefined();
  });

  test("throws ERR_EKS_OPS_CONFIG when nodegroup is undefined, never calling describeNodegroup", async () => {
    const describeNodegroup = vi.fn();
    const operations = createFakeEKSOperations({ describeNodegroup });

    let thrown: unknown;
    try {
      await readNodegroups({
        operations,
        operation: "describe-nodegroup",
        cluster: "my-cluster",
        nodegroup: undefined,
        nextToken: undefined,
        maxResults: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_EKS_OPS_CONFIG");
    expect(describeNodegroup).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readNodegroups resolves the list-or-describe-or-undefined result union", () => {
    expectTypeOf(readNodegroups).returns.resolves.toEqualTypeOf<
      AWS.M3LEKSListNodegroupsResult | AWS.M3LEKSNodegroupSummary | undefined
    >();
  });
});
