import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { getCorrelationId, hooks } from "../src/hooks.js";

/**
 * Contract: spec-conformance-reviewer's `scripts/eventbridge-schedules`
 * contract §7 (mirrors `dynamodb-crud`/`api-gateway-client`'s hooks.ts).
 * `hooks.onBeforeRun` captures `ctx.correlationId` into a module-local
 * holder, later read back by `getCorrelationId()`. `getCorrelationId()`
 * throws a typed `Core.M3LError` coded
 * `ERR_EVENTBRIDGE_SCHEDULES_NO_CORRELATION_ID` when called before
 * `onBeforeRun` has ever run.
 *
 * `capturedCorrelationId` is module-local state shared across every test in
 * this file (a single module instance), so the "never captured" case is
 * only observable before any other test calls `onBeforeRun` — this test is
 * declared first and relies on vitest's default in-file declaration order
 * to run before the tests below mutate that state.
 */

function fakeHookContext(correlationId: string): Core.M3LScriptHookContext {
  return { config: new Core.M3LConfig(), correlationId, dryRun: false };
}

test("getCorrelationId throws a typed M3LError when called before onBeforeRun has ever run", () => {
  let thrown: unknown;
  try {
    getCorrelationId();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Core.M3LError);
  expect((thrown as Core.M3LError).code).toBe(
    "ERR_EVENTBRIDGE_SCHEDULES_NO_CORRELATION_ID",
  );
});

describe("eventbridge-schedules hooks", () => {
  test("onBeforeRun captures ctx.correlationId, readable via getCorrelationId()", async () => {
    await hooks.onBeforeRun?.(fakeHookContext("test-corr-id"));

    expect(getCorrelationId()).toBe("test-corr-id");
  });

  test("onBeforeRun re-captures the correlation id on every call", async () => {
    await hooks.onBeforeRun?.(fakeHookContext("first-run"));
    expect(getCorrelationId()).toBe("first-run");

    await hooks.onBeforeRun?.(fakeHookContext("second-run"));
    expect(getCorrelationId()).toBe("second-run");
  });
});
