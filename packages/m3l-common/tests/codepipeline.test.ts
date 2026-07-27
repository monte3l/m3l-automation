/**
 * Tests for aws/codepipeline submodule.
 *
 * Contract source: docs/reference/aws/codepipeline.md.
 *
 * Exports under test (from `../src/aws/codepipeline/index.js`, following
 * the package's `../src/aws/index.js` barrel):
 *   M3LCodePipelineOperations, M3LCodePipelineOperationError, and the
 *   M3LCodePipeline* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-codepipeline` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/cloudformation.test.ts`), with a `.send()` spy configured per test
 * via `mockResolvedValueOnce`/`mockRejectedValueOnce` and command-input
 * assertions read off `h.send.mock.calls`. Unlike cloudformation/ecs,
 * CodePipeline ships **no** package-level `waitUntil*` waiter functions, so
 * there are no waiter spies here — see
 * `docs/reference/aws/codepipeline.md`'s "Watching an execution" section.
 *
 * SCOPE (this file, "test-author 4a"): `listPipelines`, `getPipelineState`,
 * `listPipelineExecutions`, `getPipelineExecution`, `startPipelineExecution`,
 * `stopPipelineExecution`, `enableStageTransition`,
 * `disableStageTransition`, `deletePipeline`, `M3LCodePipelineOperationError`,
 * and the `ValidationException`-never-classified guarantee.
 * `getPipeline`/`createPipeline`/`updatePipeline` and the full declaration
 * model belong to a separate pass ("test-author 4b") — not covered here; the
 * corresponding mock command stub classes are left as empty placeholders
 * below so that pass can extend the bag without restructuring it.
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LCodePipelineOperations`'s
 * methods currently reject with
 * `M3LCodePipelineOperationError("... not yet implemented")` (see
 * src/aws/codepipeline/client.ts). `implementing-submodules` turns them
 * GREEN.
 */

import type * as CodePipelineSdkModule from "@aws-sdk/client-codepipeline";
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies + a fake constructible client class referenced by
// the hoisted `vi.mock` factory below (mirrors tests/cloudformation.test.ts).
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class CodePipelineClient {
    send = send;
    destroy = destroy;
  }
  class ListPipelinesCommand {
    constructor(readonly input: unknown) {}
  }
  class GetPipelineStateCommand {
    constructor(readonly input: unknown) {}
  }
  class ListPipelineExecutionsCommand {
    constructor(readonly input: unknown) {}
  }
  class GetPipelineExecutionCommand {
    constructor(readonly input: unknown) {}
  }
  class StartPipelineExecutionCommand {
    constructor(readonly input: unknown) {}
  }
  class StopPipelineExecutionCommand {
    constructor(readonly input: unknown) {}
  }
  class EnableStageTransitionCommand {
    constructor(readonly input: unknown) {}
  }
  class DisableStageTransitionCommand {
    constructor(readonly input: unknown) {}
  }
  class DeletePipelineCommand {
    constructor(readonly input: unknown) {}
  }
  // Placeholders only — owned by the separate "test-author 4b" pass
  // (getPipeline/createPipeline/updatePipeline + the declaration model).
  // Left here, unused by any test in this file, so that pass can extend the
  // bag's `vi.mock` factory return value without restructuring it.
  class GetPipelineCommand {
    constructor(readonly input: unknown) {}
  }
  class CreatePipelineCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdatePipelineCommand {
    constructor(readonly input: unknown) {}
  }

  return {
    send,
    destroy,
    CodePipelineClient,
    ListPipelinesCommand,
    GetPipelineStateCommand,
    ListPipelineExecutionsCommand,
    GetPipelineExecutionCommand,
    StartPipelineExecutionCommand,
    StopPipelineExecutionCommand,
    EnableStageTransitionCommand,
    DisableStageTransitionCommand,
    DeletePipelineCommand,
    GetPipelineCommand,
    CreatePipelineCommand,
    UpdatePipelineCommand,
  };
});

vi.mock("@aws-sdk/client-codepipeline", async (importOriginal) => {
  // Preserve the real (data-only) enum objects — client.ts validates
  // caller-supplied write-path enum fields against these at runtime
  // (`assertKnownEnumValue`); only the command classes and client need the
  // hoisted mock/stub treatment.
  const actual = await importOriginal<typeof CodePipelineSdkModule>();
  return {
    ActionCategory: actual.ActionCategory,
    ActionOwner: actual.ActionOwner,
    ArtifactStoreType: actual.ArtifactStoreType,
    EncryptionKeyType: actual.EncryptionKeyType,
    ExecutionMode: actual.ExecutionMode,
    PipelineType: actual.PipelineType,
    CodePipelineClient: h.CodePipelineClient,
    ListPipelinesCommand: h.ListPipelinesCommand,
    GetPipelineStateCommand: h.GetPipelineStateCommand,
    ListPipelineExecutionsCommand: h.ListPipelineExecutionsCommand,
    GetPipelineExecutionCommand: h.GetPipelineExecutionCommand,
    StartPipelineExecutionCommand: h.StartPipelineExecutionCommand,
    StopPipelineExecutionCommand: h.StopPipelineExecutionCommand,
    EnableStageTransitionCommand: h.EnableStageTransitionCommand,
    DisableStageTransitionCommand: h.DisableStageTransitionCommand,
    DeletePipelineCommand: h.DeletePipelineCommand,
    GetPipelineCommand: h.GetPipelineCommand,
    CreatePipelineCommand: h.CreatePipelineCommand,
    UpdatePipelineCommand: h.UpdatePipelineCommand,
  };
});

import type { CodePipelineClient } from "@aws-sdk/client-codepipeline";

import type {
  M3LCodePipelineActionDeclaration,
  M3LCodePipelineActionExecution,
  M3LCodePipelineActionState,
  M3LCodePipelineActionTypeId,
  M3LCodePipelineArtifactStore,
  M3LCodePipelineCreatePipelineInput,
  M3LCodePipelineDeclaration,
  M3LCodePipelineDefinition,
  M3LCodePipelineDisableStageTransitionInput,
  M3LCodePipelineEnableStageTransitionInput,
  M3LCodePipelineEncryptionKey,
  M3LCodePipelineExecution,
  M3LCodePipelineExecutionSummary,
  M3LCodePipelineListPipelinesResult,
  M3LCodePipelineMetadata,
  M3LCodePipelineStageDeclaration,
  M3LCodePipelineStageState,
  M3LCodePipelineStageTransitionType,
  M3LCodePipelineStartExecutionResult,
  M3LCodePipelineState,
  M3LCodePipelineStopExecutionResult,
  M3LCodePipelineSummary,
  M3LCodePipelineTag,
  M3LCodePipelineVariableDeclaration,
} from "../src/aws/codepipeline/index.js";
import {
  M3LCodePipelineOperationError,
  M3LCodePipelineOperations,
} from "../src/aws/codepipeline/index.js";

const PIPELINE_NAME = "demo-pipeline";
const EXECUTION_ID = "exec-1234";

