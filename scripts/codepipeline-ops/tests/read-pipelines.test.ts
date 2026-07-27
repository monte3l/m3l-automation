import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readPipelines } from "../src/steps/read-pipelines.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `src/steps/read-pipelines.ts` — `list-pipelines`
 * (`listPipelines({ nextToken, maxResults })`) and `describe-pipeline`
 * (`getPipeline(pipeline, { version })`), never gated (no
 * `prompt`/destructive-gate dependency at all — the deps shape below
 * structurally cannot reach either). Deps arrive already
 * guard-checked/resolved by `run-codepipeline-ops` — this step takes no raw
 * `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readPipelines — list-pipelines", () => {
  test("calls operations.listPipelines({ nextToken, maxResults }) and returns the result unchanged", async () => {
    const result: AWS.M3LCodePipelineListPipelinesResult = {
      pipelines: [{ name: "my-pipeline" }],
      nextToken: "next-token",
    };
    const listPipelines = vi.fn().mockResolvedValue(result);
    const operations = createFakeCodePipelineOperations({ listPipelines });

    const returned = await readPipelines({
      operations,
      operation: "list-pipelines",
      pipeline: undefined,
      version: undefined,
      nextToken: "prev-token",
      maxResults: 25,
    });

    expect(listPipelines).toHaveBeenCalledTimes(1);
    const call = listPipelines.mock.calls[0] as [
      { nextToken?: string; maxResults?: number }?,
    ];
    expect(call[0]?.nextToken).toBe("prev-token");
    expect(call[0]?.maxResults).toBe(25);
    expect(returned).toEqual(result);
  });

  test("omits nextToken/maxResults from the call when unset", async () => {
    const listPipelines = vi.fn().mockResolvedValue({ pipelines: [] });
    const operations = createFakeCodePipelineOperations({ listPipelines });

    await readPipelines({
      operations,
      operation: "list-pipelines",
      pipeline: undefined,
      version: undefined,
      nextToken: undefined,
      maxResults: undefined,
    });

    const call = listPipelines.mock.calls[0] as [
      { nextToken?: string; maxResults?: number }?,
    ];
    expect(call[0]?.nextToken).toBeUndefined();
    expect(call[0]?.maxResults).toBeUndefined();
  });
});

describe("readPipelines — describe-pipeline", () => {
  test("calls operations.getPipeline(pipeline, { version }) and returns the definition unchanged", async () => {
    const definition: AWS.M3LCodePipelineDefinition = {
      declaration: {
        name: "my-pipeline",
        roleArn: "arn:aws:iam::123:role/x",
        stages: [],
      },
      metadata: {
        pipelineArn: "arn:aws:codepipeline:us-east-1:123:my-pipeline",
      },
    };
    const getPipeline = vi.fn().mockResolvedValue(definition);
    const operations = createFakeCodePipelineOperations({ getPipeline });

    const returned = await readPipelines({
      operations,
      operation: "describe-pipeline",
      pipeline: "my-pipeline",
      version: 2,
      nextToken: undefined,
      maxResults: undefined,
    });

    expect(getPipeline).toHaveBeenCalledWith("my-pipeline", { version: 2 });
    expect(returned).toEqual(definition);
  });

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when pipeline is undefined, never calling getPipeline", async () => {
    const getPipeline = vi.fn();
    const operations = createFakeCodePipelineOperations({ getPipeline });

    let thrown: unknown;
    try {
      await readPipelines({
        operations,
        operation: "describe-pipeline",
        pipeline: undefined,
        version: undefined,
        nextToken: undefined,
        maxResults: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_CONFIG");
    expect(getPipeline).not.toHaveBeenCalled();
  });

  test("throws ERR_CODEPIPELINE_OPS_NOT_FOUND when getPipeline resolves undefined", async () => {
    const getPipeline = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({ getPipeline });

    await expect(
      readPipelines({
        operations,
        operation: "describe-pipeline",
        pipeline: "missing-pipeline",
        version: undefined,
        nextToken: undefined,
        maxResults: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_NOT_FOUND" });
  });
});

describe("type contract", () => {
  test("readPipelines resolves the list-or-describe result union", () => {
    expectTypeOf(readPipelines).returns.resolves.toEqualTypeOf<
      AWS.M3LCodePipelineListPipelinesResult | AWS.M3LCodePipelineDefinition
    >();
  });

  test("readPipelines's deps shape is exactly operations/operation/pipeline/version/nextToken/maxResults — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readPipelines>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCodePipelineOperations;
      readonly operation: "list-pipelines" | "describe-pipeline";
      readonly pipeline: string | undefined;
      readonly version: number | undefined;
      readonly nextToken: string | undefined;
      readonly maxResults: number | undefined;
    }>();
  });
});
