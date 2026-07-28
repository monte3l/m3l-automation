import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { writeNodegroup } from "../src/steps/write-nodegroup.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/write-nodegroup.ts` — the four nodegroup-mutating
 * operations, scoped to `deps.cluster`/`deps.nodegroup` (never from
 * `deps.input`): `create-nodegroup`
 * (`createNodegroup({ clusterName: cluster, nodegroupName: nodegroup,
 * ...input })`), `update-nodegroup-config`
 * (`updateNodegroupConfig({ clusterName: cluster, nodegroupName: nodegroup,
 * ...input })`), `update-nodegroup-version`
 * (`updateNodegroupVersion({ clusterName: cluster, nodegroupName:
 * nodegroup, version: kubernetesVersion, releaseVersion, force })`),
 * `delete-nodegroup` (`deleteNodegroup(cluster, nodegroup)`). Returns the
 * `M3LEKSUpdate`/`M3LEKSNodegroupSummary` UNCHANGED — never inspects
 * `.status`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeNodegroup — create-nodegroup", () => {
  test("calls createNodegroup({ clusterName, nodegroupName, ...input }), never reading identity from input", async () => {
    const summary: AWS.M3LEKSNodegroupSummary = {
      nodegroupName: "my-nodegroup",
      nodegroupArn:
        "arn:aws:eks:us-east-1:123:nodegroup/my-cluster/my-nodegroup/abc",
      status: "CREATING",
    };
    const createNodegroup = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ createNodegroup });

    const returned = await writeNodegroup({
      operations,
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: {
        clusterName: "ignored-from-input",
        nodegroupName: "ignored-from-input",
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: ["subnet-1"],
      },
      kubernetesVersion: undefined,
      releaseVersion: undefined,
      force: false,
    });

    expect(createNodegroup).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterName: "my-cluster",
        nodegroupName: "my-nodegroup",
        nodeRole: "arn:aws:iam::123:role/node",
      }),
    );
    expect(returned).toEqual(summary);
  });
});

describe("writeNodegroup — update-nodegroup-config", () => {
  test("calls updateNodegroupConfig({ clusterName, nodegroupName, ...input }) and returns the M3LEKSUpdate unchanged", async () => {
    const update: AWS.M3LEKSUpdate = { id: "update-1", status: "InProgress" };
    const updateNodegroupConfig = vi.fn().mockResolvedValue(update);
    const operations = createFakeEKSOperations({ updateNodegroupConfig });

    const returned = await writeNodegroup({
      operations,
      operation: "update-nodegroup-config",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: { scalingConfig: { minSize: 1, maxSize: 3, desiredSize: 2 } },
      kubernetesVersion: undefined,
      releaseVersion: undefined,
      force: false,
    });

    expect(updateNodegroupConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterName: "my-cluster",
        nodegroupName: "my-nodegroup",
        scalingConfig: { minSize: 1, maxSize: 3, desiredSize: 2 },
      }),
    );
    expect(returned).toEqual(update);
  });
});

describe("writeNodegroup — update-nodegroup-version", () => {
  test("calls updateNodegroupVersion({ clusterName, nodegroupName, version, releaseVersion, force }) and returns the M3LEKSUpdate unchanged", async () => {
    const update: AWS.M3LEKSUpdate = { id: "update-2", status: "InProgress" };
    const updateNodegroupVersion = vi.fn().mockResolvedValue(update);
    const operations = createFakeEKSOperations({ updateNodegroupVersion });

    const returned = await writeNodegroup({
      operations,
      operation: "update-nodegroup-version",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: undefined,
      kubernetesVersion: "1.30",
      releaseVersion: "1.30.0-20240101",
      force: true,
    });

    expect(updateNodegroupVersion).toHaveBeenCalledWith({
      clusterName: "my-cluster",
      nodegroupName: "my-nodegroup",
      version: "1.30",
      releaseVersion: "1.30.0-20240101",
      force: true,
    });
    expect(returned).toEqual(update);
  });

  test("omits version when only releaseVersion is supplied (version optional per contract)", async () => {
    const update: AWS.M3LEKSUpdate = { id: "update-3", status: "InProgress" };
    const updateNodegroupVersion = vi.fn().mockResolvedValue(update);
    const operations = createFakeEKSOperations({ updateNodegroupVersion });

    await writeNodegroup({
      operations,
      operation: "update-nodegroup-version",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: undefined,
      kubernetesVersion: undefined,
      releaseVersion: "1.30.0-20240101",
      force: false,
    });

    const call = updateNodegroupVersion.mock.calls[0] as [
      { version?: string; releaseVersion?: string },
    ];
    expect(call[0].version).toBeUndefined();
    expect(call[0].releaseVersion).toBe("1.30.0-20240101");
  });
});

describe("writeNodegroup — delete-nodegroup", () => {
  test("calls deleteNodegroup(cluster, nodegroup) with just the identity", async () => {
    const summary: AWS.M3LEKSNodegroupSummary = {
      nodegroupName: "my-nodegroup",
      nodegroupArn:
        "arn:aws:eks:us-east-1:123:nodegroup/my-cluster/my-nodegroup/abc",
      status: "DELETING",
    };
    const deleteNodegroup = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ deleteNodegroup });

    const returned = await writeNodegroup({
      operations,
      operation: "delete-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: undefined,
      kubernetesVersion: undefined,
      releaseVersion: undefined,
      force: false,
    });

    expect(deleteNodegroup).toHaveBeenCalledWith("my-cluster", "my-nodegroup");
    expect(returned).toEqual(summary);
  });
});

describe("writeNodegroup — update-* results are returned as-is, never inspected", () => {
  test.each(["InProgress", "Failed", "Successful"] as const)(
    "returns an M3LEKSUpdate with status '%s' unchanged, without throwing",
    async (status) => {
      const update: AWS.M3LEKSUpdate = { id: "update-4", status };
      const updateNodegroupVersion = vi.fn().mockResolvedValue(update);
      const operations = createFakeEKSOperations({ updateNodegroupVersion });

      const returned = await writeNodegroup({
        operations,
        operation: "update-nodegroup-version",
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        input: undefined,
        kubernetesVersion: "1.30",
        releaseVersion: undefined,
        force: false,
      });

      expect(returned).toEqual(update);
    },
  );
});

describe("type contract", () => {
  test("writeNodegroup resolves the summary-or-update result union", () => {
    expectTypeOf(writeNodegroup).returns.resolves.toEqualTypeOf<
      AWS.M3LEKSNodegroupSummary | AWS.M3LEKSUpdate
    >();
  });
});
