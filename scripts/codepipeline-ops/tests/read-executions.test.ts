import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readExecutions } from "../src/steps/read-executions.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `src/steps/read-executions.ts` — `list-executions`
 * (`listPipelineExecutions(pipeline, { nextToken, maxResults })`) and
 * `describe-execution` (`getPipelineExecution(pipeline, executionId)`),
 * never gated (no `prompt`/destructive-gate dependency at all). Deps arrive
 * already guard-checked/resolved by `run-codepipeline-ops` — this step
 * takes no raw `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readExecutions — list-executions", () => {
  test("calls operations.listPipelineExecutions(pipeline, { nextToken, maxResults }) and returns the result unchanged", async () => {
    const result: AWS.M3LCodePipelineListExecutionsResult = {
      executionSummaries: [
        { pipelineExecutionId: "exec-1", status: "Succeeded" },
      ],
      nextToken: "next-token",
    };
    const listPipelineExecutions = vi.fn().mockResolvedValue(result);
    const operations = createFakeCodePipelineOperations({
      listPipelineExecutions,
    });

    const returned = await readExecutions({
      operations,
      operation: "list-executions",
      pipeline: "my-pipeline",
      executionId: undefined,
      nextToken: "prev-token",
      maxResults: 25,
    });

    expect(listPipelineExecutions).toHaveBeenCalledTimes(1);
    const call = listPipelineExecutions.mock.calls[0] as [
      string,
      { nextToken?: string; maxResults?: number }?,
    ];
    expect(call[0]).toBe("my-pipeline");
    expect(call[1]?.nextToken).toBe("prev-token");
    expect(call[1]?.maxResults).toBe(25);
    expect(returned).toEqual(result);
  });

  test("omits nextToken/maxResults from the call when unset", async () => {
    const listPipelineExecutions = vi
      .fn()
      .mockResolvedValue({ executionSummaries: [] });
    const operations = createFakeCodePipelineOperations({
      listPipelineExecutions,
    });

    await readExecutions({
      operations,
      operation: "list-executions",
      pipeline: "my-pipeline",
      executionId: undefined,
      nextToken: undefined,
      maxResults: undefined,
    });

    const call = listPipelineExecutions.mock.calls[0] as [
      string,
      { nextToken?: string; maxResults?: number }?,
    ];
    expect(call[1]?.nextToken).toBeUndefined();
    expect(call[1]?.maxResults).toBeUndefined();
  });
});

describe("readExecutions — describe-execution", () => {
  test("calls operations.getPipelineExecution(pipeline, executionId) and returns the execution unchanged", async () => {
    const execution: AWS.M3LCodePipelineExecution = {
      pipelineExecutionId: "exec-1",
      pipelineName: "my-pipeline",
      status: "Succeeded",
    };
    const getPipelineExecution = vi.fn().mockResolvedValue(execution);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });

    const returned = await readExecutions({
      operations,
      operation: "describe-execution",
      pipeline: "my-pipeline",
      executionId: "exec-1",
      nextToken: undefined,
      maxResults: undefined,
    });

    expect(getPipelineExecution).toHaveBeenCalledWith("my-pipeline", "exec-1");
    expect(returned).toEqual(execution);
  });

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when executionId is undefined, never calling getPipelineExecution", async () => {
    const getPipelineExecution = vi.fn();
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });

    let thrown: unknown;
    try {
      await readExecutions({
        operations,
        operation: "describe-execution",
        pipeline: "my-pipeline",
        executionId: undefined,
        nextToken: undefined,
        maxResults: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_CONFIG");
    expect(getPipelineExecution).not.toHaveBeenCalled();
  });

  test("throws ERR_CODEPIPELINE_OPS_NOT_FOUND when getPipelineExecution resolves undefined", async () => {
    const getPipelineExecution = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({
      getPipelineExecution,
    });

    await expect(
      readExecutions({
        operations,
        operation: "describe-execution",
        pipeline: "my-pipeline",
        executionId: "missing-exec",
        nextToken: undefined,
        maxResults: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_NOT_FOUND" });
  });
});

describe("type contract", () => {
  test("readExecutions resolves the list-or-describe result union", () => {
    expectTypeOf(readExecutions).returns.resolves.toEqualTypeOf<
      AWS.M3LCodePipelineListExecutionsResult | AWS.M3LCodePipelineExecution
    >();
  });

  test("readExecutions's deps shape is exactly operations/operation/pipeline/executionId/nextToken/maxResults — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readExecutions>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCodePipelineOperations;
      readonly operation: "list-executions" | "describe-execution";
      readonly pipeline: string;
      readonly executionId: string | undefined;
      readonly nextToken: string | undefined;
      readonly maxResults: number | undefined;
    }>();
  });
});
