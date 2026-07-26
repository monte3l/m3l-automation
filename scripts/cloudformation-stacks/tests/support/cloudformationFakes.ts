import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LCloudFormationOperations`'s 9-method
 * public interface, each a `vi.fn()` the caller can configure per test.
 * `M3LCloudFormationOperations` is a concrete class with a private field, so
 * a structural object literal is cast through `unknown` — the same pattern
 * `scripts/ecs-ops/tests/support/ecsFakes.ts` uses for `M3LECSOperations`.
 *
 * The steps under test never construct their own
 * `M3LCloudFormationOperations` — it is always an injected dependency, so
 * this fake is never required to touch `@aws-sdk/client-cloudformation`.
 */
export function createFakeCloudFormationOperations(overrides?: {
  readonly listStacks?: ReturnType<typeof vi.fn>;
  readonly describeStack?: ReturnType<typeof vi.fn>;
  readonly createStack?: ReturnType<typeof vi.fn>;
  readonly updateStack?: ReturnType<typeof vi.fn>;
  readonly deleteStack?: ReturnType<typeof vi.fn>;
  readonly describeStackEvents?: ReturnType<typeof vi.fn>;
  readonly waitUntilStackCreateComplete?: ReturnType<typeof vi.fn>;
  readonly waitUntilStackUpdateComplete?: ReturnType<typeof vi.fn>;
  readonly waitUntilStackDeleteComplete?: ReturnType<typeof vi.fn>;
}): AWS.M3LCloudFormationOperations {
  const fakeStack = {
    stackName: "",
    stackStatus: "",
  };
  const fake = {
    listStacks:
      overrides?.listStacks ??
      vi.fn().mockResolvedValue({ stackSummaries: [] }),
    describeStack:
      overrides?.describeStack ?? vi.fn().mockResolvedValue(fakeStack),
    createStack:
      overrides?.createStack ??
      vi.fn().mockResolvedValue({ stackId: "arn:aws:cloudformation::stack/x" }),
    updateStack:
      overrides?.updateStack ??
      vi.fn().mockResolvedValue({
        changed: true,
        stackId: "arn:aws:cloudformation::stack/x",
      }),
    deleteStack: overrides?.deleteStack ?? vi.fn().mockResolvedValue(undefined),
    describeStackEvents:
      overrides?.describeStackEvents ??
      vi.fn().mockResolvedValue({ stackEvents: [] }),
    waitUntilStackCreateComplete:
      overrides?.waitUntilStackCreateComplete ??
      vi.fn().mockResolvedValue({ state: "SUCCESS" }),
    waitUntilStackUpdateComplete:
      overrides?.waitUntilStackUpdateComplete ??
      vi.fn().mockResolvedValue({ state: "SUCCESS" }),
    waitUntilStackDeleteComplete:
      overrides?.waitUntilStackDeleteComplete ??
      vi.fn().mockResolvedValue({ state: "SUCCESS" }),
  };
  return fake as unknown as AWS.M3LCloudFormationOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
