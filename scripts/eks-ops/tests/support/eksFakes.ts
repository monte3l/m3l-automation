import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LEKSOperations`'s 16-method public
 * interface, each a `vi.fn()` the caller can configure per test.
 * `M3LEKSOperations` is a concrete class with a private field, so a
 * structural object literal is cast through `unknown` — the same pattern
 * `scripts/codepipeline-ops/tests/support/codePipelineFakes.ts` uses for
 * `M3LCodePipelineOperations`.
 *
 * The steps under test never construct their own `M3LEKSOperations` — it is
 * always an injected dependency, so this fake is never required to touch
 * `@aws-sdk/client-eks`.
 */
export function createFakeEKSOperations(overrides?: {
  readonly listClusters?: ReturnType<typeof vi.fn>;
  readonly describeCluster?: ReturnType<typeof vi.fn>;
  readonly createCluster?: ReturnType<typeof vi.fn>;
  readonly updateClusterConfig?: ReturnType<typeof vi.fn>;
  readonly updateClusterVersion?: ReturnType<typeof vi.fn>;
  readonly deleteCluster?: ReturnType<typeof vi.fn>;
  readonly waitUntilClusterActive?: ReturnType<typeof vi.fn>;
  readonly waitUntilClusterDeleted?: ReturnType<typeof vi.fn>;
  readonly listNodegroups?: ReturnType<typeof vi.fn>;
  readonly describeNodegroup?: ReturnType<typeof vi.fn>;
  readonly createNodegroup?: ReturnType<typeof vi.fn>;
  readonly updateNodegroupConfig?: ReturnType<typeof vi.fn>;
  readonly updateNodegroupVersion?: ReturnType<typeof vi.fn>;
  readonly deleteNodegroup?: ReturnType<typeof vi.fn>;
  readonly waitUntilNodegroupActive?: ReturnType<typeof vi.fn>;
  readonly waitUntilNodegroupDeleted?: ReturnType<typeof vi.fn>;
}): AWS.M3LEKSOperations {
  const fakeClusterSummary = { name: "", arn: "", status: "" };
  const fakeNodegroupSummary = {
    nodegroupName: "",
    nodegroupArn: "",
    status: "",
  };
  const fakeUpdate = { id: "", status: "InProgress" };
  const fakeWaiterResult = { state: "SUCCESS" };

  const fake = {
    listClusters:
      overrides?.listClusters ?? vi.fn().mockResolvedValue({ clusters: [] }),
    describeCluster:
      overrides?.describeCluster ??
      vi.fn().mockResolvedValue(fakeClusterSummary),
    createCluster:
      overrides?.createCluster ?? vi.fn().mockResolvedValue(fakeClusterSummary),
    updateClusterConfig:
      overrides?.updateClusterConfig ?? vi.fn().mockResolvedValue(fakeUpdate),
    updateClusterVersion:
      overrides?.updateClusterVersion ?? vi.fn().mockResolvedValue(fakeUpdate),
    deleteCluster:
      overrides?.deleteCluster ?? vi.fn().mockResolvedValue(fakeClusterSummary),
    waitUntilClusterActive:
      overrides?.waitUntilClusterActive ??
      vi.fn().mockResolvedValue(fakeWaiterResult),
    waitUntilClusterDeleted:
      overrides?.waitUntilClusterDeleted ??
      vi.fn().mockResolvedValue(fakeWaiterResult),
    listNodegroups:
      overrides?.listNodegroups ??
      vi.fn().mockResolvedValue({ nodegroups: [] }),
    describeNodegroup:
      overrides?.describeNodegroup ??
      vi.fn().mockResolvedValue(fakeNodegroupSummary),
    createNodegroup:
      overrides?.createNodegroup ??
      vi.fn().mockResolvedValue(fakeNodegroupSummary),
    updateNodegroupConfig:
      overrides?.updateNodegroupConfig ?? vi.fn().mockResolvedValue(fakeUpdate),
    updateNodegroupVersion:
      overrides?.updateNodegroupVersion ??
      vi.fn().mockResolvedValue(fakeUpdate),
    deleteNodegroup:
      overrides?.deleteNodegroup ??
      vi.fn().mockResolvedValue(fakeNodegroupSummary),
    waitUntilNodegroupActive:
      overrides?.waitUntilNodegroupActive ??
      vi.fn().mockResolvedValue(fakeWaiterResult),
    waitUntilNodegroupDeleted:
      overrides?.waitUntilNodegroupDeleted ??
      vi.fn().mockResolvedValue(fakeWaiterResult),
  };
  return fake as unknown as AWS.M3LEKSOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