/** Casts the hoisted fake `CodePipelineClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): CodePipelineClient {
  return new h.CodePipelineClient() as unknown as CodePipelineClient;
}

/** Builds an `Error` with the given `.name`, matching the SDK's named-exception classification shape. */
function namedError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * A complete declaration exercising every nested
 * `M3LCodePipelineDeclaration` type — used to round-trip `getPipeline`,
 * `createPipeline`, and `updatePipeline` against
 * {@link SDK_PIPELINE_DECLARATION} below (this module's own vocabulary:
 * plain `string[]` artifacts, no `{ name }` wrapper).
 */
const FULL_DECLARATION: M3LCodePipelineDeclaration = {
  name: PIPELINE_NAME,
  roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
  stages: [
    {
      name: "Source",
      actions: [
        {
          name: "SourceAction",
          actionTypeId: {
            category: "Source",
            owner: "AWS",
            provider: "CodeStarSourceConnection",
            version: "1",
          },
          runOrder: 1,
          configuration: {
            ConnectionArn:
              "arn:aws:codeconnections:us-east-1:123456789012:connection/abc",
          },
          outputArtifacts: ["SourceOutput"],
          roleArn: "arn:aws:iam::123456789012:role/source-role",
          region: "us-east-1",
          namespace: "SourceVariables",
          timeoutInMinutes: 5,
        },
      ],
    },
    {
      name: "Deploy",
      actions: [
        {
          name: "DeployAction",
          actionTypeId: {
            category: "Deploy",
            owner: "AWS",
            provider: "CloudFormation",
            version: "1",
          },
          inputArtifacts: ["SourceOutput"],
        },
      ],
    },
  ],
  artifactStore: {
    type: "S3",
    location: "demo-pipeline-artifacts",
    encryptionKey: {
      id: "arn:aws:kms:us-east-1:123456789012:key/abcd-1234",
      type: "KMS",
    },
  },
  version: 3,
  pipelineType: "V2",
  executionMode: "QUEUED",
  variables: [
    {
      name: "Environment",
      defaultValue: "staging",
      description: "target environment",
    },
  ],
};

/**
 * The SDK response/request shape of {@link FULL_DECLARATION} — the same
 * declaration, but with `inputArtifacts`/`outputArtifacts` wrapped as
 * `{ name }[]` (the SDK's `InputArtifact`/`OutputArtifact` shape) instead of
 * plain `string[]`.
 */
const SDK_PIPELINE_DECLARATION = {
  name: PIPELINE_NAME,
  roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
  stages: [
    {
      name: "Source",
      actions: [
        {
          name: "SourceAction",
          actionTypeId: {
            category: "Source",
            owner: "AWS",
            provider: "CodeStarSourceConnection",
            version: "1",
          },
          runOrder: 1,
          configuration: {
            ConnectionArn:
              "arn:aws:codeconnections:us-east-1:123456789012:connection/abc",
          },
          outputArtifacts: [{ name: "SourceOutput" }],
          roleArn: "arn:aws:iam::123456789012:role/source-role",
          region: "us-east-1",
          namespace: "SourceVariables",
          timeoutInMinutes: 5,
        },
      ],
    },
    {
      name: "Deploy",
      actions: [
        {
          name: "DeployAction",
          actionTypeId: {
            category: "Deploy",
            owner: "AWS",
            provider: "CloudFormation",
            version: "1",
          },
          inputArtifacts: [{ name: "SourceOutput" }],
        },
      ],
    },
  ],
  artifactStore: {
    type: "S3",
    location: "demo-pipeline-artifacts",
    encryptionKey: {
      id: "arn:aws:kms:us-east-1:123456789012:key/abcd-1234",
      type: "KMS",
    },
  },
  version: 3,
  pipelineType: "V2",
  executionMode: "QUEUED",
  variables: [
    {
      name: "Environment",
      defaultValue: "staging",
      description: "target environment",
    },
  ],
};

