/**
 * Tests for aws/eventbridge submodule.
 *
 * Contract source: docs/reference/aws/eventbridge.md.
 *
 * Exports under test (from `../src/aws/eventbridge/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LEventBridgeOperations, M3LEventBridgeOperationError, and the
 *   M3LEventBridge* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-eventbridge` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/sqs.test.ts`), with a `.send()` spy dispatching by command class.
 * Every command class is a plain recorder (`constructor(input)`), so a test
 * asserting on the command shape reads `h.send.mock.calls[0][0].input`.
 *
 * Retry coverage: every one of the 9 methods wraps its single `.send()` in
 * `M3LRetryRunner`/`M3LPollingPolicies.awsThrottling()`. Per this repo's
 * convention (see `tests/sqs.test.ts`'s sendBatch/deleteBatch retry tests),
 * retry *mechanics* are core/polling's own test suite's job — here we only
 * confirm, once, that a throttling-classified rejection eventually succeeds,
 * and once that exhausted retries surface the typed error with `cause`
 * chained. Every other failure-path test below uses a non-retriable error
 * name (`AccessDenied`) so `send` is called exactly once, keeping the test
 * deterministic without fake timers.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ListRulesCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class PutRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class EnableRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class DisableRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class ListTargetsByRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class PutTargetsCommand {
    constructor(readonly input: unknown) {}
  }
  class RemoveTargetsCommand {
    constructor(readonly input: unknown) {}
  }
  class EventBridgeClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    EventBridgeClient,
    ListRulesCommand,
    DescribeRuleCommand,
    PutRuleCommand,
    DeleteRuleCommand,
    EnableRuleCommand,
    DisableRuleCommand,
    ListTargetsByRuleCommand,
    PutTargetsCommand,
    RemoveTargetsCommand,
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: h.EventBridgeClient,
  ListRulesCommand: h.ListRulesCommand,
  DescribeRuleCommand: h.DescribeRuleCommand,
  PutRuleCommand: h.PutRuleCommand,
  DeleteRuleCommand: h.DeleteRuleCommand,
  EnableRuleCommand: h.EnableRuleCommand,
  DisableRuleCommand: h.DisableRuleCommand,
  ListTargetsByRuleCommand: h.ListTargetsByRuleCommand,
  PutTargetsCommand: h.PutTargetsCommand,
  RemoveTargetsCommand: h.RemoveTargetsCommand,
}));

import type {
  M3LEventBridgePutTargetsResult,
  M3LEventBridgeRemoveTargetsResult,
  M3LEventBridgeRule,
  M3LEventBridgeRuleDetail,
  M3LEventBridgeRuleState,
  M3LEventBridgeTarget,
} from "../src/aws/eventbridge/index.js";
import {
  M3LEventBridgeOperationError,
  M3LEventBridgeOperations,
} from "../src/aws/eventbridge/index.js";

import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";

/** Casts the hoisted fake `EventBridgeClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): EventBridgeClient {
  return new h.EventBridgeClient() as unknown as EventBridgeClient;
}

/** Reads the `input` bag from the Nth recorded `send()` call (0-indexed). */
function commandInput(callIndex = 0): Record<string, unknown> {
  const [command] = h.send.mock.calls[callIndex] as [
    { input: Record<string, unknown> },
  ];
  return command.input;
}

/** A non-retriable, fatal SDK-style error — keeps failure-path tests to exactly one `send()` call. */
function fatalError(message = "denied"): Error {
  return Object.assign(new Error(message), { name: "AccessDenied" });
}

