import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { writeCluster } from "../src/steps/write-cluster.js";
import { createFakeEKSOperations } from "./support/eksFakes.js";

/**
 * Contract: `src/steps/write-cluster.ts` — the four cluster-mutating
 * operations. Resource identity always comes from `deps.cluster` (never from
 * `deps.input`): `create-cluster`
 * (`createCluster({ name: cluster, ...input })`), `update-cluster-config`
 * (`updateClusterConfig({ name: cluster, ...input })`),
 * `update-cluster-version`
 * (`updateClusterVersion({ name: cluster, version: kubernetesVersion,
 * force })`), `delete-cluster` (`deleteCluster(cluster)`). Returns the
 * `M3LEKSUpdate`/`M3LEKSClusterSummary` UNCHANGED — this step never inspects
 * `.status`; that decision belongs to `run-eks-ops`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeCluster — create-cluster", () => {
  test("calls createCluster({ name: cluster, ...input }), never reading the name from input", async () => {
    const summary: AWS.M3LEKSClusterSummary = {
      name: "my-cluster",
      arn: "arn:aws:eks:us-east-1:123:cluster/my-cluster",
      status: "CREATING",
    };
    const createCluster = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ createCluster });

    const returned = await writeCluster({
      operations,
      operation: "create-cluster",
      cluster: "my-cluster",
      input: {
        name: "ignored-name-from-input",
        roleArn: "arn:aws:iam::123:role/eks",
        resourcesVpcConfig: { subnetIds: ["subnet-1", "subnet-2"] },
      },
      kubernetesVersion: undefined,
      force: false,
    });

    expect(createCluster).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-cluster",
        roleArn: "arn:aws:iam::123:role/eks",
      }),
    );
    expect(returned).toEqual(summary);
  });
});

describe("writeCluster — update-cluster-config", () => {
  test("calls updateClusterConfig({ name: cluster, ...input }) and returns the M3LEKSUpdate unchanged", async () => {
    const update: AWS.M3LEKSUpdate = { id: "update-1", status: "InProgress" };
    const updateClusterConfig = vi.fn().mockResolvedValue(update);
    const operations = createFakeEKSOperations({ updateClusterConfig });

    const returned = await writeCluster({
      operations,
      operation: "update-cluster-config",
      cluster: "my-cluster",
      input: { deletionProtection: true },
      kubernetesVersion: undefined,
      force: false,
    });

    expect(updateClusterConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-cluster",
        deletionProtection: true,
      }),
    );
    expect(returned).toEqual(update);
  });
});

describe("writeCluster — update-cluster-version", () => {
  test("calls updateClusterVersion({ name: cluster, version: kubernetesVersion, force }) and returns the M3LEKSUpdate unchanged", async () => {
    const update: AWS.M3LEKSUpdate = { id: "update-2", status: "InProgress" };
    const updateClusterVersion = vi.fn().mockResolvedValue(update);
    const operations = createFakeEKSOperations({ updateClusterVersion });

    const returned = await writeCluster({
      operations,
      operation: "update-cluster-version",
      cluster: "my-cluster",
      input: undefined,
      kubernetesVersion: "1.30",
      force: true,
    });

    expect(updateClusterVersion).toHaveBeenCalledWith({
      name: "my-cluster",
      version: "1.30",
      force: true,
    });
    expect(returned).toEqual(update);
  });
});

describe("writeCluster — delete-cluster", () => {
  test("calls deleteCluster(cluster) with just the identity", async () => {
    const summary: AWS.M3LEKSClusterSummary = {
      name: "my-cluster",
      arn: "arn:aws:eks:us-east-1:123:cluster/my-cluster",
      status: "DELETING",
    };
    const deleteCluster = vi.fn().mockResolvedValue(summary);
    const operations = createFakeEKSOperations({ deleteCluster });

    const returned = await writeCluster({
      operations,
      operation: "delete-cluster",
      cluster: "my-cluster",
      input: undefined,
      kubernetesVersion: undefined,
      force: false,
    });

    expect(deleteCluster).toHaveBeenCalledWith("my-cluster");
    expect(returned).toEqual(summary);
  });
});

describe("writeCluster — update-* results are returned as-is, never inspected", () => {
  test.each(["InProgress", "Failed", "Successful"] as const)(
    "returns an M3LEKSUpdate with status '%s' unchanged, without throwing",
    async (status) => {
      const update: AWS.M3LEKSUpdate = { id: "update-3", status };
      const updateClusterVersion = vi.fn().mockResolvedValue(update);
      const operations = createFakeEKSOperations({ updateClusterVersion });

      const returned = await writeCluster({
        operations,
        operation: "update-cluster-version",
        cluster: "my-cluster",
        input: undefined,
        kubernetesVersion: "1.30",
        force: false,
      });

      expect(returned).toEqual(update);
    },
  );
});

describe("type contract", () => {
  test("writeCluster resolves the summary-or-update result union", () => {
    expectTypeOf(writeCluster).returns.resolves.toEqualTypeOf<
      AWS.M3LEKSClusterSummary | AWS.M3LEKSUpdate
    >();
  });
});