describe("M3LCodePipelineOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  describe("listPipelines", () => {
    test("resolves the mapped page on a successful ListPipelines call", async () => {
      h.send.mockResolvedValueOnce({
        pipelines: [{ name: PIPELINE_NAME, version: 3 }],
        nextToken: "page-2",
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelines();

      expect(result).toEqual<M3LCodePipelineListPipelinesResult>({
        pipelines: [{ name: PIPELINE_NAME, version: 3 }],
        nextToken: "page-2",
      });
    });

    test("resolves pipelines as an empty array when the SDK omits pipelines", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelines();

      expect(result.pipelines).toEqual([]);
    });

    test("forwards the caller's nextToken and maxResults onto the constructed ListPipelinesCommand", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.listPipelines({
        nextToken: "caller-token",
        maxResults: 50,
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { nextToken?: string; maxResults?: number } },
      ];
      expect(command.input.nextToken).toBe("caller-token");
      expect(command.input.maxResults).toBe(50);
    });

    test("throws M3LCodePipelineOperationError on a generic ListPipelines failure", async () => {
      const cause = new Error("throttled");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.listPipelines();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });

    test("throws M3LCodePipelineOperationError on a ValidationException rejection, never resolving it as benign", async () => {
      h.send.mockRejectedValueOnce(
        namedError("ValidationException", "1 validation error detected"),
      );

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(operations.listPipelines()).rejects.toBeInstanceOf(
        M3LCodePipelineOperationError,
      );
    });

    test("maps pipelineType/executionMode/created/updated when the SDK PipelineSummary includes them", async () => {
      h.send.mockResolvedValueOnce({
        pipelines: [
          {
            name: PIPELINE_NAME,
            version: 5,
            pipelineType: "V2",
            executionMode: "PARALLEL",
            created: new Date("2026-02-01T00:00:00.000Z"),
            updated: new Date("2026-02-02T00:00:00.000Z"),
          },
        ],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelines();

      expect(result.pipelines).toEqual<readonly M3LCodePipelineSummary[]>([
        {
          name: PIPELINE_NAME,
          version: 5,
          pipelineType: "V2",
          executionMode: "PARALLEL",
          created: "2026-02-01T00:00:00.000Z",
          updated: "2026-02-02T00:00:00.000Z",
        },
      ]);
    });

    test("defaults name to '' when a PipelineSummary omits it", async () => {
      h.send.mockResolvedValueOnce({ pipelines: [{}] });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelines();

      expect(result.pipelines).toEqual([{ name: "" }]);
    });
  });

  describe("getPipelineState", () => {
    test("resolves the mapped state on a successful GetPipelineState call", async () => {
      h.send.mockResolvedValueOnce({
        pipelineName: PIPELINE_NAME,
        pipelineVersion: 2,
        stageStates: [{ stageName: "Source", actionStates: [] }],
        created: new Date("2026-01-01T00:00:00.000Z"),
        updated: new Date("2026-01-02T00:00:00.000Z"),
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineState>({
        pipelineName: PIPELINE_NAME,
        pipelineVersion: 2,
        stageStates: [{ stageName: "Source", actionStates: [] }],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-02T00:00:00.000Z",
      });
    });

    test("defaults stageStates to an empty array when the SDK omits it (sparse response, not a mapping error)", async () => {
      h.send.mockResolvedValueOnce({ pipelineName: PIPELINE_NAME });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineState>({
        pipelineName: PIPELINE_NAME,
        stageStates: [],
      });
    });

    test("resolves undefined on PipelineNotFoundException, classified by .name not instanceof", async () => {
      h.send.mockRejectedValueOnce(namedError("PipelineNotFoundException"));

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.getPipelineState("missing-pipeline"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LCodePipelineOperationError on any other rejection", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getPipelineState(PIPELINE_NAME);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });

    test("maps stageStates[].actionStates[].latestExecution (every field, including errorDetails flattening), entityUrl/revisionUrl, inboundTransitionState, and stageStates[].latestExecution when the SDK response is fully populated", async () => {
      h.send.mockResolvedValueOnce({
        pipelineName: PIPELINE_NAME,
        stageStates: [
          {
            stageName: "Deploy",
            actionStates: [
              {
                actionName: "DeployAction",
                latestExecution: {
                  status: "Succeeded",
                  actionExecutionId: "action-exec-1",
                  summary: "Deployment succeeded",
                  lastStatusChange: new Date("2026-01-05T00:00:00.000Z"),
                  lastUpdatedBy: "codepipeline-service",
                  externalExecutionId: "ext-exec-1",
                  externalExecutionUrl: "https://example.com/ext-exec-1",
                  percentComplete: 100,
                  errorDetails: {
                    code: "JobFailed",
                    message: "deployment failed",
                  },
                  // A live SDK response includes the manual-approval token —
                  // this fixture proves the mapper drops it, not just that
                  // the type doesn't declare it (a future `{ ...execution }`
                  // mapper regression would type-check but fail this
                  // toEqual, since token is absent from the expected value
                  // below).
                  token: "approval-token-should-never-surface",
                },
                entityUrl: "https://example.com/entity",
                revisionUrl: "https://example.com/revision",
              },
            ],
            inboundTransitionState: {
              enabled: true,
              lastChangedBy: "user@example.com",
              lastChangedAt: new Date("2026-01-04T00:00:00.000Z"),
              disabledReason: "maintenance window",
            },
            latestExecution: {
              pipelineExecutionId: EXECUTION_ID,
              status: "InProgress",
              type: "STANDARD",
            },
          },
        ],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineState>({
        pipelineName: PIPELINE_NAME,
        stageStates: [
          {
            stageName: "Deploy",
            actionStates: [
              {
                actionName: "DeployAction",
                latestExecution: {
                  status: "Succeeded",
                  actionExecutionId: "action-exec-1",
                  summary: "Deployment succeeded",
                  lastStatusChange: "2026-01-05T00:00:00.000Z",
                  lastUpdatedBy: "codepipeline-service",
                  externalExecutionId: "ext-exec-1",
                  externalExecutionUrl: "https://example.com/ext-exec-1",
                  percentComplete: 100,
                  errorCode: "JobFailed",
                  errorMessage: "deployment failed",
                },
                entityUrl: "https://example.com/entity",
                revisionUrl: "https://example.com/revision",
              },
            ],
            inboundTransitionState: {
              enabled: true,
              lastChangedBy: "user@example.com",
              lastChangedAt: "2026-01-04T00:00:00.000Z",
              disabledReason: "maintenance window",
            },
            latestExecution: {
              pipelineExecutionId: EXECUTION_ID,
              status: "InProgress",
              type: "STANDARD",
            },
          },
        ],
      });
    });

    test("defaults pipelineName/stageName and omits actionStates[]/inboundTransitionState/latestExecution when the SDK response is maximally sparse", async () => {
      h.send.mockResolvedValueOnce({
        stageStates: [{}],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineState>({
        pipelineName: "",
        stageStates: [{ stageName: "", actionStates: [] }],
      });
    });

    test("defaults actionStates[].actionName and stageStates[].latestExecution's pipelineExecutionId/status when nested sub-objects are present but empty, omitting entityUrl/revisionUrl/inboundTransitionState fields and StageExecution.type", async () => {
      h.send.mockResolvedValueOnce({
        pipelineName: PIPELINE_NAME,
        stageStates: [
          {
            stageName: "Source",
            actionStates: [{}],
            inboundTransitionState: {},
            latestExecution: {},
          },
        ],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineState>({
        pipelineName: PIPELINE_NAME,
        stageStates: [
          {
            stageName: "Source",
            actionStates: [{ actionName: "" }],
            inboundTransitionState: {},
            latestExecution: { pipelineExecutionId: "", status: "" },
          },
        ],
      });
    });

    test("maps an ActionState's latestExecution as {} when the SDK's ActionExecution has every optional field omitted", async () => {
      h.send.mockResolvedValueOnce({
        pipelineName: PIPELINE_NAME,
        stageStates: [
          {
            stageName: "Source",
            actionStates: [{ actionName: "SourceAction", latestExecution: {} }],
          },
        ],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineState(PIPELINE_NAME);

      expect(
        result?.stageStates[0]?.actionStates[0],
      ).toEqual<M3LCodePipelineActionState>({
        actionName: "SourceAction",
        latestExecution: {},
      });
    });
  });

  describe("listPipelineExecutions", () => {
    test("resolves the mapped page on a successful ListPipelineExecutions call", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecutionSummaries: [
          { pipelineExecutionId: EXECUTION_ID, status: "Succeeded" },
        ],
        nextToken: "page-2",
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelineExecutions(PIPELINE_NAME);

      expect(result).toEqual({
        executionSummaries: [
          { pipelineExecutionId: EXECUTION_ID, status: "Succeeded" },
        ],
        nextToken: "page-2",
      });
    });

    test("resolves executionSummaries as an empty array when the SDK omits pipelineExecutionSummaries", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelineExecutions(PIPELINE_NAME);

      expect(result.executionSummaries).toEqual([]);
    });

    test("forwards the caller's nextToken and maxResults onto the constructed ListPipelineExecutionsCommand", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.listPipelineExecutions(PIPELINE_NAME, {
        nextToken: "caller-token",
        maxResults: 25,
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            pipelineName?: string;
            nextToken?: string;
            maxResults?: number;
          };
        },
      ];
      expect(command.input.pipelineName).toBe(PIPELINE_NAME);
      expect(command.input.nextToken).toBe("caller-token");
      expect(command.input.maxResults).toBe(25);
    });

    test("throws (does not resolve an empty page) on PipelineNotFoundException — not classified for this listing call", async () => {
      h.send.mockRejectedValueOnce(namedError("PipelineNotFoundException"));

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.listPipelineExecutions("missing-pipeline"),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("throws M3LCodePipelineOperationError on a generic ListPipelineExecutions failure", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.listPipelineExecutions(PIPELINE_NAME),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("maps statusSummary/startTime/lastUpdateTime/executionMode/executionType/trigger/stopTriggerReason when the SDK PipelineExecutionSummary includes them", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecutionSummaries: [
          {
            pipelineExecutionId: EXECUTION_ID,
            status: "Failed",
            statusSummary: "Stage Deploy failed",
            startTime: new Date("2026-01-10T00:00:00.000Z"),
            lastUpdateTime: new Date("2026-01-10T01:00:00.000Z"),
            executionMode: "SUPERSEDED",
            executionType: "ROLLBACK",
            trigger: {
              triggerType: "StartPipelineExecution",
              triggerDetail: "manual-trigger",
            },
            stopTrigger: { reason: "operator requested stop" },
          },
        ],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelineExecutions(PIPELINE_NAME);

      expect(result.executionSummaries).toEqual<
        readonly M3LCodePipelineExecutionSummary[]
      >([
        {
          pipelineExecutionId: EXECUTION_ID,
          status: "Failed",
          statusSummary: "Stage Deploy failed",
          startTime: "2026-01-10T00:00:00.000Z",
          lastUpdateTime: "2026-01-10T01:00:00.000Z",
          executionMode: "SUPERSEDED",
          executionType: "ROLLBACK",
          trigger: {
            triggerType: "StartPipelineExecution",
            triggerDetail: "manual-trigger",
          },
          stopTriggerReason: "operator requested stop",
        },
      ]);
    });

    test("defaults pipelineExecutionId/status to '' when a PipelineExecutionSummary omits the required-nullable strings", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecutionSummaries: [{}],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.listPipelineExecutions(PIPELINE_NAME);

      expect(result.executionSummaries).toEqual([
        { pipelineExecutionId: "", status: "" },
      ]);
    });
  });

  describe("getPipelineExecution", () => {
    test("resolves the mapped execution on a successful GetPipelineExecution call", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecution: {
          pipelineExecutionId: EXECUTION_ID,
          pipelineName: PIPELINE_NAME,
          status: "InProgress",
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineExecution(
        PIPELINE_NAME,
        EXECUTION_ID,
      );

      expect(result).toEqual<M3LCodePipelineExecution>({
        pipelineExecutionId: EXECUTION_ID,
        pipelineName: PIPELINE_NAME,
        status: "InProgress",
      });
    });

    test.each([
      ["PipelineNotFoundException"],
      ["PipelineExecutionNotFoundException"],
    ])("resolves undefined on %s", async (exceptionName: string) => {
      h.send.mockRejectedValueOnce(namedError(exceptionName));

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.getPipelineExecution(PIPELINE_NAME, EXECUTION_ID),
      ).resolves.toBeUndefined();
    });

    test("throws M3LCodePipelineOperationError when the SDK omits pipelineExecution on an otherwise-successful response (anomaly, not a not-found signal)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.getPipelineExecution(PIPELINE_NAME, EXECUTION_ID),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("throws M3LCodePipelineOperationError on any other rejection", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getPipelineExecution(PIPELINE_NAME, EXECUTION_ID);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });

    test("maps statusSummary/pipelineVersion/executionMode/executionType/trigger when the SDK GetPipelineExecution response includes them", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecution: {
          pipelineExecutionId: EXECUTION_ID,
          pipelineName: PIPELINE_NAME,
          status: "Succeeded",
          statusSummary: "Deployment complete",
          pipelineVersion: 4,
          executionMode: "QUEUED",
          executionType: "STANDARD",
          trigger: {
            triggerType: "Webhook",
            triggerDetail:
              "arn:aws:codepipeline:us-east-1:123456789012:webhook/abc",
          },
          // A live SDK response includes resolved pipeline-variable values
          // and artifact revisions — this fixture proves the mapper drops
          // both, not just that the type doesn't declare them (a future
          // `{ ...execution }` mapper regression would type-check but fail
          // this toEqual, since neither is in the expected value below).
          variables: [{ name: "env", resolvedValue: "production-secret" }],
          artifactRevisions: [
            {
              name: "SourceArtifact",
              revisionId: "abc123",
              revisionSummary: "fix: patch CVE-2026-0001 in prod credentials",
            },
          ],
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineExecution(
        PIPELINE_NAME,
        EXECUTION_ID,
      );

      expect(result).toEqual<M3LCodePipelineExecution>({
        pipelineExecutionId: EXECUTION_ID,
        pipelineName: PIPELINE_NAME,
        status: "Succeeded",
        statusSummary: "Deployment complete",
        pipelineVersion: 4,
        executionMode: "QUEUED",
        executionType: "STANDARD",
        trigger: {
          triggerType: "Webhook",
          triggerDetail:
            "arn:aws:codepipeline:us-east-1:123456789012:webhook/abc",
        },
      });
    });

    test("defaults pipelineExecutionId/pipelineName/status to '' when the SDK response omits the required-nullable strings", async () => {
      h.send.mockResolvedValueOnce({ pipelineExecution: {} });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineExecution(
        PIPELINE_NAME,
        EXECUTION_ID,
      );

      expect(result).toEqual<M3LCodePipelineExecution>({
        pipelineExecutionId: "",
        pipelineName: "",
        status: "",
      });
    });

    test("maps trigger as {} when the SDK's ExecutionTrigger has neither triggerType nor triggerDetail", async () => {
      h.send.mockResolvedValueOnce({
        pipelineExecution: {
          pipelineExecutionId: EXECUTION_ID,
          pipelineName: PIPELINE_NAME,
          status: "InProgress",
          trigger: {},
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipelineExecution(
        PIPELINE_NAME,
        EXECUTION_ID,
      );

      expect(result?.trigger).toEqual({});
    });
  });

  describe("startPipelineExecution", () => {
    test("resolves { pipelineExecutionId } on a successful StartPipelineExecution call", async () => {
      h.send.mockResolvedValueOnce({ pipelineExecutionId: EXECUTION_ID });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.startPipelineExecution(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineStartExecutionResult>({
        pipelineExecutionId: EXECUTION_ID,
      });
    });

    test("forwards the caller's clientRequestToken onto the constructed StartPipelineExecutionCommand", async () => {
      h.send.mockResolvedValueOnce({ pipelineExecutionId: EXECUTION_ID });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.startPipelineExecution(PIPELINE_NAME, {
        clientRequestToken: "not-a-real-token",
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { name?: string; clientRequestToken?: string } },
      ];
      expect(command.input.name).toBe(PIPELINE_NAME);
      expect(command.input.clientRequestToken).toBe("not-a-real-token");
    });

    test.each([
      ["ConcurrentPipelineExecutionsLimitExceededException"],
      ["ConflictException"],
      ["PipelineNotFoundException"],
    ])(
      "throws M3LCodePipelineOperationError on %s — not classified as data for this mutation",
      async (exceptionName: string) => {
        h.send.mockRejectedValueOnce(namedError(exceptionName));

        const operations = new M3LCodePipelineOperations(fakeClient());

        await expect(
          operations.startPipelineExecution(PIPELINE_NAME),
        ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
      },
    );

    test("throws M3LCodePipelineOperationError when the SDK omits pipelineExecutionId on an otherwise-successful response (anomaly)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.startPipelineExecution(PIPELINE_NAME),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });
  });

  describe("stopPipelineExecution", () => {
    test("resolves { pipelineExecutionId } on a successful StopPipelineExecution call", async () => {
      h.send.mockResolvedValueOnce({ pipelineExecutionId: EXECUTION_ID });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.stopPipelineExecution({
        pipelineName: PIPELINE_NAME,
        pipelineExecutionId: EXECUTION_ID,
      });

      expect(result).toEqual<M3LCodePipelineStopExecutionResult>({
        pipelineExecutionId: EXECUTION_ID,
      });
    });

    test.each([
      ["DuplicatedStopRequestException"],
      ["PipelineExecutionNotStoppableException"],
      ["ConflictException"],
      ["PipelineNotFoundException"],
    ])(
      "throws M3LCodePipelineOperationError on %s — not classified as data",
      async (exceptionName: string) => {
        h.send.mockRejectedValueOnce(namedError(exceptionName));

        const operations = new M3LCodePipelineOperations(fakeClient());

        await expect(
          operations.stopPipelineExecution({
            pipelineName: PIPELINE_NAME,
            pipelineExecutionId: EXECUTION_ID,
          }),
        ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
      },
    );

    test("throws M3LCodePipelineOperationError when the SDK omits pipelineExecutionId on an otherwise-successful response (anomaly)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.stopPipelineExecution({
          pipelineName: PIPELINE_NAME,
          pipelineExecutionId: EXECUTION_ID,
        }),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("forwards the caller's abandon and reason onto the constructed StopPipelineExecutionCommand", async () => {
      h.send.mockResolvedValueOnce({ pipelineExecutionId: EXECUTION_ID });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.stopPipelineExecution({
        pipelineName: PIPELINE_NAME,
        pipelineExecutionId: EXECUTION_ID,
        abandon: true,
        reason: "rolling back a bad deploy",
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { abandon?: boolean; reason?: string } },
      ];
      expect(command.input.abandon).toBe(true);
      expect(command.input.reason).toBe("rolling back a bad deploy");
    });
  });

  describe("enableStageTransition", () => {
    test("resolves void on a successful EnableStageTransition call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.enableStageTransition({
          pipelineName: PIPELINE_NAME,
          stageName: "Deploy",
          transitionType: "Inbound",
        }),
      ).resolves.toBeUndefined();
    });

    test.each([["StageNotFoundException"], ["PipelineNotFoundException"]])(
      "throws M3LCodePipelineOperationError on %s — not classified as data",
      async (exceptionName: string) => {
        h.send.mockRejectedValueOnce(namedError(exceptionName));

        const operations = new M3LCodePipelineOperations(fakeClient());

        await expect(
          operations.enableStageTransition({
            pipelineName: PIPELINE_NAME,
            stageName: "Deploy",
            transitionType: "Outbound",
          }),
        ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
      },
    );
  });

  describe("disableStageTransition", () => {
    test("resolves void on a successful DisableStageTransition call, forwarding the required reason", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.disableStageTransition({
          pipelineName: PIPELINE_NAME,
          stageName: "Deploy",
          transitionType: "Outbound",
          reason: "investigating a failed deployment",
        }),
      ).resolves.toBeUndefined();

      const [command] = h.send.mock.calls[0] as [
        { input: { reason?: string } },
      ];
      expect(command.input.reason).toBe("investigating a failed deployment");
    });

    test.each([["StageNotFoundException"], ["PipelineNotFoundException"]])(
      "throws M3LCodePipelineOperationError on %s — not classified as data",
      async (exceptionName: string) => {
        h.send.mockRejectedValueOnce(namedError(exceptionName));

        const operations = new M3LCodePipelineOperations(fakeClient());

        await expect(
          operations.disableStageTransition({
            pipelineName: PIPELINE_NAME,
            stageName: "Deploy",
            transitionType: "Inbound",
            reason: "pausing inbound artifacts",
          }),
        ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
      },
    );
  });

  describe("deletePipeline", () => {
    test("resolves void on a successful DeletePipeline call", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.deletePipeline(PIPELINE_NAME),
      ).resolves.toBeUndefined();
    });

    test("resolves void, rather than throwing, on an already-absent pipeline — DeletePipeline declares no PipelineNotFoundException, so this is a genuine no-op success passed straight through", async () => {
      // No special-casing here: the mock simply resolves normally, exactly
      // as the real DeletePipeline call does against an already-absent
      // pipeline (unlike stopPipelineExecution's explicit exception list).
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.deletePipeline("already-absent-pipeline"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LCodePipelineOperationError on a generic DeletePipeline failure", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.deletePipeline(PIPELINE_NAME);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });
  });

  describe("M3LCodePipelineOperationError", () => {
    test("carries the ERR_CODEPIPELINE_OPERATION code", () => {
      const error = new M3LCodePipelineOperationError("boom");

      expect(error.code).toBe("ERR_CODEPIPELINE_OPERATION");
    });

    test("chains the underlying cause when supplied", () => {
      const cause = new Error("underlying SDK failure");
      const error = new M3LCodePipelineOperationError("boom", { cause });

      expect(error.cause).toBe(cause);
    });
  });

  describe("type contract", () => {
    test("listPipelines resolves M3LCodePipelineListPipelinesResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["listPipelines"]>>
      >().toEqualTypeOf<M3LCodePipelineListPipelinesResult>();
    });

    test("M3LCodePipelineListPipelinesResult shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineListPipelinesResult>().toEqualTypeOf<{
        readonly pipelines: readonly M3LCodePipelineSummary[];
        readonly nextToken?: string;
      }>();
    });

    test("M3LCodePipelineSummary shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineSummary>().toEqualTypeOf<{
        readonly name: string;
        readonly version?: number;
        readonly pipelineType?: string;
        readonly executionMode?: string;
        readonly created?: string;
        readonly updated?: string;
      }>();
    });

    test("getPipelineState resolves M3LCodePipelineState | undefined", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["getPipelineState"]>>
      >().toEqualTypeOf<M3LCodePipelineState | undefined>();
    });

    test("M3LCodePipelineState shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineState>().toMatchTypeOf<{
        readonly pipelineName: string;
        readonly stageStates: readonly M3LCodePipelineStageState[];
        readonly pipelineVersion?: number;
      }>();
    });

    test("M3LCodePipelineStageState shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineStageState>().toMatchTypeOf<{
        readonly stageName: string;
        readonly actionStates: readonly M3LCodePipelineActionState[];
      }>();
    });

    test("M3LCodePipelineActionState shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineActionState>().toMatchTypeOf<{
        readonly actionName: string;
        readonly latestExecution?: M3LCodePipelineActionExecution;
      }>();
    });

    test("M3LCodePipelineActionExecution shape matches the documented contract (every field optional)", () => {
      expectTypeOf<M3LCodePipelineActionExecution>().toEqualTypeOf<{
        readonly status?: string;
        readonly actionExecutionId?: string;
        readonly summary?: string;
        readonly lastStatusChange?: string;
        readonly lastUpdatedBy?: string;
        readonly externalExecutionId?: string;
        readonly externalExecutionUrl?: string;
        readonly percentComplete?: number;
        readonly errorCode?: string;
        readonly errorMessage?: string;
      }>();
    });

    test("M3LCodePipelineActionExecution never surfaces a token field (approvals out of scope)", () => {
      expectTypeOf<M3LCodePipelineActionExecution>().not.toHaveProperty(
        "token",
      );
    });

    test("listPipelineExecutions resolves executionSummaries always as an array", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["listPipelineExecutions"]>>
      >().toMatchTypeOf<{
        readonly executionSummaries: readonly M3LCodePipelineExecutionSummary[];
        readonly nextToken?: string;
      }>();
    });

    test("M3LCodePipelineExecutionSummary shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineExecutionSummary>().toMatchTypeOf<{
        readonly pipelineExecutionId: string;
        readonly status: string;
        readonly stopTriggerReason?: string;
      }>();
    });

    test("getPipelineExecution resolves M3LCodePipelineExecution | undefined", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["getPipelineExecution"]>>
      >().toEqualTypeOf<M3LCodePipelineExecution | undefined>();
    });

    test("M3LCodePipelineExecution shape matches the documented contract and never surfaces variables/artifactRevisions", () => {
      expectTypeOf<M3LCodePipelineExecution>().toMatchTypeOf<{
        readonly pipelineExecutionId: string;
        readonly pipelineName: string;
        readonly status: string;
      }>();
      expectTypeOf<M3LCodePipelineExecution>().not.toHaveProperty("variables");
      expectTypeOf<M3LCodePipelineExecution>().not.toHaveProperty(
        "artifactRevisions",
      );
    });

    test("startPipelineExecution resolves M3LCodePipelineStartExecutionResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["startPipelineExecution"]>>
      >().toEqualTypeOf<M3LCodePipelineStartExecutionResult>();
    });

    test("M3LCodePipelineStartExecutionResult is exactly { pipelineExecutionId: string }", () => {
      expectTypeOf<M3LCodePipelineStartExecutionResult>().toEqualTypeOf<{
        readonly pipelineExecutionId: string;
      }>();
    });

    test("stopPipelineExecution resolves M3LCodePipelineStopExecutionResult", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["stopPipelineExecution"]>>
      >().toEqualTypeOf<M3LCodePipelineStopExecutionResult>();
    });

    test("M3LCodePipelineStopExecutionResult is exactly { pipelineExecutionId: string }", () => {
      expectTypeOf<M3LCodePipelineStopExecutionResult>().toEqualTypeOf<{
        readonly pipelineExecutionId: string;
      }>();
    });

    test("enableStageTransition resolves void", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["enableStageTransition"]>>
      >().toEqualTypeOf<void>();
    });

    test("disableStageTransition resolves void", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["disableStageTransition"]>>
      >().toEqualTypeOf<void>();
    });

    test("M3LCodePipelineStageTransitionType is the closed union 'Inbound' | 'Outbound'", () => {
      expectTypeOf<M3LCodePipelineStageTransitionType>().toEqualTypeOf<
        "Inbound" | "Outbound"
      >();
    });

    test("M3LCodePipelineEnableStageTransitionInput has no reason field", () => {
      expectTypeOf<M3LCodePipelineEnableStageTransitionInput>().toEqualTypeOf<{
        readonly pipelineName: string;
        readonly stageName: string;
        readonly transitionType: M3LCodePipelineStageTransitionType;
      }>();
    });

    test("M3LCodePipelineDisableStageTransitionInput requires reason, unlike the enable counterpart", () => {
      expectTypeOf<M3LCodePipelineDisableStageTransitionInput>().toEqualTypeOf<{
        readonly pipelineName: string;
        readonly stageName: string;
        readonly transitionType: M3LCodePipelineStageTransitionType;
        readonly reason: string;
      }>();
    });

    test("deletePipeline resolves void", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["deletePipeline"]>>
      >().toEqualTypeOf<void>();
    });
  });

  // ---------------------------------------------------------------------
  // test-author 4b: getPipeline / createPipeline / updatePipeline and the
  // full declaration model — see docs/reference/aws/codepipeline.md's
  // "The pipeline declaration is a lossy round-trip" section.
  // ---------------------------------------------------------------------

  describe("declaration model fixtures", () => {
    // Exercised indirectly below (round-tripped through getPipeline /
    // createPipeline / updatePipeline); this block only documents the two
    // paired shapes.
    test("FULL_DECLARATION and SDK_PIPELINE_DECLARATION stay structurally paired", () => {
      expect(FULL_DECLARATION.stages).toHaveLength(
        SDK_PIPELINE_DECLARATION.stages.length,
      );
    });
  });

  describe("getPipeline", () => {
    test("resolves the mapped definition (full declaration + metadata) on a successful GetPipeline call", async () => {
      h.send.mockResolvedValueOnce({
        pipeline: SDK_PIPELINE_DECLARATION,
        metadata: {
          pipelineArn:
            "arn:aws:codepipeline:us-east-1:123456789012:demo-pipeline",
          created: new Date("2026-01-01T00:00:00.000Z"),
          updated: new Date("2026-01-02T00:00:00.000Z"),
          pollingDisabledAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(result).toEqual<M3LCodePipelineDefinition>({
        declaration: FULL_DECLARATION,
        metadata: {
          pipelineArn:
            "arn:aws:codepipeline:us-east-1:123456789012:demo-pipeline",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-02T00:00:00.000Z",
          pollingDisabledAt: "2026-01-03T00:00:00.000Z",
        },
      });
    });

    test("resolves metadata as undefined when the SDK response omits it entirely", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(result?.metadata).toBeUndefined();
    });

    test("resolves undefined on PipelineNotFoundException", async () => {
      h.send.mockRejectedValueOnce(namedError("PipelineNotFoundException"));

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.getPipeline("missing-pipeline"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LCodePipelineOperationError — not undefined — on PipelineVersionNotFoundException when options.version names a nonexistent version", async () => {
      h.send.mockRejectedValueOnce(
        namedError("PipelineVersionNotFoundException"),
      );

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getPipeline(PIPELINE_NAME, { version: 99 });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect(thrown).not.toBeUndefined();
    });

    test("forwards the caller's version onto the constructed GetPipelineCommand", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.getPipeline(PIPELINE_NAME, { version: 2 });

      const [command] = h.send.mock.calls[0] as [
        { input: { name?: string; version?: number } },
      ];
      expect(command.input.name).toBe(PIPELINE_NAME);
      expect(command.input.version).toBe(2);
    });

    test("throws M3LCodePipelineOperationError when the SDK omits pipeline on an otherwise-successful response (anomaly, not a not-found signal)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.getPipeline(PIPELINE_NAME),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("throws M3LCodePipelineOperationError on any other rejection", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getPipeline(PIPELINE_NAME);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });

    test('defaults declaration.name and .roleArn to "" when the SDK response omits the required-nullable strings', async () => {
      h.send.mockResolvedValueOnce({
        pipeline: { stages: [] },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(result?.declaration.name).toBe("");
      expect(result?.declaration.roleArn).toBe("");
    });

    test("collapses the SDK's inputArtifacts/outputArtifacts {name}[] wrapper down to plain string[] on the read path", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(
        result?.declaration.stages[0]?.actions[0]?.outputArtifacts,
      ).toEqual(["SourceOutput"]);
      expect(result?.declaration.stages[1]?.actions[0]?.inputArtifacts).toEqual(
        ["SourceOutput"],
      );
    });

    test("defaults declaration.stages to [] and artifactStore/encryptionKey/variable fields to '' when the SDK response's declaration is sparse", async () => {
      h.send.mockResolvedValueOnce({
        pipeline: {
          name: PIPELINE_NAME,
          roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
          // stages entirely omitted -> defaults to []
          artifactStore: {
            // type/location omitted -> default ""
            encryptionKey: {
              // id/type omitted -> default ""
            },
          },
          variables: [{/* name omitted -> default "" */}],
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(result?.declaration.stages).toEqual([]);
      expect(result?.declaration.artifactStore).toEqual({
        type: "",
        location: "",
        encryptionKey: { id: "", type: "" },
      });
      expect(result?.declaration.variables).toEqual([{ name: "" }]);
    });

    test("defaults stage name/actions, action name/actionTypeId fields, and artifact wrapper name to '' or [] when the SDK response's stages/actions/artifacts are sparse", async () => {
      h.send.mockResolvedValueOnce({
        pipeline: {
          name: PIPELINE_NAME,
          roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
          stages: [
            {
              // name omitted -> default ""
              // actions omitted -> default []
            },
            {
              name: "Deploy",
              actions: [
                {
                  // name omitted -> default ""
                  // actionTypeId omitted -> mapActionTypeId(undefined), every field ""
                  inputArtifacts: [{/* name omitted -> default "" */}],
                  outputArtifacts: [{/* name omitted -> default "" */}],
                },
              ],
            },
          ],
        },
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.getPipeline(PIPELINE_NAME);

      expect(result?.declaration.stages).toEqual([
        { name: "", actions: [] },
        {
          name: "Deploy",
          actions: [
            {
              name: "",
              actionTypeId: {
                category: "",
                owner: "",
                provider: "",
                version: "",
              },
              inputArtifacts: [""],
              outputArtifacts: [""],
            },
          ],
        },
      ]);
    });
  });

  describe("createPipeline", () => {
    test("builds the CreatePipelineCommand's pipeline input from declaration (renamed field)", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.createPipeline({ declaration: FULL_DECLARATION });

      const [command] = h.send.mock.calls[0] as [
        { input: { pipeline?: unknown } },
      ];
      expect(command.input.pipeline).toEqual(SDK_PIPELINE_DECLARATION);
    });

    test("forwards tags onto the constructed CreatePipelineCommand as a 1:1 map (not a collapse)", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.createPipeline({
        declaration: FULL_DECLARATION,
        tags: [{ key: "team", value: "platform" }],
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { tags?: readonly { key?: string; value?: string }[] } },
      ];
      expect(command.input.tags).toEqual([{ key: "team", value: "platform" }]);
    });

    test("resolves the mapped M3LCodePipelineDeclaration on a successful CreatePipeline call", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.createPipeline({
        declaration: FULL_DECLARATION,
      });

      expect(result).toEqual<M3LCodePipelineDeclaration>(FULL_DECLARATION);
    });

    test("drops the response's tags echo from the resolved value", async () => {
      h.send.mockResolvedValueOnce({
        pipeline: SDK_PIPELINE_DECLARATION,
        tags: [{ key: "team", value: "platform" }],
      });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.createPipeline({
        declaration: FULL_DECLARATION,
        tags: [{ key: "team", value: "platform" }],
      });

      expect(result).not.toHaveProperty("tags");
    });

    test("throws M3LCodePipelineOperationError when the SDK omits pipeline on an otherwise-successful response (anomaly)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.createPipeline({ declaration: FULL_DECLARATION }),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("throws M3LCodePipelineOperationError on a generic CreatePipeline failure", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.createPipeline({ declaration: FULL_DECLARATION });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });

    test("rejects an unknown actionTypeId.category before ever calling .send() (earned cast, not a blind `as`)", async () => {
      const operations = new M3LCodePipelineOperations(fakeClient());
      const invalid: M3LCodePipelineDeclaration = {
        ...FULL_DECLARATION,
        stages: [
          {
            name: "Source",
            actions: [
              {
                name: "SourceAction",
                actionTypeId: {
                  category: "NotARealCategory",
                  owner: "AWS",
                  provider: "CodeStarSourceConnection",
                  version: "1",
                },
              },
            ],
          },
        ],
      };

      await expect(
        operations.createPipeline({ declaration: invalid }),
      ).rejects.toThrow(
        "invalid actionTypeId.category=NotARealCategory (expected one of:",
      );
      expect(h.send).not.toHaveBeenCalled();
    });

    test("rejects an unknown artifactStore.type before ever calling .send()", async () => {
      const operations = new M3LCodePipelineOperations(fakeClient());
      const invalid: M3LCodePipelineDeclaration = {
        ...FULL_DECLARATION,
        artifactStore: { type: "NotARealStoreType", location: "some-bucket" },
      };

      await expect(
        operations.createPipeline({ declaration: invalid }),
      ).rejects.toThrow(
        "invalid artifactStore.type=NotARealStoreType (expected one of:",
      );
      expect(h.send).not.toHaveBeenCalled();
    });

    test("rejects an unknown declaration.pipelineType before ever calling .send()", async () => {
      const operations = new M3LCodePipelineOperations(fakeClient());
      const invalid: M3LCodePipelineDeclaration = {
        ...FULL_DECLARATION,
        pipelineType: "V3",
      };

      await expect(
        operations.createPipeline({ declaration: invalid }),
      ).rejects.toThrow(
        "invalid declaration.pipelineType=V3 (expected one of:",
      );
      expect(h.send).not.toHaveBeenCalled();
    });

    test("expands plain string[] inputArtifacts/outputArtifacts to the SDK's {name}[] wrapper on the write path", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.createPipeline({ declaration: FULL_DECLARATION });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            pipeline?: {
              stages?: readonly {
                actions?: readonly {
                  inputArtifacts?: readonly { name?: string }[];
                  outputArtifacts?: readonly { name?: string }[];
                }[];
              }[];
            };
          };
        },
      ];
      const stages = command.input.pipeline?.stages;
      expect(stages?.[0]?.actions?.[0]?.outputArtifacts).toEqual([
        { name: "SourceOutput" },
      ]);
      expect(stages?.[1]?.actions?.[0]?.inputArtifacts).toEqual([
        { name: "SourceOutput" },
      ]);
    });

    test("passes declaration.name and .roleArn straight through on the write path (caller-required, no defaulting)", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.createPipeline({ declaration: FULL_DECLARATION });

      const [command] = h.send.mock.calls[0] as [
        { input: { pipeline?: { name?: string; roleArn?: string } } },
      ];
      expect(command.input.pipeline?.name).toBe(FULL_DECLARATION.name);
      expect(command.input.pipeline?.roleArn).toBe(FULL_DECLARATION.roleArn);
    });
  });

  describe("updatePipeline", () => {
    test("builds the UpdatePipelineCommand's pipeline input directly from the given declaration (no wrapper object)", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      await operations.updatePipeline(FULL_DECLARATION);

      const [command] = h.send.mock.calls[0] as [
        { input: { pipeline?: unknown } },
      ];
      expect(command.input.pipeline).toEqual(SDK_PIPELINE_DECLARATION);
    });

    test("resolves the mapped M3LCodePipelineDeclaration on a successful UpdatePipeline call, round-tripping every nested declaration type", async () => {
      h.send.mockResolvedValueOnce({ pipeline: SDK_PIPELINE_DECLARATION });

      const operations = new M3LCodePipelineOperations(fakeClient());
      const result = await operations.updatePipeline(FULL_DECLARATION);

      expect(result).toEqual<M3LCodePipelineDeclaration>(FULL_DECLARATION);
    });

    test("throws M3LCodePipelineOperationError when the SDK omits pipeline on an otherwise-successful response (anomaly)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LCodePipelineOperations(fakeClient());

      await expect(
        operations.updatePipeline(FULL_DECLARATION),
      ).rejects.toBeInstanceOf(M3LCodePipelineOperationError);
    });

    test("throws M3LCodePipelineOperationError on a generic UpdatePipeline failure", async () => {
      const cause = new Error("access denied");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LCodePipelineOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.updatePipeline(FULL_DECLARATION);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCodePipelineOperationError);
      expect((thrown as M3LCodePipelineOperationError).cause).toBe(cause);
    });
  });

  describe("type contract — declaration model (getPipeline/createPipeline/updatePipeline)", () => {
    test("getPipeline resolves M3LCodePipelineDefinition | undefined", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["getPipeline"]>>
      >().toEqualTypeOf<M3LCodePipelineDefinition | undefined>();
    });

    test("M3LCodePipelineDefinition shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineDefinition>().toEqualTypeOf<{
        readonly declaration: M3LCodePipelineDeclaration;
        readonly metadata?: M3LCodePipelineMetadata;
      }>();
    });

    test("M3LCodePipelineMetadata shape matches the documented contract (every field optional)", () => {
      expectTypeOf<M3LCodePipelineMetadata>().toEqualTypeOf<{
        readonly pipelineArn?: string;
        readonly created?: string;
        readonly updated?: string;
        readonly pollingDisabledAt?: string;
      }>();
    });

    test("createPipeline resolves M3LCodePipelineDeclaration (non-optional, unlike getPipeline)", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["createPipeline"]>>
      >().toEqualTypeOf<M3LCodePipelineDeclaration>();
    });

    test("updatePipeline resolves M3LCodePipelineDeclaration (non-optional)", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LCodePipelineOperations["updatePipeline"]>>
      >().toEqualTypeOf<M3LCodePipelineDeclaration>();
    });

    test("updatePipeline takes a complete declaration directly, not wrapped in an input object", () => {
      expectTypeOf<
        M3LCodePipelineOperations["updatePipeline"]
      >().parameters.toEqualTypeOf<[M3LCodePipelineDeclaration]>();
    });

    test("M3LCodePipelineDeclaration shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineDeclaration>().toEqualTypeOf<{
        readonly name: string;
        readonly roleArn: string;
        readonly stages: readonly M3LCodePipelineStageDeclaration[];
        readonly artifactStore?: M3LCodePipelineArtifactStore;
        readonly version?: number;
        readonly pipelineType?: string;
        readonly executionMode?: string;
        readonly variables?: readonly M3LCodePipelineVariableDeclaration[];
      }>();
    });

    test("M3LCodePipelineStageDeclaration shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineStageDeclaration>().toEqualTypeOf<{
        readonly name: string;
        readonly actions: readonly M3LCodePipelineActionDeclaration[];
      }>();
    });

    test("M3LCodePipelineActionDeclaration shape matches the documented contract, with collapsed string[] artifacts", () => {
      expectTypeOf<M3LCodePipelineActionDeclaration>().toEqualTypeOf<{
        readonly name: string;
        readonly actionTypeId: M3LCodePipelineActionTypeId;
        readonly runOrder?: number;
        readonly configuration?: Readonly<Record<string, string>>;
        readonly inputArtifacts?: readonly string[];
        readonly outputArtifacts?: readonly string[];
        readonly roleArn?: string;
        readonly region?: string;
        readonly namespace?: string;
        readonly timeoutInMinutes?: number;
      }>();
    });

    test("M3LCodePipelineActionTypeId shape matches the documented contract (all required strings, bidirectional)", () => {
      expectTypeOf<M3LCodePipelineActionTypeId>().toEqualTypeOf<{
        readonly category: string;
        readonly owner: string;
        readonly provider: string;
        readonly version: string;
      }>();
    });

    test("M3LCodePipelineArtifactStore shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineArtifactStore>().toEqualTypeOf<{
        readonly type: string;
        readonly location: string;
        readonly encryptionKey?: M3LCodePipelineEncryptionKey;
      }>();
    });

    test("M3LCodePipelineEncryptionKey shape matches the documented contract (both fields required)", () => {
      expectTypeOf<M3LCodePipelineEncryptionKey>().toEqualTypeOf<{
        readonly id: string;
        readonly type: string;
      }>();
    });

    test("M3LCodePipelineVariableDeclaration shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineVariableDeclaration>().toEqualTypeOf<{
        readonly name: string;
        readonly defaultValue?: string;
        readonly description?: string;
      }>();
    });

    test("M3LCodePipelineTag is a 1:1 map — key and value both required, no collapsing transformation (unlike M3LCloudFormationKeyValue)", () => {
      expectTypeOf<M3LCodePipelineTag>().toEqualTypeOf<{
        readonly key: string;
        readonly value: string;
      }>();
    });

    test("M3LCodePipelineCreatePipelineInput shape matches the documented contract", () => {
      expectTypeOf<M3LCodePipelineCreatePipelineInput>().toEqualTypeOf<{
        readonly declaration: M3LCodePipelineDeclaration;
        readonly tags?: readonly M3LCodePipelineTag[];
      }>();
    });
  });
});
