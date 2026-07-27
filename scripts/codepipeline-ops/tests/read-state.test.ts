import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readState } from "../src/steps/read-state.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `src/steps/read-state.ts` — `get-pipeline-state`
 * (`getPipelineState(pipeline)`), never gated (no `prompt`/destructive-gate
 * dependency at all). Deps arrive already guard-checked/resolved by
 * `run-codepipeline-ops` — this step takes no raw `Core.M3LConfig`.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("readState", () => {
  test("calls operations.getPipelineState(pipeline) and returns the state unchanged", async () => {
    const state: AWS.M3LCodePipelineState = {
      pipelineName: "my-pipeline",
      stageStates: [
        {
          stageName: "Source",
          actionStates: [{ actionName: "Fetch" }],
        },
      ],
      pipelineVersion: 3,
    };
    const getPipelineState = vi.fn().mockResolvedValue(state);
    const operations = createFakeCodePipelineOperations({ getPipelineState });

    const returned = await readState({
      operations,
      pipeline: "my-pipeline",
    });

    expect(getPipelineState).toHaveBeenCalledWith("my-pipeline");
    expect(returned).toEqual(state);
  });

  test("throws ERR_CODEPIPELINE_OPS_NOT_FOUND when getPipelineState resolves undefined", async () => {
    const getPipelineState = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({ getPipelineState });

    let thrown: unknown;
    try {
      await readState({ operations, pipeline: "missing-pipeline" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_CODEPIPELINE_OPS_NOT_FOUND",
    );
  });
});

describe("type contract", () => {
  test("readState resolves M3LCodePipelineState", () => {
    expectTypeOf(
      readState,
    ).returns.resolves.toEqualTypeOf<AWS.M3LCodePipelineState>();
  });

  test("readState's deps shape is exactly operations/pipeline — no prompt/confirm field, it never gates", () => {
    expectTypeOf<Parameters<typeof readState>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCodePipelineOperations;
      readonly pipeline: string;
    }>();
  });
});
