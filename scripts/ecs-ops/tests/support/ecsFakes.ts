import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LECSOperations`'s 8-method public
 * interface, each a `vi.fn()` the caller can configure per test.
 * `M3LECSOperations` is a concrete class with a private field, so a
 * structural object literal is cast through `unknown` — the same pattern
 * `scripts/lambda-ops/tests/support/lambdaFakes.ts` uses for
 * `M3LLambdaOperations`.
 *
 * The steps under test never construct their own `M3LECSOperations` — it is
 * always an injected dependency, so this fake is never required to touch
 * `@aws-sdk/client-ecs`.
 */
export function createFakeEcsOperations(overrides?: {
  readonly listServices?: ReturnType<typeof vi.fn>;
  readonly describeService?: ReturnType<typeof vi.fn>;
  readonly createService?: ReturnType<typeof vi.fn>;
  readonly updateService?: ReturnType<typeof vi.fn>;
  readonly deleteService?: ReturnType<typeof vi.fn>;
  readonly waitUntilServicesStable?: ReturnType<typeof vi.fn>;
  readonly listClusters?: ReturnType<typeof vi.fn>;
  readonly describeCluster?: ReturnType<typeof vi.fn>;
}): AWS.M3LECSOperations {
  const fakeServiceDescription = {
    serviceArn: "",
    serviceName: "",
    clusterArn: "",
    status: "",
    desiredCount: 0,
    runningCount: 0,
    pendingCount: 0,
  };
  const fake = {
    listServices:
      overrides?.listServices ?? vi.fn().mockResolvedValue({ serviceArns: [] }),
    describeService:
      overrides?.describeService ??
      vi.fn().mockResolvedValue(fakeServiceDescription),
    createService:
      overrides?.createService ??
      vi.fn().mockResolvedValue(fakeServiceDescription),
    updateService:
      overrides?.updateService ??
      vi.fn().mockResolvedValue(fakeServiceDescription),
    deleteService:
      overrides?.deleteService ??
      vi.fn().mockResolvedValue(fakeServiceDescription),
    waitUntilServicesStable:
      overrides?.waitUntilServicesStable ??
      vi.fn().mockResolvedValue({ state: "SUCCESS" }),
    listClusters:
      overrides?.listClusters ?? vi.fn().mockResolvedValue({ clusterArns: [] }),
    describeCluster:
      overrides?.describeCluster ??
      vi.fn().mockResolvedValue({ clusterArn: "", clusterName: "" }),
  };
  return fake as unknown as AWS.M3LECSOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
