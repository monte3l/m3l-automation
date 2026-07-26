import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { readStackEvents } from "../src/steps/read-stack-events.js";
import { createFakeCloudFormationOperations } from "./support/cloudformationFakes.js";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md
 * `read-stack-events` row — `describe-stack-events`
 * (`describeStackEvents(stackName, { nextToken })`), never gated,
 * read-only. Returns the raw `M3LCloudFormationDescribeStackEventsResult`
 * unchanged.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readStackEvents", () => {
  test("calls operations.describeStackEvents(stackName, { nextToken }) and returns the result unchanged", async () => {
    const result: AWS.M3LCloudFormationDescribeStackEventsResult = {
      stackEvents: [{ stackId: "id", eventId: "evt-1", stackName: "my-stack" }],
      nextToken: "next-token",
    };
    const describeStackEvents = vi.fn().mockResolvedValue(result);
    const operations = createFakeCloudFormationOperations({
      describeStackEvents,
    });

    const returned = await readStackEvents({
      operations,
      stackName: "my-stack",
      nextToken: "prev-token",
    });

    expect(describeStackEvents).toHaveBeenCalledWith(
      "my-stack",
      expect.objectContaining({ nextToken: "prev-token" }),
    );
    expect(returned).toEqual(result);
  });

  test("omits nextToken from the options object when unset", async () => {
    const describeStackEvents = vi.fn().mockResolvedValue({ stackEvents: [] });
    const operations = createFakeCloudFormationOperations({
      describeStackEvents,
    });

    await readStackEvents({
      operations,
      stackName: "my-stack",
      nextToken: undefined,
    });

    const call = describeStackEvents.mock.calls[0] as [
      string,
      { nextToken?: string }?,
    ];
    expect(call[1]?.nextToken).toBeUndefined();
  });

  test("propagates a rejection from describeStackEvents unchanged", async () => {
    const cause = new Error("DescribeStackEvents failed");
    const describeStackEvents = vi.fn().mockRejectedValue(cause);
    const operations = createFakeCloudFormationOperations({
      describeStackEvents,
    });

    await expect(
      readStackEvents({
        operations,
        stackName: "my-stack",
        nextToken: undefined,
      }),
    ).rejects.toBe(cause);
  });
});

describe("type contract", () => {
  test("readStackEvents resolves M3LCloudFormationDescribeStackEventsResult", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof readStackEvents>>
    >().toEqualTypeOf<AWS.M3LCloudFormationDescribeStackEventsResult>();
  });

  test("readStackEvents's deps shape is exactly operations/stackName/nextToken", () => {
    expectTypeOf<Parameters<typeof readStackEvents>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCloudFormationOperations;
      readonly stackName: string;
      readonly nextToken: string | undefined;
    }>();
  });
});
