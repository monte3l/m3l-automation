/**
 * Tests for aws/cloudformation submodule.
 *
 * Contract source: docs/reference/aws/cloudformation.md.
 *
 * Exports under test (from `../src/aws/cloudformation/index.js`, following
 * the package's `../src/aws/index.js` barrel):
 *   M3LCloudFormationOperations, M3LCloudFormationOperationError, and the
 *   M3LCloudFormation* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-cloudformation` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/ecs.test.ts`), with a `.send()` spy dispatching by command class
 * plus standalone spies for the three stack-lifecycle waiter functions
 * (CloudFormation's stack waiters, like ECS's, are package-level waiters,
 * not `Command`s).
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LCloudFormationOperations`'s
 * methods currently reject with
 * `M3LCloudFormationOperationError("... not yet implemented")` (see
 * src/aws/cloudformation/client.ts). `implementing-submodules` turns them
 * GREEN; `test-author` expands this seed into the full happy/failure-path
 * suite against the settled contract.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();
  const waitUntilStackCreateComplete = vi.fn();
  const waitUntilStackUpdateComplete = vi.fn();
  const waitUntilStackDeleteComplete = vi.fn();

  class ListStacksCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeStacksCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateStackCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateStackCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteStackCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeStackEventsCommand {
    constructor(readonly input: unknown) {}
  }
  class CloudFormationClient {
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
    waitUntilStackCreateComplete,
    waitUntilStackUpdateComplete,
    waitUntilStackDeleteComplete,
    CloudFormationClient,
    ListStacksCommand,
    DescribeStacksCommand,
    CreateStackCommand,
    UpdateStackCommand,
    DeleteStackCommand,
    DescribeStackEventsCommand,
  };
});

vi.mock("@aws-sdk/client-cloudformation", () => ({
  CloudFormationClient: h.CloudFormationClient,
  ListStacksCommand: h.ListStacksCommand,
  DescribeStacksCommand: h.DescribeStacksCommand,
  CreateStackCommand: h.CreateStackCommand,
  UpdateStackCommand: h.UpdateStackCommand,
  DeleteStackCommand: h.DeleteStackCommand,
  DescribeStackEventsCommand: h.DescribeStackEventsCommand,
  waitUntilStackCreateComplete: h.waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete: h.waitUntilStackUpdateComplete,
  waitUntilStackDeleteComplete: h.waitUntilStackDeleteComplete,
}));

import type {
  M3LCloudFormationCreateStackResult,
  M3LCloudFormationDescribeStackEventsResult,
  M3LCloudFormationKeyValue,
  M3LCloudFormationListStacksResult,
  M3LCloudFormationOutput,
  M3LCloudFormationStack,
  M3LCloudFormationStackEvent,
  M3LCloudFormationUpdateStackResult,
  M3LCloudFormationWaiterResult,
} from "../src/aws/cloudformation/index.js";
import {
  M3LCloudFormationOperationError,
  M3LCloudFormationOperations,
} from "../src/aws/cloudformation/index.js";

import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";

const STACK_NAME = "test-stack";
const STACK_ID = `arn:aws:cloudformation:eu-south-1:123456789012:stack/${STACK_NAME}/abc-123`;

/** Casts the hoisted fake `CloudFormationClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): CloudFormationClient {
  return new h.CloudFormationClient() as unknown as CloudFormationClient;
}

/** Builds a `ValidationError`-named `Error` with the given message, as the SDK's unmodeled rejection shape. */
function validationError(message: string): Error {
  const error = new Error(message);
  error.name = "ValidationError";
  return error;
}

