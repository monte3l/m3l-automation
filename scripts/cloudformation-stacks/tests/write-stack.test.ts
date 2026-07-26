import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { writeStack } from "../src/steps/write-stack.js";
import { createFakeCloudFormationOperations } from "./support/cloudformationFakes.js";

/**
 * Contract: docs/reference/scripts/cloudformation-stacks.md `write-stack`
 * row. Handles `create-stack`/`update-stack`/`delete-stack`. Receives the
 * already-parsed `input` record and already-read `templateText` from
 * `run-cloudformation-stacks` (never touches the filesystem itself).
 * `create-stack` narrows/validates the record into
 * `M3LCloudFormationCreateStackInput` (requires `stackName` **inside the
 * record**, not from the `stackName` dep field — per the doc's sourcing
 * split) and injects `templateBody` from `templateText` only when the
 * record sets neither `templateBody` nor `templateUrl`. `update-stack`
 * mirrors this into `M3LCloudFormationUpdateStackInput`; its result may
 * legitimately be `{ changed: false }`, not an error. `delete-stack` takes
 * `stackName`/`retainResources`/`roleArn` from the deps object directly (no
 * `input` record involved) and returns `void`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeStack — create-stack", () => {
  test("calls operations.createStack with the parsed input's stackName and injects templateBody from templateText when neither template field is set", async () => {
    const createStack = vi
      .fn()
      .mockResolvedValue({ stackId: "arn:aws:cloudformation::stack/my-stack" });
    const operations = createFakeCloudFormationOperations({ createStack });
    const input = { stackName: "my-stack" };

    const returned = await writeStack({
      operations,
      operation: "create-stack",
      input,
      templateText: "Resources: {}",
      stackName: undefined,
      retainResources: undefined,
      roleArn: undefined,
    });

    expect(createStack).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: "my-stack",
        templateBody: "Resources: {}",
      }),
    );
    expect(returned).toEqual({
      stackId: "arn:aws:cloudformation::stack/my-stack",
    });
  });

  test("does NOT inject templateBody when the record already sets templateBody", async () => {
    const createStack = vi
      .fn()
      .mockResolvedValue({ stackId: "arn:aws:cloudformation::stack/my-stack" });
    const operations = createFakeCloudFormationOperations({ createStack });
    const input = { stackName: "my-stack", templateBody: "record-supplied" };

    await writeStack({
      operations,
      operation: "create-stack",
      input,
      templateText: "should-not-be-used",
      stackName: undefined,
      retainResources: undefined,
      roleArn: undefined,
    });

    expect(createStack).toHaveBeenCalledWith(
      expect.objectContaining({ templateBody: "record-supplied" }),
    );
  });

  test("does NOT inject templateBody when the record already sets templateUrl", async () => {
    const createStack = vi
      .fn()
      .mockResolvedValue({ stackId: "arn:aws:cloudformation::stack/my-stack" });
    const operations = createFakeCloudFormationOperations({ createStack });
    const input = {
      stackName: "my-stack",
      templateUrl: "https://example.com/template.json",
    };

    await writeStack({
      operations,
      operation: "create-stack",
      input,
      templateText: "should-not-be-used",
      stackName: undefined,
      retainResources: undefined,
      roleArn: undefined,
    });

    const call = createStack.mock.calls[0] as [
      { templateBody?: string; templateUrl?: string },
    ];
    expect(call[0].templateBody).toBeUndefined();
    expect(call[0].templateUrl).toBe("https://example.com/template.json");
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when input is undefined, never calling createStack", async () => {
    const createStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ createStack });

    let thrown: unknown;
    try {
      await writeStack({
        operations,
        operation: "create-stack",
        input: undefined,
        templateText: undefined,
        stackName: undefined,
        retainResources: undefined,
        roleArn: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_CLOUDFORMATION_STACKS_CONFIG",
    );
    expect(createStack).not.toHaveBeenCalled();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when the parsed input record is missing 'stackName' (not sourced from the deps stackName field), never calling createStack", async () => {
    const createStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ createStack });
    const input = { templateBody: "x" };

    await expect(
      writeStack({
        operations,
        operation: "create-stack",
        input,
        templateText: undefined,
        // Even a stray stackName on the deps object must not rescue the
        // missing record field — create-stack sources stackName from the
        // record only.
        stackName: "should-not-be-used",
        retainResources: undefined,
        roleArn: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CLOUDFORMATION_STACKS_CONFIG" });
    expect(createStack).not.toHaveBeenCalled();
  });
});

describe("writeStack — update-stack", () => {
  test("calls operations.updateStack with the parsed input's stackName", async () => {
    const updateStack = vi.fn().mockResolvedValue({
      changed: true,
      stackId: "arn:aws:cloudformation::stack/my-stack",
    });
    const operations = createFakeCloudFormationOperations({ updateStack });
    const input = { stackName: "my-stack", usePreviousTemplate: true };

    const returned = await writeStack({
      operations,
      operation: "update-stack",
      input,
      templateText: undefined,
      stackName: undefined,
      retainResources: undefined,
      roleArn: undefined,
    });

    expect(updateStack).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: "my-stack",
        usePreviousTemplate: true,
      }),
    );
    expect(returned).toEqual({
      changed: true,
      stackId: "arn:aws:cloudformation::stack/my-stack",
    });
  });

  test("does not throw when updateStack legitimately resolves { changed: false } (a no-op success)", async () => {
    const updateStack = vi.fn().mockResolvedValue({ changed: false });
    const operations = createFakeCloudFormationOperations({ updateStack });
    const input = { stackName: "my-stack" };

    await expect(
      writeStack({
        operations,
        operation: "update-stack",
        input,
        templateText: undefined,
        stackName: undefined,
        retainResources: undefined,
        roleArn: undefined,
      }),
    ).resolves.toEqual({ changed: false });
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when input is undefined, never calling updateStack", async () => {
    const updateStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ updateStack });

    await expect(
      writeStack({
        operations,
        operation: "update-stack",
        input: undefined,
        templateText: undefined,
        stackName: undefined,
        retainResources: undefined,
        roleArn: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CLOUDFORMATION_STACKS_CONFIG" });
    expect(updateStack).not.toHaveBeenCalled();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when the parsed input record is missing 'stackName', never calling updateStack", async () => {
    const updateStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ updateStack });
    const input = { usePreviousTemplate: true };

    await expect(
      writeStack({
        operations,
        operation: "update-stack",
        input,
        templateText: undefined,
        stackName: undefined,
        retainResources: undefined,
        roleArn: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CLOUDFORMATION_STACKS_CONFIG" });
    expect(updateStack).not.toHaveBeenCalled();
  });
});

describe("writeStack — delete-stack", () => {
  test("calls operations.deleteStack(stackName, { retainResources, roleArn }) from deps config values, ignoring input", async () => {
    const deleteStack = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCloudFormationOperations({ deleteStack });

    const returned = await writeStack({
      operations,
      operation: "delete-stack",
      input: undefined,
      templateText: undefined,
      stackName: "my-stack",
      retainResources: ["MyBucket"],
      roleArn: "arn:aws:iam::123:role/deploy",
    });

    expect(deleteStack).toHaveBeenCalledWith(
      "my-stack",
      expect.objectContaining({
        retainResources: ["MyBucket"],
        roleArn: "arn:aws:iam::123:role/deploy",
      }),
    );
    expect(returned).toBeUndefined();
  });

  test("throws ERR_CLOUDFORMATION_STACKS_CONFIG when stackName is undefined, never calling deleteStack", async () => {
    const deleteStack = vi.fn();
    const operations = createFakeCloudFormationOperations({ deleteStack });

    await expect(
      writeStack({
        operations,
        operation: "delete-stack",
        input: undefined,
        templateText: undefined,
        stackName: undefined,
        retainResources: undefined,
        roleArn: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CLOUDFORMATION_STACKS_CONFIG" });
    expect(deleteStack).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("writeStack resolves the create/update/void result union", () => {
    expectTypeOf<Awaited<ReturnType<typeof writeStack>>>().toEqualTypeOf<
      | AWS.M3LCloudFormationCreateStackResult
      | AWS.M3LCloudFormationUpdateStackResult
      | void
    >();
  });
});
