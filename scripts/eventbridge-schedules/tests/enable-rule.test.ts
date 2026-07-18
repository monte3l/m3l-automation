import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { enableRule } from "../src/steps/enable-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `enable-rule`
 * row. Guard-resolves `ruleName`; reads optional `eventBusName`; calls
 * `eventBridgeOperations.enableRule(ruleName, { eventBusName? })`.
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
  readonly enableRule?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    putRule: vi.fn(),
    putTargets: vi.fn(),
    deleteRule: vi.fn(),
    enableRule: overrides?.enableRule ?? vi.fn().mockResolvedValue(undefined),
    disableRule: vi.fn(),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

describe("enableRule", () => {
  test("missing ruleName throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming 'enable'", async () => {
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await enableRule({
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
      "'ruleName' is required for 'enable'",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LEventBridgeOperations; property is a vi.fn(), never called unbound
    expect(eventBridgeOperations.enableRule).not.toHaveBeenCalled();
  });

  test("without eventBusName: calls enableRule with the ruleName and no eventBusName key", async () => {
    const enableRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      enableRule: enableRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await enableRule({
      config,
      paths,
      logger,
      correlationId: "run-2",
      eventBridgeOperations,
    });

    expect(enableRuleMock).toHaveBeenCalledTimes(1);
    const [calledRuleName, options] = enableRuleMock.mock.calls[0] as [
      string,
      Record<string, unknown> | undefined,
    ];
    expect(calledRuleName).toBe("nightly-report");
    expect(options ?? {}).not.toHaveProperty("eventBusName");
  });

  test("with eventBusName: calls enableRule with the ruleName and eventBusName", async () => {
    const enableRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      enableRule: enableRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventBusName: "custom-bus",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await enableRule({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    expect(enableRuleMock).toHaveBeenCalledWith("nightly-report", {
      eventBusName: "custom-bus",
    });
  });
});
