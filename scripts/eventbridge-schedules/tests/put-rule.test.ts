import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { putRuleStep } from "../src/steps/put-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `create-rule` /
 * `update-rule` row — both delegate to the shared internal `putRuleStep`
 * helper, which:
 *  - guard-requires `ruleName`, else throws `Core.M3LError` coded
 *    `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` with message
 *    `'ruleName' is required for '${operation}'`;
 *  - guard-requires EXACTLY ONE of `eventPattern`/`scheduleExpression` (empty
 *    string treated as unset), else throws the same code with message
 *    `exactly one of 'eventPattern' or 'scheduleExpression' is required for
 *    '${operation}'`;
 *  - calls `eventBridgeOperations.putRule({ name, eventPattern|
 *    scheduleExpression, state?, description?, roleArn?, eventBusName? })`,
 *    only including the branch discriminant that was configured, and only
 *    the optional fields actually set;
 *  - when `targets` (a JSON string) is configured, parses it as an array of
 *    `{ id, arn, roleArn?, input?, inputPath? }` and calls
 *    `putTargets(ruleName, parsedTargets, {...})` after a successful
 *    `putRule`; malformed/non-array/invalid-entry JSON throws the same
 *    config-error code with message `'targets' must be a JSON array of {
 *    id, arn, roleArn?, input?, inputPath? }`;
 *  - never throws on a per-entry `putTargets` failure (`failed[]` non-empty)
 *    — logs a warning instead;
 *  - a thrown `AWS.M3LEventBridgeOperationError` from `putTargets` itself
 *    propagates unmodified.
 */

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/**
 * Builds a structural fake of `AWS.M3LEventBridgeOperations`, mocking only
 * `putRule`/`putTargets` (the two methods this step reads).
 * `M3LEventBridgeOperations` is a concrete class with a private client field,
 * so a plain object literal is cast through `unknown` — the same pattern
 * `api-gateway-client`'s `httpFakes.ts` uses for `Core.M3LHttpClient`.
 */
function createFakeEventBridgeOperations(overrides: {
  readonly putRule?: ReturnType<typeof vi.fn>;
  readonly putTargets?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    putRule: overrides.putRule ?? vi.fn().mockResolvedValue({ ruleArn: "" }),
    putTargets:
      overrides.putTargets ??
      vi.fn().mockResolvedValue({ successful: [], failed: [] }),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

const RULE_ARN = "arn:aws:events:eu-south-1:123456789012:rule/nightly-report";

/** Reads the Nth call's first argument off a `vi.fn()` mock as a typed record. */
function callArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[callIndex] as
    [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error("mock was not called");
  return call[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("putRuleStep — guard-required ruleName", () => {
  test.each(["create", "update"] as const)(
    "throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG naming the '%s' verb when ruleName is missing, never calling putRule",
    async (operation) => {
      const putRuleMock = vi.fn();
      const eventBridgeOperations = createFakeEventBridgeOperations({
        putRule: putRuleMock,
      });
      const config = buildConfig({ scheduleExpression: "rate(1 day)" });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);

      let thrown: unknown;
      try {
        await putRuleStep(
          {
            config,
            paths,
            logger,
            correlationId: "run-1",
            eventBridgeOperations,
          },
          operation,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
      );
      expect((thrown as Core.M3LError).message).toBe(
        `'ruleName' is required for '${operation}'`,
      );
      expect(putRuleMock).not.toHaveBeenCalled();
    },
  );
});

describe("putRuleStep — exactly-one guard (eventPattern/scheduleExpression)", () => {
  test("throws when BOTH eventPattern and scheduleExpression are set ('create')", async () => {
    const putRuleMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventPattern: '{"source":["custom"]}',
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-2",
          eventBridgeOperations,
        },
        "create",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "exactly one of 'eventPattern' or 'scheduleExpression' is required for 'create'",
    );
    expect(putRuleMock).not.toHaveBeenCalled();
  });

  test("throws when NEITHER eventPattern nor scheduleExpression is set ('create')", async () => {
    const putRuleMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-3",
          eventBridgeOperations,
        },
        "create",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "exactly one of 'eventPattern' or 'scheduleExpression' is required for 'create'",
    );
    expect(putRuleMock).not.toHaveBeenCalled();
  });

  test("treats empty-string eventPattern/scheduleExpression as unset — throws the NEITHER-set error for 'update'", async () => {
    const putRuleMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventPattern: "",
      scheduleExpression: "",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-4",
          eventBridgeOperations,
        },
        "update",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "exactly one of 'eventPattern' or 'scheduleExpression' is required for 'update'",
    );
    expect(putRuleMock).not.toHaveBeenCalled();
  });
});

describe("putRuleStep — happy path", () => {
  test("eventPattern branch: calls putRule with name+eventPattern, no scheduleExpression key present", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventPattern: '{"source":["custom"]}',
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-5", eventBridgeOperations },
      "create",
    );

    const arg = callArg(putRuleMock);
    expect(arg).toMatchObject({
      name: "nightly-report",
      eventPattern: '{"source":["custom"]}',
    });
    expect(arg).not.toHaveProperty("scheduleExpression");
  });

  test("scheduleExpression branch: calls putRule with name+scheduleExpression, no eventPattern key present", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-6", eventBridgeOperations },
      "update",
    );

    const arg = callArg(putRuleMock);
    expect(arg).toMatchObject({
      name: "nightly-report",
      scheduleExpression: "rate(1 day)",
    });
    expect(arg).not.toHaveProperty("eventPattern");
  });
});

