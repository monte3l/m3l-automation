import { beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type * as HooksModule from "../src/hooks.js";
import { getCorrelationId, hooks } from "../src/hooks.js";

/**
 * Contract: `main.ts` reads the per-run correlation id back through
 * {@link getCorrelationId} because `M3LScript.run`'s `mainFn` receives no
 * hook context. The id names the archived `analyze` report when the operator
 * supplies no explicit `output`, so a lost or stale capture silently
 * overwrites a previous run's evidence.
 */

/** Builds the hook context `onBeforeRun` receives, with `correlationId` set. */
function hookContext(correlationId: string): Core.M3LScriptHookContext {
  return {
    config: new Core.M3LConfig(),
    correlationId,
    dryRun: false,
  };
}

/**
 * Fires `onBeforeRun` the way the lifecycle does. Awaited because the hook
 * type is `void | Promise<void>`; this script's implementation is
 * synchronous, but the call site must not assume that.
 */
async function fireBeforeRun(correlationId: string): Promise<void> {
  await hooks.onBeforeRun?.(hookContext(correlationId));
}

describe("getCorrelationId, once onBeforeRun has captured", () => {
  beforeEach(async () => {
    await fireBeforeRun("run-baseline");
  });

  it("returns the id onBeforeRun captured", async () => {
    await fireBeforeRun("run-42");
    expect(getCorrelationId()).toBe("run-42");
  });

  it("re-resolves on every run rather than keeping the first id", async () => {
    await fireBeforeRun("run-first");
    expect(getCorrelationId()).toBe("run-first");
    await fireBeforeRun("run-second");
    expect(getCorrelationId()).toBe("run-second");
  });
});

describe("getCorrelationId, before onBeforeRun has run", () => {
  /**
   * The captured id lives in module state, so the only way to observe the
   * never-captured state is a fresh module instance — `vi.resetModules()`
   * plus a dynamic import. Once any other test in this file has captured,
   * the statically imported module can no longer reach this path.
   */
  async function freshHooks(): Promise<typeof HooksModule> {
    vi.resetModules();
    return import("../src/hooks.js");
  }

  /**
   * Asserted by message, not `instanceof`: `vi.resetModules()` gives the
   * fresh module its own copy of `@m3l-automation/m3l-common` too, so the
   * error it throws is an `M3LError` from a *different* class identity than
   * the one this file imported statically. The behaviour under test is that
   * it refuses at all — never that it returns `""` or a stale id.
   */
  it("throws rather than returning a stale or empty id", async () => {
    const fresh = await freshHooks();
    expect(() => fresh.getCorrelationId()).toThrow(
      /correlationId not yet captured/u,
    );
  });

  it("throws under ERR_LOGS_ANALYSIS_NO_CORRELATION_ID, naming the missing stage", async () => {
    const fresh = await freshHooks();
    try {
      fresh.getCorrelationId();
      throw new Error("expected getCorrelationId to throw");
    } catch (error) {
      expect((error as Core.M3LError).code).toBe(
        "ERR_LOGS_ANALYSIS_NO_CORRELATION_ID",
      );
      expect((error as Error).message).toContain("onBeforeRun");
    }
  });
});

describe("the hooks declaration", () => {
  it("declares onBeforeRun, the stage that captures the id", () => {
    expect(hooks.onBeforeRun).toBeTypeOf("function");
  });

  it("declares no other lifecycle stage", () => {
    expect(Object.keys(hooks)).toEqual(["onBeforeRun"]);
  });
});
