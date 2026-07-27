import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { transitions } from "../src/steps/transitions.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `scripts/codepipeline-ops/src/steps/transitions.ts` — handles
 * `enable-stage-transition`/`disable-stage-transition`. The wrapper's two
 * input types are asymmetric: `enable-stage-transition` has NO `reason`
 * field at all on `M3LCodePipelineEnableStageTransitionInput`, while
 * `disable-stage-transition` guard-checks `reason` required
 * (`ERR_CODEPIPELINE_OPS_CONFIG`) and always includes it. Never touches
 * `destructive-gate`/`prompt` itself.
 */

afterEach(() => {
  vi.clearAllMocks();
});

describe("transitions — enable-stage-transition", () => {
  test("calls operations.enableStageTransition with pipelineName/stageName/transitionType, never a reason key", async () => {
    const enableStageTransition = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({
      enableStageTransition,
    });

    const returned = await transitions({
      operations,
      operation: "enable-stage-transition",
      pipeline: "my-pipeline",
      stage: "Deploy",
      transitionType: "Inbound",
      reason: undefined,
    });

    expect(enableStageTransition).toHaveBeenCalledTimes(1);
    expect(enableStageTransition).toHaveBeenCalledWith({
      pipelineName: "my-pipeline",
      stageName: "Deploy",
      transitionType: "Inbound",
    });
    const call = enableStageTransition.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(call[0]).not.toHaveProperty("reason");
    expect(returned).toBeUndefined();
  });

  test("never includes a reason key even when a reason value is supplied on deps (asymmetric input type)", async () => {
    const enableStageTransition = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({
      enableStageTransition,
    });

    await transitions({
      operations,
      operation: "enable-stage-transition",
      pipeline: "my-pipeline",
      stage: "Deploy",
      transitionType: "Outbound",
      reason: "should be ignored",
    });

    expect(enableStageTransition).toHaveBeenCalledWith({
      pipelineName: "my-pipeline",
      stageName: "Deploy",
      transitionType: "Outbound",
    });
  });
});

describe("transitions — disable-stage-transition", () => {
  test("calls operations.disableStageTransition with pipelineName/stageName/transitionType/reason", async () => {
    const disableStageTransition = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({
      disableStageTransition,
    });

    const returned = await transitions({
      operations,
      operation: "disable-stage-transition",
      pipeline: "my-pipeline",
      stage: "Deploy",
      transitionType: "Inbound",
      reason: "investigating a bad deploy",
    });

    expect(disableStageTransition).toHaveBeenCalledWith({
      pipelineName: "my-pipeline",
      stageName: "Deploy",
      transitionType: "Inbound",
      reason: "investigating a bad deploy",
    });
    expect(returned).toBeUndefined();
  });

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when reason is undefined, never calling disableStageTransition", async () => {
    const disableStageTransition = vi.fn();
    const operations = createFakeCodePipelineOperations({
      disableStageTransition,
    });

    let thrown: unknown;
    try {
      await transitions({
        operations,
        operation: "disable-stage-transition",
        pipeline: "my-pipeline",
        stage: "Deploy",
        transitionType: "Inbound",
        reason: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_CONFIG");
    expect(disableStageTransition).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("transitions resolves void", () => {
    expectTypeOf(transitions).returns.toEqualTypeOf<Promise<void>>();
  });

  test("transitions's deps shape is exactly operations/operation/pipeline/stage/transitionType/reason", () => {
    expectTypeOf<Parameters<typeof transitions>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCodePipelineOperations;
      readonly operation:
        "enable-stage-transition" | "disable-stage-transition";
      readonly pipeline: string;
      readonly stage: string;
      readonly transitionType: AWS.M3LCodePipelineStageTransitionType;
      readonly reason: string | undefined;
    }>();
  });
});
