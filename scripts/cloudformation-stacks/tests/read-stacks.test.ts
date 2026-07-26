import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readStacks } from "../src/steps/read-stacks.js";
import { createFakeCloudFormationOperations } from "./support/cloudformationFakes.js";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md `read-stacks`
 * row — `list-stacks` (`listStacks({ stackStatusFilter, nextToken })`) and
 * `describe-stack` (`describeStack(stackName)`), never gated. Returns the
 * raw `M3LCloudFormationListStacksResult` / `M3LCloudFormationStack |
 * undefined` unchanged. Per the doc, `ERR_CLOUDFORMATION_STACKS_NOT_FOUND`
 * is the dispatcher's job, not this step's — this step must NOT throw when
 * `describeStack` resolves `undefined`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readStacks — list-stacks", () => {
  test("calls operations.listStacks({ stackStatusFilter, nextToken }) and returns the result unchanged", async () => {
    const result: AWS.M3LCloudFormationListStacksResult = {
      stackSummaries: [
        { stackName: "my-stack", stackStatus: "CREATE_COMPLETE" },
      ],
      nextToken: "next-token",
    };
    const listStacks = vi.fn().mockResolvedValue(result);
    const operations = createFakeCloudFormationOperations({ listStacks });

    const returned = await readStacks({
      operations,
      operation: "list-stacks",
      stackName: undefined,
      stackStatusFilter: ["CREATE_COMPLETE"],
      nextToken: "prev-token",
    });

    expect(listStacks).toHaveBeenCalledTimes(1);
    const call = listStacks.mock.calls[0] as [
      { stackStatusFilter?: readonly string[]; nextToken?: string }?,
    ];
    expect(call[0]?.stackStatusFilter).toEqual(["CREATE_COMPLETE"]);
    expect(call[0]?.nextToken).toBe("prev-token");
    expect(returned).toEqual(result);
  });

  test("omits stackStatusFilter/nextToken from the call when unset", async () => {
    const listStacks = vi.fn().mockResolvedValue({ stackSummaries: [] });
    const operations = createFakeCloudFormationOperations({ listStacks });

    await readStacks({
      operations,
      operation: "list-stacks",
      stackName: undefined,
      stackStatusFilter: undefined,
      nextToken: undefined,
    });

    const call = listStacks.mock.calls[0] as [
      { stackStatusFilter?: readonly string[]; nextToken?: string }?,
    ];
    expect(call[0]?.stackStatusFilter).toBeUndefined();
    expect(call[0]?.nextToken).toBeUndefined();
  });
});

describe("readStacks — describe-stack", () => {
  test("calls operations.describeStack(stackName) and returns the description unchanged", async () => {
    const stack: AWS.M3LCloudFormationStack = {
      stackName: "my-stack",
      stackStatus: "CREATE_COMPLETE",
    };
    const describeStack = vi.fn().mockResolvedValue(stack);
    const operations = createFakeCloudFormationOperations({ describeStack });

    const returned = await readStacks({
      operations,
      operation: "describe-stack",
      stackName: "my-stack",
      stackStatusFilter: undefined,
      nextToken: undefined,
    });

    expect(describeStack).toHaveBeenCalledWith("my-stack");
    expect(returned).toEqual(stack);
  });

  test("returns undefined without throwing when describeStack resolves undefined (dispatcher's job to classify NOT_FOUND, not this step's)", async () => {
    const describeStack = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCloudFormationOperations({ describeStack });

    const returned = await readStacks({
      operations,
      operation: "describe-stack",
      stackName: "missing-stack",
      stackStatusFilter: undefined,
      nextToken: undefined,
    });

    expect(returned).toBeUndefined();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when stackName is undefined, never calling describeStack", async () => {
    const describeStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ describeStack });

    let thrown: unknown;
    try {
      await readStacks({
        operations,
        operation: "describe-stack",
        stackName: undefined,
        stackStatusFilter: undefined,
        nextToken: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_CLOUDFORMATION_STACKS_CONFIG",
    );
    expect(describeStack).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("readStacks resolves the list-or-describe result union", () => {
    expectTypeOf<Awaited<ReturnType<typeof readStacks>>>().toEqualTypeOf<
      | AWS.M3LCloudFormationListStacksResult
      | AWS.M3LCloudFormationStack
      | undefined
    >();
  });

  test("readStacks's deps shape is exactly operations/operation/stackName/stackStatusFilter/nextToken", () => {
    expectTypeOf<Parameters<typeof readStacks>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCloudFormationOperations;
      readonly operation: "list-stacks" | "describe-stack";
      readonly stackName: string | undefined;
      readonly stackStatusFilter: readonly string[] | undefined;
      readonly nextToken: string | undefined;
    }>();
  });
});