describe("M3LEventBridgeOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  // ===========================================================================
  // listRules()
  // ===========================================================================
  describe("listRules()", () => {
    test("resolves with plain M3LEventBridgeRule[] on a successful ListRules call", async () => {
      h.send.mockResolvedValueOnce({
        Rules: [
          {
            Name: "nightly-report",
            Arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
            ScheduleExpression: "rate(1 day)",
            State: "ENABLED",
          },
        ],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listRules({ namePrefix: "nightly-" });

      expect(result.rules).toEqual([
        {
          name: "nightly-report",
          arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
          scheduleExpression: "rate(1 day)",
          state: "ENABLED",
        },
      ]);
    });

    test("defaults name/arn to '' when the SDK omits them, and omits absent optional fields", async () => {
      h.send.mockResolvedValueOnce({ Rules: [{}] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listRules();

      expect(result.rules).toEqual([{ name: "", arn: "" }]);
    });

    test("resolves rules: [] when Rules is an empty array", async () => {
      h.send.mockResolvedValueOnce({ Rules: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(operations.listRules()).resolves.toEqual({ rules: [] });
    });

    test("resolves rules: [] when the response omits Rules entirely", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(operations.listRules()).resolves.toEqual({ rules: [] });
    });

    test("includes nextToken only when the response's NextToken is present", async () => {
      h.send.mockResolvedValueOnce({ Rules: [], NextToken: "page-2" });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listRules();

      expect(result.nextToken).toBe("page-2");
    });

    test("maps options onto NamePrefix/EventBusName/NextToken/Limit command input", async () => {
      h.send.mockResolvedValueOnce({ Rules: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.listRules({
        namePrefix: "nightly-",
        eventBusName: "custom-bus",
        nextToken: "page-1",
        limit: 25,
      });

      expect(commandInput()).toMatchObject({
        NamePrefix: "nightly-",
        EventBusName: "custom-bus",
        NextToken: "page-1",
        Limit: 25,
      });
    });

    test("does not drain pagination automatically — resolves after exactly one send() even when NextToken is present", async () => {
      h.send.mockResolvedValueOnce({ Rules: [], NextToken: "page-2" });

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.listRules();

      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a ListRules failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.listRules();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // describeRule()
  // ===========================================================================
  describe("describeRule()", () => {
    test("resolves with a plain M3LEventBridgeRuleDetail including createdBy", async () => {
      h.send.mockResolvedValueOnce({
        Name: "nightly-report",
        Arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
        State: "ENABLED",
        CreatedBy: "123456789012",
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.describeRule("nightly-report");

      expect(result).toEqual({
        name: "nightly-report",
        arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
        state: "ENABLED",
        createdBy: "123456789012",
      });
    });

    test("omits createdBy when the SDK response omits CreatedBy", async () => {
      h.send.mockResolvedValueOnce({
        Name: "nightly-report",
        Arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.describeRule("nightly-report");

      expect(result).not.toHaveProperty("createdBy");
    });

    test("sends Name and EventBusName on the DescribeRuleCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.describeRule("nightly-report", {
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        EventBusName: "custom-bus",
      });
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a DescribeRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeRule("nightly-report");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // putRule()
  // ===========================================================================
  describe("putRule()", () => {
    test("resolves with the created rule's ARN on a successful PutRule call", async () => {
      h.send.mockResolvedValueOnce({
        RuleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.putRule({
        name: "nightly-report",
        scheduleExpression: "rate(1 day)",
      });

      expect(result).toEqual({
        ruleArn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
      });
    });

    test("defaults ruleArn to '' when the SDK response omits RuleArn", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.putRule({
        name: "nightly-report",
        scheduleExpression: "rate(1 day)",
      });

      expect(result).toEqual({ ruleArn: "" });
    });

    test("maps the full input onto Name/EventPattern/State/Description/RoleArn/EventBusName", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.putRule({
        name: "nightly-report",
        eventPattern: '{"source":["custom"]}',
        state: "DISABLED",
        description: "runs nightly",
        roleArn: "arn:aws:iam::123456789012:role/invoke-role",
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        EventPattern: '{"source":["custom"]}',
        State: "DISABLED",
        Description: "runs nightly",
        RoleArn: "arn:aws:iam::123456789012:role/invoke-role",
        EventBusName: "custom-bus",
      });
      expect(commandInput()).not.toHaveProperty("ScheduleExpression");
    });

    test("maps the full input onto Name/ScheduleExpression/State/Description/RoleArn/EventBusName", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.putRule({
        name: "nightly-report",
        scheduleExpression: "rate(1 day)",
        state: "DISABLED",
        description: "runs nightly",
        roleArn: "arn:aws:iam::123456789012:role/invoke-role",
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        ScheduleExpression: "rate(1 day)",
        State: "DISABLED",
        Description: "runs nightly",
        RoleArn: "arn:aws:iam::123456789012:role/invoke-role",
        EventBusName: "custom-bus",
      });
      expect(commandInput()).not.toHaveProperty("EventPattern");
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a PutRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putRule({
          name: "nightly-report",
          scheduleExpression: "rate(1 day)",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // deleteRule()
  // ===========================================================================
  describe("deleteRule()", () => {
    test("resolves to undefined on a successful DeleteRule call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.deleteRule("nightly-report"),
      ).resolves.toBeUndefined();
    });

    test("sends Name/EventBusName/Force on the DeleteRuleCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.deleteRule("nightly-report", {
        eventBusName: "custom-bus",
        force: true,
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        EventBusName: "custom-bus",
        Force: true,
      });
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a DeleteRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.deleteRule("nightly-report");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // enableRule()
  // ===========================================================================
  describe("enableRule()", () => {
    test("resolves to undefined on a successful EnableRule call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.enableRule("nightly-report"),
      ).resolves.toBeUndefined();
    });

    test("sends Name/EventBusName on the EnableRuleCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.enableRule("nightly-report", {
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        EventBusName: "custom-bus",
      });
    });

    test("rejects M3LEventBridgeOperationError with cause chained on an EnableRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.enableRule("nightly-report");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // disableRule()
  // ===========================================================================
  describe("disableRule()", () => {
    test("resolves to undefined on a successful DisableRule call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.disableRule("nightly-report"),
      ).resolves.toBeUndefined();
    });

    test("sends Name/EventBusName on the DisableRuleCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.disableRule("nightly-report", {
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Name: "nightly-report",
        EventBusName: "custom-bus",
      });
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a DisableRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.disableRule("nightly-report");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // listTargetsByRule()
  // ===========================================================================
  describe("listTargetsByRule()", () => {
    test("resolves with plain M3LEventBridgeTarget[] on a successful ListTargetsByRule call", async () => {
      h.send.mockResolvedValueOnce({
        Targets: [
          {
            Id: "target-1",
            Arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
            RoleArn: "arn:aws:iam::123456789012:role/invoke-role",
            Input: '{"foo":"bar"}',
          },
        ],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listTargetsByRule("nightly-report");

      expect(result.targets).toEqual([
        {
          id: "target-1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
          roleArn: "arn:aws:iam::123456789012:role/invoke-role",
          input: '{"foo":"bar"}',
        },
      ]);
    });

    test("defaults id/arn to '' when the SDK omits them, and omits absent optional fields", async () => {
      h.send.mockResolvedValueOnce({ Targets: [{}] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listTargetsByRule("nightly-report");

      expect(result.targets).toEqual([{ id: "", arn: "" }]);
    });

    test("resolves targets: [] when the response omits Targets entirely", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.listTargetsByRule("nightly-report"),
      ).resolves.toEqual({ targets: [] });
    });

    test("includes nextToken only when the response's NextToken is present", async () => {
      h.send.mockResolvedValueOnce({ Targets: [], NextToken: "page-2" });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.listTargetsByRule("nightly-report");

      expect(result.nextToken).toBe("page-2");
    });

    test("maps ruleName/options onto Rule/EventBusName/NextToken/Limit command input", async () => {
      h.send.mockResolvedValueOnce({ Targets: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.listTargetsByRule("nightly-report", {
        eventBusName: "custom-bus",
        nextToken: "page-1",
        limit: 25,
      });

      expect(commandInput()).toEqual({
        Rule: "nightly-report",
        EventBusName: "custom-bus",
        NextToken: "page-1",
        Limit: 25,
      });
    });

    test("does not drain pagination automatically — resolves after exactly one send() even when NextToken is present", async () => {
      h.send.mockResolvedValueOnce({ Targets: [], NextToken: "page-2" });

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.listTargetsByRule("nightly-report");

      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a ListTargetsByRule failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.listTargetsByRule("nightly-report");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // putTargets()
  // ===========================================================================
  describe("putTargets()", () => {
    test("throws M3LEventBridgeOperationError before any AWS call when given more than 10 targets", async () => {
      const operations = new M3LEventBridgeOperations(fakeClient());
      const tooManyTargets: M3LEventBridgeTarget[] = Array.from(
        { length: 11 },
        (_unused, index) => ({
          id: String(index),
          arn: `arn:aws:lambda:eu-south-1:123456789012:function:fn-${String(index)}`,
        }),
      );

      await expect(
        operations.putTargets("nightly-report", tooManyTargets),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("throws M3LEventBridgeOperationError before any AWS call on a duplicate target id", async () => {
      const operations = new M3LEventBridgeOperations(fakeClient());
      const duplicateIdTargets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
        },
      ];

      await expect(
        operations.putTargets("nightly-report", duplicateIdTargets),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("does NOT reject an empty targets array as malformed — calls send with an empty Targets list", async () => {
      h.send.mockResolvedValueOnce({ FailedEntries: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.putTargets("nightly-report", []);

      expect(result).toEqual({ successful: [], failed: [] });
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("sends Rule/EventBusName/Targets (Id/Arn/RoleArn/Input/InputPath) on the PutTargetsCommand input", async () => {
      h.send.mockResolvedValueOnce({ FailedEntries: [] });
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "target-1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
          roleArn: "arn:aws:iam::123456789012:role/invoke-role",
          input: '{"foo":"bar"}',
          inputPath: "$.detail",
        },
      ];

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.putTargets("nightly-report", targets, {
        eventBusName: "custom-bus",
      });

      expect(commandInput()).toEqual({
        Rule: "nightly-report",
        EventBusName: "custom-bus",
        Targets: [
          {
            Id: "target-1",
            Arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
            RoleArn: "arn:aws:iam::123456789012:role/invoke-role",
            Input: '{"foo":"bar"}',
            InputPath: "$.detail",
          },
        ],
      });
    });

    test("all-success: every input target lands in successful[], failed is empty", async () => {
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
        {
          id: "1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
        },
      ];
      h.send.mockResolvedValueOnce({ FailedEntries: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.putTargets("nightly-report", targets);

      expect(result.successful).toEqual(targets);
      expect(result.failed).toEqual([]);
    });

    test("partial FailedEntries: joins each failure back to the original input target, mapping code/message; every target lands in exactly one bucket", async () => {
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
        {
          id: "1",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1",
        },
      ];
      h.send.mockResolvedValueOnce({
        FailedEntries: [
          {
            TargetId: "1",
            ErrorCode: "ConcurrentModificationException",
            ErrorMessage: "too many requests",
          },
        ],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result: M3LEventBridgePutTargetsResult =
        await operations.putTargets("nightly-report", targets);

      expect(result.successful).toEqual([targets[0]]);
      expect(result.failed).toEqual([
        {
          target: targets[1],
          code: "ConcurrentModificationException",
          message: "too many requests",
        },
      ]);
      // Every input target lands in exactly one bucket.
      expect(result.successful.length + result.failed.length).toBe(
        targets.length,
      );
    });

    test("defaults a failure's code to '' when ErrorCode is absent, and omits message when ErrorMessage is absent", async () => {
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
      ];
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ TargetId: "0" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.putTargets("nightly-report", targets);

      expect(result.failed).toEqual([{ target: targets[0], code: "" }]);
    });

    test("orphaned FailedEntries (TargetId does not match any input id) throws M3LEventBridgeOperationError rather than being silently dropped", async () => {
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
      ];
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ TargetId: "nonexistent-id", ErrorCode: "SomeError" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putTargets("nightly-report", targets);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
    });

    test("orphaned FailedEntries (TargetId omitted entirely) throws M3LEventBridgeOperationError rather than being silently dropped", async () => {
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
      ];
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ ErrorCode: "SomeError" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.putTargets("nightly-report", targets),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a whole-request PutTargets failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);
      const targets: M3LEventBridgeTarget[] = [
        {
          id: "0",
          arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0",
        },
      ];

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putTargets("nightly-report", targets);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // removeTargets()
  // ===========================================================================
  describe("removeTargets()", () => {
    test("throws M3LEventBridgeOperationError before any AWS call when given more than 10 ids", async () => {
      const operations = new M3LEventBridgeOperations(fakeClient());
      const tooManyIds = Array.from({ length: 11 }, (_unused, index) =>
        String(index),
      );

      await expect(
        operations.removeTargets("nightly-report", tooManyIds),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("throws M3LEventBridgeOperationError before any AWS call on a duplicate id", async () => {
      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.removeTargets("nightly-report", ["dup", "dup"]),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("does NOT reject an empty ids array as malformed — calls send with an empty Ids list", async () => {
      h.send.mockResolvedValueOnce({ FailedEntries: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.removeTargets("nightly-report", []);

      expect(result).toEqual({ successful: [], failed: [] });
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("sends Rule/Ids/EventBusName/Force on the RemoveTargetsCommand input", async () => {
      h.send.mockResolvedValueOnce({ FailedEntries: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      await operations.removeTargets("nightly-report", ["0", "1"], {
        eventBusName: "custom-bus",
        force: true,
      });

      expect(commandInput()).toEqual({
        Rule: "nightly-report",
        Ids: ["0", "1"],
        EventBusName: "custom-bus",
        Force: true,
      });
    });

    test("all-success: every input id lands in successful[] (bare strings), failed is empty", async () => {
      h.send.mockResolvedValueOnce({ FailedEntries: [] });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.removeTargets("nightly-report", [
        "0",
        "1",
      ]);

      expect(result.successful).toEqual(["0", "1"]);
      expect(result.failed).toEqual([]);
    });

    test("partial FailedEntries: joins each failure back to the original input id, mapping code/message; every id lands in exactly one bucket", async () => {
      h.send.mockResolvedValueOnce({
        FailedEntries: [
          {
            TargetId: "1",
            ErrorCode: "ConcurrentModificationException",
            ErrorMessage: "too many requests",
          },
        ],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result: M3LEventBridgeRemoveTargetsResult =
        await operations.removeTargets("nightly-report", ["0", "1"]);

      expect(result.successful).toEqual(["0"]);
      expect(result.failed).toEqual([
        {
          targetId: "1",
          code: "ConcurrentModificationException",
          message: "too many requests",
        },
      ]);
      expect(result.successful.length + result.failed.length).toBe(2);
    });

    test("defaults a failure's code to '' when ErrorCode is absent, and omits message when ErrorMessage is absent", async () => {
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ TargetId: "0" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());
      const result = await operations.removeTargets("nightly-report", ["0"]);

      expect(result.failed).toEqual([{ targetId: "0", code: "" }]);
    });

    test("orphaned FailedEntries (TargetId does not match any input id) throws M3LEventBridgeOperationError rather than being silently dropped", async () => {
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ TargetId: "nonexistent-id", ErrorCode: "SomeError" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.removeTargets("nightly-report", ["0"]),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
    });

    test("orphaned FailedEntries (TargetId omitted entirely) throws M3LEventBridgeOperationError rather than being silently dropped", async () => {
      h.send.mockResolvedValueOnce({
        FailedEntries: [{ ErrorCode: "SomeError" }],
      });

      const operations = new M3LEventBridgeOperations(fakeClient());

      await expect(
        operations.removeTargets("nightly-report", ["0"]),
      ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
    });

    test("rejects M3LEventBridgeOperationError with cause chained on a whole-request RemoveTargets failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LEventBridgeOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.removeTargets("nightly-report", ["0"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
      expect((thrown as M3LEventBridgeOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // Cross-cutting retry behavior — deliberately minimal (core/polling owns
  // retry mechanics); one success-after-retry case and one exhausted-retries
  // case, on two different methods, is enough coverage per this repo's
  // convention (see the file header comment).
  // ===========================================================================
  describe("retry behavior (awsThrottling policy)", () => {
    test("listRules() retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({ Rules: [] });

        const operations = new M3LEventBridgeOperations(fakeClient());

        let result:
          Awaited<ReturnType<typeof operations.listRules>> | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.listRules();
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result).toEqual({ rules: [] });
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("putRule() exhausts retries and rejects M3LEventBridgeOperationError with cause=throttle error after 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LEventBridgeOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.putRule({
              name: "nightly-report",
              scheduleExpression: "rate(1 day)",
            });
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LEventBridgeOperationError);
        expect((thrown as M3LEventBridgeOperationError).cause).toBe(
          throttleError,
        );
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // Type-level contracts
  // ===========================================================================
  describe("type-level contracts", () => {
    test("M3LEventBridgeRule has the documented required name/arn shape", () => {
      expectTypeOf<M3LEventBridgeRule>()
        .toHaveProperty("name")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LEventBridgeRule>()
        .toHaveProperty("arn")
        .toEqualTypeOf<string>();
    });

    test("M3LEventBridgeRuleDetail extends M3LEventBridgeRule with an optional createdBy", () => {
      expectTypeOf<M3LEventBridgeRuleDetail>().toMatchTypeOf<M3LEventBridgeRule>();
      expectTypeOf<M3LEventBridgeRuleDetail>()
        .toHaveProperty("createdBy")
        .toEqualTypeOf<string | undefined>();
    });

    test("M3LEventBridgeRuleState is the documented three-member union", () => {
      expectTypeOf<M3LEventBridgeRuleState>().toEqualTypeOf<
        "DISABLED" | "ENABLED" | "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
      >();
    });

    test("asymmetry: putTargets().successful holds full M3LEventBridgeTarget objects, removeTargets().successful holds bare string ids", () => {
      expectTypeOf<
        M3LEventBridgePutTargetsResult["successful"]
      >().toEqualTypeOf<readonly M3LEventBridgeTarget[]>();
      expectTypeOf<
        M3LEventBridgeRemoveTargetsResult["successful"]
      >().toEqualTypeOf<readonly string[]>();
    });
  });
});
