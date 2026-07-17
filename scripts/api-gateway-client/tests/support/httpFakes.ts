import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `Core.M3LHttpClient`'s `request()` method —
 * the only method every `api-gateway-client` step calls. `M3LHttpClient` is
 * a concrete class extending an internal event-emitter base, so a
 * structural object literal is cast through `unknown` — the same pattern
 * `sqs-etl`'s `support/sqsFakes.ts` uses for `AWS.M3LSQSOperations`.
 *
 * The step under test never constructs its own `M3LHttpClient` — it is
 * always an injected dependency, so this fake never touches `undici`.
 */
export function createFakeHttpClient(overrides?: {
  readonly request?: ReturnType<typeof vi.fn>;
}): Core.M3LHttpClient {
  const fake = {
    request: overrides?.request ?? vi.fn().mockResolvedValue({}),
  };
  return fake as unknown as Core.M3LHttpClient;
}

/**
 * Builds a plain-object fake of `AWS.M3LRequestSigner`'s `signedHeaders()`
 * method — the only method `resolve-auth-headers` calls for `auth: iam`.
 */
export function createFakeRequestSigner(overrides?: {
  readonly signedHeaders?: ReturnType<typeof vi.fn>;
}): AWS.M3LRequestSigner {
  const fake = {
    signedHeaders:
      overrides?.signedHeaders ??
      vi.fn().mockResolvedValue({ authorization: "AWS4-HMAC-SHA256 fake" }),
  };
  return fake as unknown as AWS.M3LRequestSigner;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
