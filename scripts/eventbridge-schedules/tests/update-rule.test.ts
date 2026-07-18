import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { updateRule } from "../src/steps/update-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `update-rule`
 * row. `updateRule(deps)` is a thin delegate to the shared `putRuleStep`
 * helper (`src/steps/put-rule.ts`, tested exhaustively in
 * `put-rule.test.ts`) called with `operation: "update"`. This file only
 * confirms the delegation is wired correctly, not the full guard/branch
 * matrix — that lives in `put-rule.test.ts`.
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
  readonly putRule?: ReturnType<typeof vi.fn>;
  readonly putTargets?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    putRule:
      overrides?.putRule ??
      vi.fn().mockResolvedValue({
        ruleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
      }),
    putTargets:
      overrides?.putTargets ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
    deleteRule: vi.fn(),
    enableRule: vi.fn(),
    disableRule: vi.fn(),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

describe("updateRule", () => {
  test("happy path with scheduleExpression: calls putRule with name+scheduleExpression, no eventPattern key", async () => {
    const putRule = vi.fn().mockResolvedValue({
      ruleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
    });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await updateRule({
      config,
      paths,
      logger,
      correlationId: "run-1",
      eventBridgeOperations,
    });

    expect(putRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nightly-report",
        scheduleExpression: "rate(1 day)",
      }),
    );
    const [input] = putRule.mock.calls[0] as [Record<string, unknown>];
    expect(input).not.toHaveProperty("eventPattern");
  });

  test("missing ruleName throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming 'update'", async () => {
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const config = buildConfig({
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await updateRule({
        config,
        paths,
        logger,
        correlationId: "run-2",
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
      "'ruleName' is required for 'update'",
    );
  });

  test("happy path with targets attached also calls putTargets for the updated rule", async () => {
    const putRule = vi.fn().mockResolvedValue({
      ruleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
    });
    const putTargets = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule,
      putTargets,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: JSON.stringify([
        {
          id: "target-1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
        },
      ]),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await updateRule({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    const [calledRuleName, calledTargets] = putTargets.mock.calls[0] as [
      string,
      readonly AWS.M3LEventBridgeTarget[],
    ];
    expect(calledRuleName).toBe("nightly-report");
    expect(calledTargets).toEqual([
      {
        id: "target-1",
        arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
      },
    ]);
  });
});
