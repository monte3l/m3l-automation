import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LSQSOperations`'s 4-method public
 * interface (`receive`/`sendBatch`/`deleteBatch`/`purgeQueue`), each a
 * `vi.fn()` the caller can configure per test. `M3LSQSOperations` is a
 * concrete class with a private field, so a structural object literal is
 * cast through `unknown` — the same pattern this suite already uses for
 * `WriteStream`/`FileHandle` fakes (see `support/fsFakes.ts`).
 *
 * The step under test never constructs its own `M3LSQSOperations` — it is
 * always an injected dependency, so this fake is never required to touch
 * `@aws-sdk/client-sqs`.
 */
export function createFakeSqsOperations(overrides?: {
  readonly receive?: ReturnType<typeof vi.fn>;
  readonly sendBatch?: ReturnType<typeof vi.fn>;
  readonly deleteBatch?: ReturnType<typeof vi.fn>;
  readonly purgeQueue?: ReturnType<typeof vi.fn>;
}): AWS.M3LSQSOperations {
  const fake = {
    receive: overrides?.receive ?? vi.fn().mockResolvedValue([]),
    sendBatch:
      overrides?.sendBatch ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
    deleteBatch:
      overrides?.deleteBatch ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
    purgeQueue: overrides?.purgeQueue ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as AWS.M3LSQSOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
