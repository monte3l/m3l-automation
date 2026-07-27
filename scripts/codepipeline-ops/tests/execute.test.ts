import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { execute } from "../src/steps/execute.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `scripts/codepipeline-ops/src/steps/execute.ts` — handles
 * `start-execution`/`stop-execution`. `start-execution` calls
 * `operations.startPipelineExecution(pipeline, { clientRequestToken })`,
 * omitting `clientRequestToken` from the options object entirely when unset
 * (conditional spread). `stop-execution` guard-checks `executionId` present
 * (`ERR_CODEPIPELINE_OPS_CONFIG`), then calls
 * `operations.stopPipelineExecution({ pipelineName, pipelineExecutionId,
 * abandon, reason })`, omitting `reason` when unset. Never touches
 * `destructive-gate`/`prompt` itself.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("execute — start-execution", () => {
  test("calls operations.startPipelineExecution(pipeline, { clientRequestToken }) when set", async () => {
    const result: AWS.M3LCodePipelineStartExecutionResult = {
      pipelineExecutionId: "exec-1",
    };
    const startPipelineExecution = vi.fn().mockResolvedValue(result);
    const operations = createFakeCodePipelineOperations({
      startPipelineExecution,
    });

    const returned = await execute({
      operations,
      operation: "start-execution",
      pipeline: "my-pipeline",
      executionId: undefined,
      clientRequestToken: "token-1",
      abandon: false,
      reason: undefined,
    });

    expect(startPipelineExecution).toHaveBeenCalledWith("my-pipeline", {
      clientRequestToken: "token-1",
    });
    expect(returned).toEqual(result);
  });

  test("omits clientRequestToken from the options object when unset (conditional spread)", async () => {
    const startPipelineExecution = vi
      .fn()
      .mockResolvedValue({ pipelineExecutionId: "exec-1" });
    const operations = createFakeCodePipelineOperations({
      startPipelineExecution,
    });

    await execute({
      operations,
      operation: "start-execution",
      pipeline: "my-pipeline",
      executionId: undefined,
      clientRequestToken: undefined,
      abandon: false,
      reason: undefined,
    });

    const call = startPipelineExecution.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).not.toHaveProperty("clientRequestToken");
  });
});

describe("execute — stop-execution", () => {
  test("calls operations.stopPipelineExecution with pipelineName/pipelineExecutionId/abandon/reason", async () => {
    const result: AWS.M3LCodePipelineStopExecutionResult = {
      pipelineExecutionId: "exec-1",
    };
    const stopPipelineExecution = vi.fn().mockResolvedValue(result);
    const operations = createFakeCodePipelineOperations({
      stopPipelineExecution,
    });

    const returned = await execute({
      operations,
      operation: "stop-execution",
      pipeline: "my-pipeline",
      executionId: "exec-1",
      clientRequestToken: undefined,
      abandon: true,
      reason: "manual stop",
    });

    expect(stopPipelineExecution).toHaveBeenCalledWith({
      pipelineName: "my-pipeline",
      pipelineExecutionId: "exec-1",
      abandon: true,
      reason: "manual stop",
    });
    expect(returned).toEqual(result);
  });

  test("omits reason from the options object when unset (conditional spread)", async () => {
    const stopPipelineExecution = vi
      .fn()
      .mockResolvedValue({ pipelineExecutionId: "exec-1" });
    const operations = createFakeCodePipelineOperations({
      stopPipelineExecution,
    });

    await execute({
      operations,
      operation: "stop-execution",
      pipeline: "my-pipeline",
      executionId: "exec-1",
      clientRequestToken: undefined,
      abandon: false,
      reason: undefined,
    });

    const call = stopPipelineExecution.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(call[0]).not.toHaveProperty("reason");
    expect(call[0]).toEqual({
      pipelineName: "my-pipeline",
      pipelineExecutionId: "exec-1",
      abandon: false,
    });
  });

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when executionId is undefined, never calling stopPipelineExecution", async () => {
    const stopPipelineExecution = vi.fn();
    const operations = createFakeCodePipelineOperations({
      stopPipelineExecution,
    });

    let thrown: unknown;
    try {
      await execute({
        operations,
        operation: "stop-execution",
        pipeline: "my-pipeline",
        executionId: undefined,
        clientRequestToken: undefined,
        abandon: false,
        reason: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_CONFIG");
    expect(stopPipelineExecution).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("execute resolves the start/stop execution result union", () => {
    expectTypeOf(execute).returns.resolves.toEqualTypeOf<
      | AWS.M3LCodePipelineStartExecutionResult
      | AWS.M3LCodePipelineStopExecutionResult
    >();
  });
});
