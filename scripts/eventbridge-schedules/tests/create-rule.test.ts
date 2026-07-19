import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { createRule } from "../src/steps/create-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `create-rule`
 * row. `createRule(deps)` is a thin delegate to the shared `putRuleStep`
 * helper (`src/steps/put-rule.ts`, tested exhaustively in
 * `put-rule.test.ts`) called with `operation: "create"`. This file only
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

describe("createRule", () => {
  test("happy path with eventPattern: calls putRule with name+eventPattern, no scheduleExpression key", async () => {
    const putRule = vi.fn().mockResolvedValue({
      ruleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
    });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventPattern: '{"source":["custom"]}',
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await createRule({
      config,
      paths,
      logger,
      correlationId: "run-1",
      eventBridgeOperations,
    });

    expect(putRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nightly-report",
        eventPattern: '{"source":["custom"]}',
      }),
    );
    const [input] = putRule.mock.calls[0] as [Record<string, unknown>];
    expect(input).not.toHaveProperty("scheduleExpression");
  });

  test("missing ruleName throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming 'create'", async () => {
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const config = buildConfig({
      eventPattern: '{"source":["custom"]}',
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await createRule({
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
      "'ruleName' is required for 'create'",
    );
  });

  test("happy path with targets attached also calls putTargets for the created rule", async () => {
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
      eventPattern: '{"source":["custom"]}',
      targets: JSON.stringify([
        {
          id: "target-1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
        },
      ]),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await createRule({
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
