import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { deleteRule } from "../src/steps/delete-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `delete-rule`
 * row. Guard-resolves `ruleName`; reads optional `eventBusName`; reads
 * `force` as `config.get("force") === true` (defaults to `false`); calls
 * `eventBridgeOperations.deleteRule(ruleName, { eventBusName?, force })`.
 * A rejection from `deleteRule` propagates unchanged.
 */

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/** Structural fake of `AWS.M3LEventBridgeOperations`, one `vi.fn()` per method used by these steps. */
function createFakeEventBridgeOperations(overrides?: {
  readonly deleteRule?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    putRule: vi.fn(),
    putTargets: vi.fn(),
    deleteRule: overrides?.deleteRule ?? vi.fn().mockResolvedValue(undefined),
    enableRule: vi.fn(),
    disableRule: vi.fn(),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

describe("deleteRule", () => {
  test("missing ruleName throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming 'delete'", async () => {
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await deleteRule({
        config,
        paths,
        logger,
        correlationId: "run-1",
        eventBridgeOperations,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toContain(
      "'ruleName' is required for 'delete'",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LEventBridgeOperations; property is a vi.fn(), never called unbound
    expect(eventBridgeOperations.deleteRule).not.toHaveBeenCalled();
  });

  test("minimal config (no eventBusName, force absent) calls deleteRule with force:false and no eventBusName key", async () => {
    const deleteRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      deleteRule: deleteRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await deleteRule({
      config,
      paths,
      logger,
      correlationId: "run-2",
      eventBridgeOperations,
    });

    expect(deleteRuleMock).toHaveBeenCalledWith("nightly-report", {
      force: false,
    });
    const [, options] = deleteRuleMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(options).not.toHaveProperty("eventBusName");
  });

  test("eventBusName + force:true both set calls deleteRule with both options", async () => {
    const deleteRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      deleteRule: deleteRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventBusName: "custom-bus",
      force: true,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await deleteRule({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    expect(deleteRuleMock).toHaveBeenCalledWith("nightly-report", {
      eventBusName: "custom-bus",
      force: true,
    });
  });

  test("a rejection from eventBridgeOperations.deleteRule propagates unchanged", async () => {
    const operationError = new Error("AccessDenied");
    const deleteRuleMock = vi.fn().mockRejectedValue(operationError);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      deleteRule: deleteRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await deleteRule({
        config,
        paths,
        logger,
        correlationId: "run-4",
        eventBridgeOperations,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(operationError);
  });
});
