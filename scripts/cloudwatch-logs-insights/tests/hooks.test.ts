import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract: src/hooks.ts. `buildHooks(paths)` returns an
 * `M3LScriptLifecycleHooks` whose `onAfterRun` deletes the run's checkpoint
 * file via `deleteCheckpoint` — but only when `ctx.config.get("output")`
 * resolves to a non-empty string; any other value (missing, empty, or a
 * non-string) short-circuits and never calls `deleteCheckpoint`.
 *
 * `checkpoint.js` is mocked so this file asserts the hook's branching in
 * isolation, mirroring the mock-collaborator pattern used for
 * `run-cloudwatch-logs-insights.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/steps/checkpoint.js", () => ({
  deleteCheckpoint: mocks.deleteCheckpoint,
}));

import { Core } from "@m3l-automation/m3l-common";

import { buildHooks } from "../src/hooks.js";

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

function fakeHookContext(
  values: Record<string, unknown>,
): Core.M3LScriptHookContext {
  return {
    config: buildConfig(values),
    correlationId: "test-corr-id",
    dryRun: false,
  };
}

afterEach(() => {
  mocks.deleteCheckpoint.mockReset().mockResolvedValue(undefined);
});

describe("buildHooks — onAfterRun", () => {
  it("calls deleteCheckpoint with { paths, output } when config.get('output') is a non-empty string", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: "results.json" }));

    expect(mocks.deleteCheckpoint).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCheckpoint).toHaveBeenCalledWith({
      paths,
      output: "results.json",
    });
  });

  it("does not call deleteCheckpoint when 'output' is missing from config", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({}));

    expect(mocks.deleteCheckpoint).not.toHaveBeenCalled();
  });

  it("does not call deleteCheckpoint when 'output' is an empty string", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: "" }));

    expect(mocks.deleteCheckpoint).not.toHaveBeenCalled();
  });

  it("does not call deleteCheckpoint when 'output' is a non-string value", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: 42 }));

    expect(mocks.deleteCheckpoint).not.toHaveBeenCalled();
  });
});
