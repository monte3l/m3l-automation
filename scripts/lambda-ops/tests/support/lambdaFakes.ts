import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LLambdaOperations`'s 7-method public
 * interface, each a `vi.fn()` the caller can configure per test.
 * `M3LLambdaOperations` is a concrete class with a private field, so a
 * structural object literal is cast through `unknown` — the same pattern
 * `scripts/sqs-etl/tests/support/sqsFakes.ts` uses for `M3LSQSOperations`.
 *
 * The steps under test never construct their own `M3LLambdaOperations` — it
 * is always an injected dependency, so this fake is never required to touch
 * `@aws-sdk/client-lambda`.
 */
export function createFakeLambdaOperations(overrides?: {
  readonly listFunctions?: ReturnType<typeof vi.fn>;
  readonly getFunction?: ReturnType<typeof vi.fn>;
  readonly invokeFunction?: ReturnType<typeof vi.fn>;
  readonly createFunction?: ReturnType<typeof vi.fn>;
  readonly updateFunctionCode?: ReturnType<typeof vi.fn>;
  readonly updateFunctionConfiguration?: ReturnType<typeof vi.fn>;
  readonly deleteFunction?: ReturnType<typeof vi.fn>;
}): AWS.M3LLambdaOperations {
  const fake = {
    listFunctions:
      overrides?.listFunctions ?? vi.fn().mockResolvedValue({ functions: [] }),
    getFunction:
      overrides?.getFunction ??
      vi.fn().mockResolvedValue({
        functionName: "",
        functionArn: "",
        lastModified: "",
      }),
    invokeFunction:
      overrides?.invokeFunction ??
      vi.fn().mockResolvedValue({ statusCode: 200 }),
    createFunction:
      overrides?.createFunction ??
      vi.fn().mockResolvedValue({
        functionName: "",
        functionArn: "",
        lastModified: "",
      }),
    updateFunctionCode:
      overrides?.updateFunctionCode ??
      vi.fn().mockResolvedValue({
        functionName: "",
        functionArn: "",
        lastModified: "",
      }),
    updateFunctionConfiguration:
      overrides?.updateFunctionConfiguration ??
      vi.fn().mockResolvedValue({
        functionName: "",
        functionArn: "",
        lastModified: "",
      }),
    deleteFunction:
      overrides?.deleteFunction ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as AWS.M3LLambdaOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
