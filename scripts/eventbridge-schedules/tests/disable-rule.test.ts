import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { disableRule } from "../src/steps/disable-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `disable-rule`
 * row. Mirrors `enable-rule.test.ts` exactly. Guard-resolves `ruleName`;
 * reads optional `eventBusName`; calls
 * `eventBridgeOperations.disableRule(ruleName, { eventBusName? })`.
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
  readonly disableRule?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    putRule: vi.fn(),
    putTargets: vi.fn(),
    deleteRule: vi.fn(),
    enableRule: vi.fn(),
    disableRule: overrides?.disableRule ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

describe("disableRule", () => {
  test("missing ruleName throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming 'disable'", async () => {
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await disableRule({
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
      "'ruleName' is required for 'disable'",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LEventBridgeOperations; property is a vi.fn(), never called unbound
    expect(eventBridgeOperations.disableRule).not.toHaveBeenCalled();
  });

  test("without eventBusName: calls disableRule with the ruleName and no eventBusName key", async () => {
    const disableRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      disableRule: disableRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await disableRule({
      config,
      paths,
      logger,
      correlationId: "run-2",
      eventBridgeOperations,
    });

    expect(disableRuleMock).toHaveBeenCalledTimes(1);
    const [calledRuleName, options] = disableRuleMock.mock.calls[0] as [
      string,
      Record<string, unknown> | undefined,
    ];
    expect(calledRuleName).toBe("nightly-report");
    expect(options ?? {}).not.toHaveProperty("eventBusName");
  });

  test("with eventBusName: calls disableRule with the ruleName and eventBusName", async () => {
    const disableRuleMock = vi.fn().mockResolvedValue(undefined);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      disableRule: disableRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventBusName: "custom-bus",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await disableRule({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    expect(disableRuleMock).toHaveBeenCalledWith("nightly-report", {
      eventBusName: "custom-bus",
    });
  });
});
