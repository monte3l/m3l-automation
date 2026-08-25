import { afterEach, describe, expect, it, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * Contract: src/hooks.ts. `buildHooks(paths)` returns an
 * `M3LScriptLifecycleHooks` whose `onAfterRun` constructs its own
 * `Core.M3LCheckpointStore` (keyed on the resolved `output` config value) and
 * calls `.delete()` on it — but only when `ctx.config.get("output")` resolves
 * to a non-empty string; any other value (missing, empty, or a non-string)
 * short-circuits before the store is even constructed.
 *
 * `Core.M3LCheckpointStore` is mocked via the package-level
 * `vi.mock("@m3l-automation/m3l-common", ...)` factory (same pattern as
 * `run-cloudwatch-logs-insights.test.ts`) so this file asserts the hook's
 * branching in isolation.
 */

const checkpointMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    Core: {
      ...actual.Core,
      // A plain arrow function cannot be invoked with `new` — the source
      // constructs `new Core.M3LCheckpointStore(...)`, so the mocked
      // implementation must be an ordinary function expression.
      M3LCheckpointStore: vi.fn().mockImplementation(function mockedStore() {
        return {
          read: checkpointMocks.read,
          write: checkpointMocks.write,
          delete: checkpointMocks.delete,
        };
      }),
    },
  };
});

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
  checkpointMocks.read.mockReset();
  checkpointMocks.write.mockReset().mockResolvedValue(undefined);
  checkpointMocks.delete.mockReset().mockResolvedValue(undefined);
  vi.mocked(Core.M3LCheckpointStore).mockClear();
});

describe("buildHooks — onAfterRun", () => {
  it("constructs a checkpoint store keyed on 'output' and calls delete() when output is a non-empty string", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: "results.json" }));

    expect(checkpointMocks.delete).toHaveBeenCalledTimes(1);
    expect(checkpointMocks.delete).toHaveBeenCalledWith();
    expect(vi.mocked(Core.M3LCheckpointStore)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Core.M3LCheckpointStore).mock.calls[0];
    expect(call?.[0].paths).toBe(paths);
    expect(call?.[0].name).toBe("results.json");
  });

  it("does not construct a checkpoint store when 'output' is missing from config", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({}));

    expect(Core.M3LCheckpointStore).not.toHaveBeenCalled();
    expect(checkpointMocks.delete).not.toHaveBeenCalled();
  });

  it("does not construct a checkpoint store when 'output' is an empty string", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: "" }));

    expect(Core.M3LCheckpointStore).not.toHaveBeenCalled();
    expect(checkpointMocks.delete).not.toHaveBeenCalled();
  });

  it("does not construct a checkpoint store when 'output' is a non-string value", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: 42 }));

    expect(Core.M3LCheckpointStore).not.toHaveBeenCalled();
    expect(checkpointMocks.delete).not.toHaveBeenCalled();
  });
});

/**
 * Contract: issue #497 (A4b). `onAfterRun` only ever calls `.delete()` on its
 * checkpoint store, and this hook has no resolved `LogsInsightsRunSettings`
 * in scope (only `ctx.config.get("output")`) to build a `definition`
 * projection from even if it wanted one — deletion never verifies a
 * fingerprint, so passing one here would be inert at best. The delete-only
 * construction site stays as it was: no `definition` reaches
 * `buildCheckpointStore`.
 *
 * This is a regression lock, not a RED-phase proof: `hooks.ts` never passed a
 * `definition` before this retrofit either, so this test already passes
 * against the pre-retrofit source — its job is to keep passing once
 * `buildCheckpointStore` grows the optional 4th parameter, confirming this
 * call site was deliberately left out of the retrofit rather than missed.
 */
describe("buildHooks — onAfterRun (definition, issue #497 retrofit)", () => {
  it("constructs its checkpoint store with no definition — the delete-only path stays inert", async () => {
    const paths = new Core.M3LPaths();
    const hooks = buildHooks(paths);

    await hooks.onAfterRun?.(fakeHookContext({ output: "results.json" }));

    expect(Core.M3LCheckpointStore).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Core.M3LCheckpointStore).mock.calls[0];
    expect(call?.[0].definition).toBeUndefined();
  });
});