describe("M3LCloudFormationOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
    h.waitUntilStackCreateComplete.mockReset();
    h.waitUntilStackUpdateComplete.mockReset();
    h.waitUntilStackDeleteComplete.mockReset();
  });

  describe("listStacks", () => {
    test("resolves with plain stackSummaries on a successful ListStacks call", async () => {
      h.send.mockResolvedValueOnce({
        StackSummaries: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "CREATE_COMPLETE",
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result).toEqual<M3LCloudFormationListStacksResult>({
        stackSummaries: [
          {
            stackId: STACK_ID,
            stackName: STACK_NAME,
            stackStatus: "CREATE_COMPLETE",
          },
        ],
      });
    });

    test("resolves stackSummaries as an empty array when the SDK omits StackSummaries", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result.stackSummaries).toEqual([]);
    });

    test("throws M3LCloudFormationOperationError when the underlying ListStacks call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.listStacks()).rejects.toThrow(
        M3LCloudFormationOperationError,
      );
    });

    test("omits nextToken from the resolved result when the SDK response has none", async () => {
      h.send.mockResolvedValueOnce({ StackSummaries: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result).not.toHaveProperty("nextToken");
    });

    test("includes nextToken in the resolved result only when the SDK response returns one", async () => {
      h.send.mockResolvedValueOnce({
        StackSummaries: [],
        NextToken: "next-page-token",
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result.nextToken).toBe("next-page-token");
    });

    test("forwards the caller's own nextToken onto the constructed ListStacksCommand", async () => {
      h.send.mockResolvedValueOnce({ StackSummaries: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.listStacks({ nextToken: "caller-token" });

      const [command] = h.send.mock.calls[0] as [
        { input: { NextToken?: string } },
      ];
      expect(command.input.NextToken).toBe("caller-token");
    });

    test("passes stackStatusFilter straight through to the SDK call with no default narrowing", async () => {
      h.send.mockResolvedValueOnce({ StackSummaries: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.listStacks({
        stackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE"],
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { StackStatusFilter?: readonly string[] } },
      ];
      expect(command.input.StackStatusFilter).toEqual([
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
      ]);
    });

    test("does not add its own StackStatusFilter default when the caller omits it", async () => {
      h.send.mockResolvedValueOnce({ StackSummaries: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.listStacks();

      const [command] = h.send.mock.calls[0] as [
        { input: { StackStatusFilter?: readonly string[] } },
      ];
      expect(command.input.StackStatusFilter).toBeUndefined();
    });

    test("maps creationTime, lastUpdatedTime, deletionTime, and stackStatusReason onto a stack summary when the SDK response includes them", async () => {
      h.send.mockResolvedValueOnce({
        StackSummaries: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "DELETE_COMPLETE",
            CreationTime: new Date("2026-01-01T00:00:00.000Z"),
            LastUpdatedTime: new Date("2026-01-02T00:00:00.000Z"),
            DeletionTime: new Date("2026-01-03T00:00:00.000Z"),
            StackStatusReason: "user-initiated deletion",
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result.stackSummaries[0]).toEqual({
        stackId: STACK_ID,
        stackName: STACK_NAME,
        stackStatus: "DELETE_COMPLETE",
        creationTime: "2026-01-01T00:00:00.000Z",
        lastUpdatedTime: "2026-01-02T00:00:00.000Z",
        deletionTime: "2026-01-03T00:00:00.000Z",
        stackStatusReason: "user-initiated deletion",
      });
    });

    test("defaults stackName and stackStatus to empty string when a StackSummary entry omits them", async () => {
      h.send.mockResolvedValueOnce({ StackSummaries: [{}] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.listStacks();

      expect(result.stackSummaries[0]).toEqual({
        stackName: "",
        stackStatus: "",
      });
    });
  });

  describe("describeStack", () => {
    test("resolves the single stack record on a successful DescribeStacks call", async () => {
      h.send.mockResolvedValueOnce({
        Stacks: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "CREATE_COMPLETE",
            CreationTime: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toEqual<M3LCloudFormationStack>({
        stackId: STACK_ID,
        stackName: STACK_NAME,
        stackStatus: "CREATE_COMPLETE",
        creationTime: "2026-01-01T00:00:00.000Z",
      });
    });

    test("omits stackId and creationTime from the resolved stack when the SDK response omits them", async () => {
      h.send.mockResolvedValueOnce({
        Stacks: [{ StackName: STACK_NAME, StackStatus: "CREATE_COMPLETE" }],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).not.toHaveProperty("stackId");
      expect(result).not.toHaveProperty("creationTime");
    });

    test("resolves undefined on a ValidationError whose message contains 'does not exist'", async () => {
      h.send.mockRejectedValueOnce(
        validationError(`Stack with id ${STACK_NAME} does not exist`),
      );

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toBeUndefined();
    });

    test("resolves undefined when the SDK response's Stacks array is empty", async () => {
      h.send.mockResolvedValueOnce({ Stacks: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toBeUndefined();
    });

    test("resolves undefined when the SDK response omits Stacks entirely", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toBeUndefined();
    });

    test("throws M3LCloudFormationOperationError on a ValidationError whose message does not match 'does not exist'", async () => {
      const cause = validationError("1 validation error detected: value at");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCloudFormationOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeStack(STACK_NAME);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudFormationOperationError);
      expect((thrown as M3LCloudFormationOperationError).cause).toBe(cause);
    });

    test("throws M3LCloudFormationOperationError on a non-ValidationError-named rejection even when the message contains 'does not exist'", async () => {
      const cause = new Error(`Stack with id ${STACK_NAME} does not exist`);
      cause.name = "ServiceError";
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.describeStack(STACK_NAME)).rejects.toThrow(
        M3LCloudFormationOperationError,
      );
    });

    test("throws M3LCloudFormationOperationError on a generic DescribeStacks failure", async () => {
      h.send.mockRejectedValueOnce(new Error("access denied"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.describeStack(STACK_NAME)).rejects.toThrow(
        M3LCloudFormationOperationError,
      );
    });

    test("maps parameters, tags, and outputs onto the resolved stack when the SDK response includes them", async () => {
      h.send.mockResolvedValueOnce({
        Stacks: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "CREATE_COMPLETE",
            Parameters: [{ ParameterKey: "Env", ParameterValue: "prod" }],
            Tags: [{ Key: "Team", Value: "platform" }],
            Outputs: [
              {
                OutputKey: "Url",
                OutputValue: "https://example.test",
                Description: "the endpoint",
                ExportName: "test-stack-url",
              },
            ],
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result?.parameters).toEqual<M3LCloudFormationKeyValue[]>([
        { key: "Env", value: "prod" },
      ]);
      expect(result?.tags).toEqual<M3LCloudFormationKeyValue[]>([
        { key: "Team", value: "platform" },
      ]);
      expect(result?.outputs).toEqual<M3LCloudFormationOutput[]>([
        {
          key: "Url",
          value: "https://example.test",
          description: "the endpoint",
          exportName: "test-stack-url",
        },
      ]);
    });

    test("defaults each half of a parameter/tag/output entry to an empty string when the SDK omits it individually", async () => {
      h.send.mockResolvedValueOnce({
        Stacks: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "CREATE_COMPLETE",
            Parameters: [
              { ParameterKey: "onlyKey" },
              { ParameterValue: "onlyValue" },
            ],
            Tags: [{ Key: "onlyKey" }, { Value: "onlyValue" }],
            Outputs: [{ OutputKey: "onlyKey" }, { OutputValue: "onlyValue" }],
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result?.parameters).toEqual<M3LCloudFormationKeyValue[]>([
        { key: "onlyKey", value: "" },
        { key: "", value: "onlyValue" },
      ]);
      expect(result?.tags).toEqual<M3LCloudFormationKeyValue[]>([
        { key: "onlyKey", value: "" },
        { key: "", value: "onlyValue" },
      ]);
      expect(result?.outputs).toEqual<M3LCloudFormationOutput[]>([
        { key: "onlyKey", value: "" },
        { key: "", value: "onlyValue" },
      ]);
    });

    test("maps description, lastUpdatedTime, stackStatusReason, roleArn, disableRollback, and enableTerminationProtection when the SDK response includes them", async () => {
      h.send.mockResolvedValueOnce({
        Stacks: [
          {
            StackId: STACK_ID,
            StackName: STACK_NAME,
            StackStatus: "UPDATE_COMPLETE",
            Description: "the stack description",
            LastUpdatedTime: new Date("2026-01-02T00:00:00.000Z"),
            StackStatusReason: "update finished",
            RoleARN: "arn:aws:iam::123456789012:role/deploy-role",
            DisableRollback: true,
            EnableTerminationProtection: true,
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toEqual<M3LCloudFormationStack>({
        stackId: STACK_ID,
        stackName: STACK_NAME,
        stackStatus: "UPDATE_COMPLETE",
        description: "the stack description",
        lastUpdatedTime: "2026-01-02T00:00:00.000Z",
        stackStatusReason: "update finished",
        roleArn: "arn:aws:iam::123456789012:role/deploy-role",
        disableRollback: true,
        enableTerminationProtection: true,
      });
    });

    test("defaults stackName and stackStatus to empty string when the SDK response omits them", async () => {
      h.send.mockResolvedValueOnce({ Stacks: [{}] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStack(STACK_NAME);

      expect(result).toEqual<M3LCloudFormationStack>({
        stackName: "",
        stackStatus: "",
      });
    });
  });

  describe("createStack", () => {
    test("resolves with the created stack's stackId", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.createStack({
        stackName: STACK_NAME,
        templateBody: "{}",
      });

      expect(result).toEqual<M3LCloudFormationCreateStackResult>({
        stackId: STACK_ID,
      });
    });

    test("throws M3LCloudFormationOperationError when the underlying CreateStack call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("insufficient capabilities"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(
        operations.createStack({ stackName: STACK_NAME, templateBody: "{}" }),
      ).rejects.toThrow(M3LCloudFormationOperationError);
    });

    test("throws M3LCloudFormationOperationError when the SDK response omits StackId on an otherwise-successful call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(
        operations.createStack({ stackName: STACK_NAME, templateBody: "{}" }),
      ).rejects.toThrow(M3LCloudFormationOperationError);
    });

    test("maps parameters and tags onto the constructed CreateStackCommand input", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.createStack({
        stackName: STACK_NAME,
        templateBody: "{}",
        parameters: [{ key: "Env", value: "prod" }],
        tags: [{ key: "Team", value: "platform" }],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            Parameters?: { ParameterKey: string; ParameterValue: string }[];
            Tags?: { Key: string; Value: string }[];
          };
        },
      ];
      expect(command.input.Parameters).toEqual([
        { ParameterKey: "Env", ParameterValue: "prod" },
      ]);
      expect(command.input.Tags).toEqual([{ Key: "Team", Value: "platform" }]);
    });

    test("maps templateUrl, roleArn, timeoutInMinutes, disableRollback, enableTerminationProtection, and capabilities onto the constructed CreateStackCommand input", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.createStack({
        stackName: STACK_NAME,
        templateUrl: "https://example.test/template.json",
        roleArn: "arn:aws:iam::123456789012:role/deploy-role",
        timeoutInMinutes: 15,
        disableRollback: true,
        enableTerminationProtection: true,
        capabilities: ["CAPABILITY_IAM"],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            TemplateURL?: string;
            RoleARN?: string;
            TimeoutInMinutes?: number;
            DisableRollback?: boolean;
            EnableTerminationProtection?: boolean;
            Capabilities?: string[];
          };
        },
      ];
      expect(command.input.TemplateURL).toBe(
        "https://example.test/template.json",
      );
      expect(command.input.RoleARN).toBe(
        "arn:aws:iam::123456789012:role/deploy-role",
      );
      expect(command.input.TimeoutInMinutes).toBe(15);
      expect(command.input.DisableRollback).toBe(true);
      expect(command.input.EnableTerminationProtection).toBe(true);
      expect(command.input.Capabilities).toEqual(["CAPABILITY_IAM"]);
    });
  });

  describe("updateStack", () => {
    test("resolves { changed: true, stackId } on a genuine update", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.updateStack({
        stackName: STACK_NAME,
        templateBody: "{}",
      });

      expect(result).toEqual<M3LCloudFormationUpdateStackResult>({
        changed: true,
        stackId: STACK_ID,
      });
    });

    test("throws M3LCloudFormationOperationError when the underlying UpdateStack call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("insufficient capabilities"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(
        operations.updateStack({ stackName: STACK_NAME, templateBody: "{}" }),
      ).rejects.toThrow(M3LCloudFormationOperationError);
    });

    test("resolves { changed: false } on a ValidationError whose message contains 'No updates are to be performed'", async () => {
      h.send.mockRejectedValueOnce(
        validationError("No updates are to be performed."),
      );

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.updateStack({
        stackName: STACK_NAME,
        templateBody: "{}",
      });

      expect(result).toEqual<M3LCloudFormationUpdateStackResult>({
        changed: false,
      });
    });

    test("throws M3LCloudFormationOperationError on a ValidationError with a different message", async () => {
      const cause = validationError("1 validation error detected: value at");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCloudFormationOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.updateStack({
          stackName: STACK_NAME,
          templateBody: "{}",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudFormationOperationError);
      expect((thrown as M3LCloudFormationOperationError).cause).toBe(cause);
    });

    test("throws M3LCloudFormationOperationError on a non-ValidationError-named rejection containing the 'no updates' text", async () => {
      const cause = new Error("No updates are to be performed.");
      cause.name = "ServiceError";
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(
        operations.updateStack({ stackName: STACK_NAME, templateBody: "{}" }),
      ).rejects.toThrow(M3LCloudFormationOperationError);
    });

    test("throws M3LCloudFormationOperationError when the SDK response omits StackId on an otherwise-successful call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(
        operations.updateStack({ stackName: STACK_NAME, templateBody: "{}" }),
      ).rejects.toThrow(M3LCloudFormationOperationError);
    });

    test("maps parameters and tags onto the constructed UpdateStackCommand input", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.updateStack({
        stackName: STACK_NAME,
        templateBody: "{}",
        parameters: [{ key: "Env", value: "prod" }],
        tags: [{ key: "Team", value: "platform" }],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            Parameters?: { ParameterKey: string; ParameterValue: string }[];
            Tags?: { Key: string; Value: string }[];
          };
        },
      ];
      expect(command.input.Parameters).toEqual([
        { ParameterKey: "Env", ParameterValue: "prod" },
      ]);
      expect(command.input.Tags).toEqual([{ Key: "Team", Value: "platform" }]);
    });

    test("maps templateUrl, usePreviousTemplate, and roleArn onto the constructed UpdateStackCommand input", async () => {
      h.send.mockResolvedValueOnce({ StackId: STACK_ID });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.updateStack({
        stackName: STACK_NAME,
        templateUrl: "https://example.test/template.json",
        usePreviousTemplate: false,
        roleArn: "arn:aws:iam::123456789012:role/deploy-role",
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            TemplateURL?: string;
            UsePreviousTemplate?: boolean;
            RoleARN?: string;
          };
        },
      ];
      expect(command.input.TemplateURL).toBe(
        "https://example.test/template.json",
      );
      expect(command.input.UsePreviousTemplate).toBe(false);
      expect(command.input.RoleARN).toBe(
        "arn:aws:iam::123456789012:role/deploy-role",
      );
    });
  });

  describe("deleteStack", () => {
    test("resolves void on a successful DeleteStack call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.deleteStack(STACK_NAME)).resolves.toBeUndefined();
    });

    test("resolves void, rather than throwing, when the underlying DeleteStack call succeeds against an already-absent stack", async () => {
      // CloudFormation treats DeleteStack against a no-longer-existing stack
      // as a no-op success — the SDK call resolves normally, and the wrapper
      // simply passes that resolution through as void.
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.deleteStack(STACK_NAME)).resolves.toBeUndefined();
    });

    test("throws M3LCloudFormationOperationError when the underlying DeleteStack call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("access denied"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.deleteStack(STACK_NAME)).rejects.toThrow(
        M3LCloudFormationOperationError,
      );
    });

    test("maps retainResources and roleArn onto the constructed DeleteStackCommand input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.deleteStack(STACK_NAME, {
        retainResources: ["MyBucket"],
        roleArn: "arn:aws:iam::123456789012:role/delete-role",
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            RetainResources?: string[];
            RoleARN?: string;
          };
        },
      ];
      expect(command.input.RetainResources).toEqual(["MyBucket"]);
      expect(command.input.RoleARN).toBe(
        "arn:aws:iam::123456789012:role/delete-role",
      );
    });
  });

  describe("describeStackEvents", () => {
    test("resolves with plain stackEvents on a successful DescribeStackEvents call", async () => {
      h.send.mockResolvedValueOnce({
        StackEvents: [
          {
            StackId: STACK_ID,
            EventId: "event-1",
            StackName: STACK_NAME,
            Timestamp: new Date("2026-01-01T00:00:00.000Z"),
            ResourceStatus: "CREATE_COMPLETE",
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result).toEqual<M3LCloudFormationDescribeStackEventsResult>({
        stackEvents: [
          {
            stackId: STACK_ID,
            eventId: "event-1",
            stackName: STACK_NAME,
            timestamp: "2026-01-01T00:00:00.000Z",
            resourceStatus: "CREATE_COMPLETE",
          },
        ],
      });
    });

    test("resolves stackEvents as an empty array when the SDK omits StackEvents", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result.stackEvents).toEqual([]);
    });

    test("throws M3LCloudFormationOperationError when the underlying DescribeStackEvents call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LCloudFormationOperations(fakeClient());

      await expect(operations.describeStackEvents(STACK_NAME)).rejects.toThrow(
        M3LCloudFormationOperationError,
      );
    });

    test("forwards the caller's own nextToken onto the constructed DescribeStackEventsCommand", async () => {
      h.send.mockResolvedValueOnce({ StackEvents: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations.describeStackEvents(STACK_NAME, {
        nextToken: "caller-token",
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { NextToken?: string } },
      ];
      expect(command.input.NextToken).toBe("caller-token");
    });

    test("includes nextToken in the resolved result only when the SDK response returns one", async () => {
      h.send.mockResolvedValueOnce({
        StackEvents: [],
        NextToken: "next-page-token",
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result.nextToken).toBe("next-page-token");
    });

    test("omits nextToken from the resolved result when the SDK response has none", async () => {
      h.send.mockResolvedValueOnce({ StackEvents: [] });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result).not.toHaveProperty("nextToken");
    });

    test("maps every field onto the resolved stack event when the SDK response includes all of them", async () => {
      h.send.mockResolvedValueOnce({
        StackEvents: [
          {
            StackId: STACK_ID,
            EventId: "event-1",
            StackName: STACK_NAME,
            Timestamp: new Date("2026-01-01T00:00:00.000Z"),
            LogicalResourceId: "MyBucket",
            PhysicalResourceId: "my-bucket-abc123",
            ResourceType: "AWS::S3::Bucket",
            ResourceStatus: "CREATE_COMPLETE",
            ResourceStatusReason: "resource creation successful",
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result.stackEvents[0]).toEqual<M3LCloudFormationStackEvent>({
        stackId: STACK_ID,
        eventId: "event-1",
        stackName: STACK_NAME,
        timestamp: "2026-01-01T00:00:00.000Z",
        logicalResourceId: "MyBucket",
        physicalResourceId: "my-bucket-abc123",
        resourceType: "AWS::S3::Bucket",
        resourceStatus: "CREATE_COMPLETE",
        resourceStatusReason: "resource creation successful",
      });
    });

    test("defaults stackId, eventId, and stackName to empty string when the SDK response omits them", async () => {
      h.send.mockResolvedValueOnce({
        StackEvents: [
          {
            Timestamp: new Date("2026-01-01T00:00:00.000Z"),
            ResourceStatus: "CREATE_COMPLETE",
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      expect(result.stackEvents[0]).toEqual<M3LCloudFormationStackEvent>({
        stackId: "",
        eventId: "",
        stackName: "",
        timestamp: "2026-01-01T00:00:00.000Z",
        resourceStatus: "CREATE_COMPLETE",
      });
    });

    test("omits timestamp and the resource-detail fields from the resolved stack event when the SDK response omits them", async () => {
      h.send.mockResolvedValueOnce({
        StackEvents: [
          {
            StackId: STACK_ID,
            EventId: "event-1",
            StackName: STACK_NAME,
          },
        ],
      });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations.describeStackEvents(STACK_NAME);

      const [event] = result.stackEvents;
      expect(event).not.toHaveProperty("timestamp");
      expect(event).not.toHaveProperty("logicalResourceId");
      expect(event).not.toHaveProperty("physicalResourceId");
      expect(event).not.toHaveProperty("resourceType");
      expect(event).not.toHaveProperty("resourceStatus");
      expect(event).not.toHaveProperty("resourceStatusReason");
    });
  });

  describe.each([
    {
      methodName: "waitUntilStackCreateComplete" as const,
      spy: () => h.waitUntilStackCreateComplete,
    },
    {
      methodName: "waitUntilStackUpdateComplete" as const,
      spy: () => h.waitUntilStackUpdateComplete,
    },
    {
      methodName: "waitUntilStackDeleteComplete" as const,
      spy: () => h.waitUntilStackDeleteComplete,
    },
  ])("$methodName", ({ methodName, spy }) => {
    // Each of the SDK's own waiter functions THROWS on any non-SUCCESS
    // terminal state (via its internal checkExceptions) rather than
    // resolving with one — only a stable outcome resolves normally. Each
    // wrapper method's whole job is translating a caught TimeoutError/
    // AbortError back into a resolved M3LCloudFormationWaiterResult; every
    // other rejection (including the SDK's unnamed FAILURE terminal state)
    // throws M3LCloudFormationOperationError instead
    // (docs/reference/aws/cloudformation.md).
    test("resolves { state: 'SUCCESS' } when the waiter resolves normally", async () => {
      spy().mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations[methodName](STACK_NAME);

      expect(result).toEqual<M3LCloudFormationWaiterResult>({
        state: "SUCCESS",
      });
    });

    test("resolves { state: 'TIMEOUT', reason } when the waiter rejects with a TimeoutError", async () => {
      const timeoutError = new Error("Waiter has timed out");
      timeoutError.name = "TimeoutError";
      spy().mockRejectedValueOnce(timeoutError);

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations[methodName](STACK_NAME);

      expect(result).toEqual<M3LCloudFormationWaiterResult>({
        state: "TIMEOUT",
        reason: timeoutError.message,
      });
    });

    test("resolves { state: 'ABORTED', reason } when the waiter rejects with an AbortError", async () => {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      spy().mockRejectedValueOnce(abortError);

      const operations = new M3LCloudFormationOperations(fakeClient());
      const result = await operations[methodName](STACK_NAME);

      expect(result).toEqual<M3LCloudFormationWaiterResult>({
        state: "ABORTED",
        reason: abortError.message,
      });
    });

    test("throws M3LCloudFormationOperationError, chaining the cause, on any other waiter rejection", async () => {
      const unclassifiedError = new Error("Stack rollback: CREATE_FAILED");
      spy().mockRejectedValueOnce(unclassifiedError);

      const operations = new M3LCloudFormationOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations[methodName](STACK_NAME);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCloudFormationOperationError);
      expect((thrown as M3LCloudFormationOperationError).cause).toBe(
        unclassifiedError,
      );
    });

    test("invokes the waiter with maxWaitTime defaulted to 3600 when the caller omits options", async () => {
      spy().mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations[methodName](STACK_NAME);

      const [params] = spy().mock.calls[0] as [
        { maxWaitTime?: number },
        unknown,
      ];
      expect(params.maxWaitTime).toBe(3600);
    });

    test("invokes the waiter with the caller's own maxWaitTime when supplied", async () => {
      spy().mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LCloudFormationOperations(fakeClient());
      await operations[methodName](STACK_NAME, { maxWaitTime: 120 });

      const [params] = spy().mock.calls[0] as [
        { maxWaitTime?: number },
        unknown,
      ];
      expect(params.maxWaitTime).toBe(120);
    });
  });

  describe("type contract", () => {
    // Pure type-level assertions — never invoke a method directly against a
    // placeholder that unconditionally rejects (see
    // docs/logs/2026-07-24-aws-ecs.md); resolve the Awaited<ReturnType<...>>
    // instead so the still-rejecting placeholder is never called at runtime.
    test("listStacks resolves M3LCloudFormationListStacksResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["listStacks"]>>
      >().toEqualTypeOf<M3LCloudFormationListStacksResult>();
    });

    test("describeStack resolves M3LCloudFormationStack | undefined", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["describeStack"]>>
      >().toEqualTypeOf<M3LCloudFormationStack | undefined>();
    });

    test("createStack resolves M3LCloudFormationCreateStackResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["createStack"]>>
      >().toEqualTypeOf<M3LCloudFormationCreateStackResult>();
    });

    test("updateStack resolves the M3LCloudFormationUpdateStackResult discriminated union", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["updateStack"]>>
      >().toEqualTypeOf<M3LCloudFormationUpdateStackResult>();
    });

    test("M3LCloudFormationUpdateStackResult is exactly { changed: true, stackId } | { changed: false }", () => {
      expectTypeOf<M3LCloudFormationUpdateStackResult>().toEqualTypeOf<
        | { readonly changed: true; readonly stackId: string }
        | { readonly changed: false }
      >();
    });

    test("deleteStack resolves void", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["deleteStack"]>>
      >().toEqualTypeOf<void>();
    });

    test("describeStackEvents resolves M3LCloudFormationDescribeStackEventsResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCloudFormationOperations["describeStackEvents"]>>
      >().toEqualTypeOf<M3LCloudFormationDescribeStackEventsResult>();
    });

    test("waitUntilStackCreateComplete resolves M3LCloudFormationWaiterResult", () => {
      expectTypeOf<
        Awaited<
          ReturnType<
            M3LCloudFormationOperations["waitUntilStackCreateComplete"]
          >
        >
      >().toEqualTypeOf<M3LCloudFormationWaiterResult>();
    });

    test("waitUntilStackUpdateComplete resolves M3LCloudFormationWaiterResult", () => {
      expectTypeOf<
        Awaited<
          ReturnType<
            M3LCloudFormationOperations["waitUntilStackUpdateComplete"]
          >
        >
      >().toEqualTypeOf<M3LCloudFormationWaiterResult>();
    });

    test("waitUntilStackDeleteComplete resolves M3LCloudFormationWaiterResult", () => {
      expectTypeOf<
        Awaited<
          ReturnType<
            M3LCloudFormationOperations["waitUntilStackDeleteComplete"]
          >
        >
      >().toEqualTypeOf<M3LCloudFormationWaiterResult>();
    });
  });
});