describe("putRuleStep — optional fields (state/description/roleArn/eventBusName)", () => {
  test("includes state/description/roleArn/eventBusName in the putRule call when configured", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      state: "DISABLED",
      description: "runs nightly",
      roleArn: "arn:aws:iam::123456789012:role/invoke-role",
      eventBusName: "custom-bus",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-7", eventBridgeOperations },
      "create",
    );

    const arg = callArg(putRuleMock);
    expect(arg).toEqual({
      name: "nightly-report",
      scheduleExpression: "rate(1 day)",
      state: "DISABLED",
      description: "runs nightly",
      roleArn: "arn:aws:iam::123456789012:role/invoke-role",
      eventBusName: "custom-bus",
    });
  });

  test("omits state/description/roleArn/eventBusName keys entirely (not undefined-valued) when unset", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-8", eventBridgeOperations },
      "create",
    );

    const arg = callArg(putRuleMock);
    expect(Object.keys(arg).sort()).toEqual(
      ["name", "scheduleExpression"].sort(),
    );
  });
});

describe("putRuleStep — targets attach convenience", () => {
  test("valid JSON array of targets calls putTargets with the parsed array after a successful putRule", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const putTargetsMock = vi
      .fn()
      .mockResolvedValue({ successful: [], failed: [] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const targets: readonly AWS.M3LEventBridgeTarget[] = [
      {
        id: "target-1",
        arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
      },
    ];
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: JSON.stringify(targets),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-9", eventBridgeOperations },
      "create",
    );

    expect(putTargetsMock).toHaveBeenCalledWith(
      "nightly-report",
      targets,
      expect.anything(),
    );
  });

  test("does not call putTargets when 'targets' is unset entirely", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const putTargetsMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await putRuleStep(
      { config, paths, logger, correlationId: "run-10", eventBridgeOperations },
      "create",
    );

    expect(putTargetsMock).not.toHaveBeenCalled();
  });

  test("malformed (unparseable) JSON throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG chaining the SyntaxError as cause", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const putTargetsMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: "{not valid json",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-11",
          eventBridgeOperations,
        },
        "create",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "'targets' must be a JSON array of { id, arn, roleArn?, input?, inputPath? }",
    );
    expect((thrown as Core.M3LError).cause).toBeInstanceOf(SyntaxError);
    expect(putTargetsMock).not.toHaveBeenCalled();
  });

  test("non-array JSON (e.g. '{}') throws the same ERR_EVENTBRIDGE_SCHEDULES_CONFIG error", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const putTargetsMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: "{}",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-12",
          eventBridgeOperations,
        },
        "create",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "'targets' must be a JSON array of { id, arn, roleArn?, input?, inputPath? }",
    );
    expect(putTargetsMock).not.toHaveBeenCalled();
  });

  test("an entry missing 'id' throws the same ERR_EVENTBRIDGE_SCHEDULES_CONFIG error", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const putTargetsMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: JSON.stringify([
        { arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1" },
      ]),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-13",
          eventBridgeOperations,
        },
        "create",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "'targets' must be a JSON array of { id, arn, roleArn?, input?, inputPath? }",
    );
    expect(putTargetsMock).not.toHaveBeenCalled();
  });

  test("resolves normally and logs a warning when putTargets resolves with a non-empty failed[] (never throws)", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const failedTarget: AWS.M3LEventBridgeTarget = {
      id: "target-1",
      arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
    };
    const putTargetsMock = vi.fn().mockResolvedValue({
      successful: [],
      failed: [
        {
          target: failedTarget,
          code: "ConcurrentModificationException",
          message: "too many requests",
        },
      ],
    });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: JSON.stringify([failedTarget]),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    await expect(
      putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-14",
          eventBridgeOperations,
        },
        "create",
      ),
    ).resolves.toBeUndefined();

    expect(warningSpy).toHaveBeenCalled();
  });

  test("propagates an AWS.M3LEventBridgeOperationError thrown by putTargets unmodified", async () => {
    const putRuleMock = vi.fn().mockResolvedValue({ ruleArn: RULE_ARN });
    const operationError = new Error("PutTargets failed");
    const putTargetsMock = vi.fn().mockRejectedValue(operationError);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      putRule: putRuleMock,
      putTargets: putTargetsMock,
    });
    const target: AWS.M3LEventBridgeTarget = {
      id: "target-1",
      arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
    };
    const config = buildConfig({
      ruleName: "nightly-report",
      scheduleExpression: "rate(1 day)",
      targets: JSON.stringify([target]),
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      putRuleStep(
        {
          config,
          paths,
          logger,
          correlationId: "run-15",
          eventBridgeOperations,
        },
        "create",
      ),
    ).rejects.toBe(operationError);
  });
});
