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
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LEventBridgeOperations`'s
 * methods currently throw `M3LEventBridgeOperationError("... not yet
 * implemented")` (see src/aws/eventbridge/client.ts). `implementing-submodules`
 * turns them GREEN.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ListRulesCommand {
    constructor(readonly input: unknown) {}
  }
  class PutRuleCommand {
    constructor(readonly input: unknown) {}
  }
  class PutTargetsCommand {
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
    PutRuleCommand,
    PutTargetsCommand,
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: h.EventBridgeClient,
  ListRulesCommand: h.ListRulesCommand,
  PutRuleCommand: h.PutRuleCommand,
  PutTargetsCommand: h.PutTargetsCommand,
}));

import type {
  M3LEventBridgeRule,
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

describe("M3LEventBridgeOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  test("listRules() resolves with plain M3LEventBridgeRule[] on a successful ListRules call", async () => {
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
      expect.objectContaining({
        name: "nightly-report",
        arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
        scheduleExpression: "rate(1 day)",
        state: "ENABLED",
      }),
    ]);
  });

  test("putRule() resolves with the created rule's ARN on a successful PutRule call", async () => {
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

  test("putTargets() throws M3LEventBridgeOperationError before any AWS call when given more than 10 targets", async () => {
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
    ).rejects.toThrow(/at most 10 entries/);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("putTargets() rejects with M3LEventBridgeOperationError (not a bare Error) on a malformed batch", async () => {
    const operations = new M3LEventBridgeOperations(fakeClient());
    const duplicateIdTargets: M3LEventBridgeTarget[] = [
      { id: "0", arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-0" },
      { id: "0", arn: "arn:aws:lambda:eu-south-1:123456789012:function:fn-1" },
    ];

    await expect(
      operations.putTargets("nightly-report", duplicateIdTargets),
    ).rejects.toBeInstanceOf(M3LEventBridgeOperationError);
  });

  test("M3LEventBridgeRule has the documented plain shape", () => {
    expectTypeOf<M3LEventBridgeRule>()
      .toHaveProperty("name")
      .toEqualTypeOf<string>();
    expectTypeOf<M3LEventBridgeRule>()
      .toHaveProperty("arn")
      .toEqualTypeOf<string>();
  });
});
