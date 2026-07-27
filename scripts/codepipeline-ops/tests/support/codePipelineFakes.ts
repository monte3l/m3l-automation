import { vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * Builds a plain-object fake of `AWS.M3LCodePipelineOperations`'s 12-method
 * public interface, each a `vi.fn()` the caller can configure per test.
 * `M3LCodePipelineOperations` is a concrete class with a private field, so a
 * structural object literal is cast through `unknown` — the same pattern
 * `scripts/ecs-ops/tests/support/ecsFakes.ts` uses for `M3LECSOperations`.
 *
 * The steps under test never construct their own `M3LCodePipelineOperations`
 * — it is always an injected dependency, so this fake is never required to
 * touch `@aws-sdk/client-codepipeline`.
 */
export function createFakeCodePipelineOperations(overrides?: {
  readonly listPipelines?: ReturnType<typeof vi.fn>;
  readonly getPipeline?: ReturnType<typeof vi.fn>;
  readonly getPipelineState?: ReturnType<typeof vi.fn>;
  readonly listPipelineExecutions?: ReturnType<typeof vi.fn>;
  readonly getPipelineExecution?: ReturnType<typeof vi.fn>;
  readonly createPipeline?: ReturnType<typeof vi.fn>;
  readonly updatePipeline?: ReturnType<typeof vi.fn>;
  readonly deletePipeline?: ReturnType<typeof vi.fn>;
  readonly startPipelineExecution?: ReturnType<typeof vi.fn>;
  readonly stopPipelineExecution?: ReturnType<typeof vi.fn>;
  readonly enableStageTransition?: ReturnType<typeof vi.fn>;
  readonly disableStageTransition?: ReturnType<typeof vi.fn>;
}): AWS.M3LCodePipelineOperations {
  const fakeDeclaration: AWS.M3LCodePipelineDeclaration = {
    name: "",
    roleArn: "",
    stages: [],
  };
  const fakeState: AWS.M3LCodePipelineState = {
    pipelineName: "",
    stageStates: [],
  };
  const fakeExecution: AWS.M3LCodePipelineExecution = {
    pipelineExecutionId: "",
    pipelineName: "",
    status: "",
  };
  const fake = {
    listPipelines:
      overrides?.listPipelines ?? vi.fn().mockResolvedValue({ pipelines: [] }),
    getPipeline:
      overrides?.getPipeline ??
      vi.fn().mockResolvedValue({ declaration: fakeDeclaration }),
    getPipelineState:
      overrides?.getPipelineState ?? vi.fn().mockResolvedValue(fakeState),
    listPipelineExecutions:
      overrides?.listPipelineExecutions ??
      vi.fn().mockResolvedValue({ executionSummaries: [] }),
    getPipelineExecution:
      overrides?.getPipelineExecution ??
      vi.fn().mockResolvedValue(fakeExecution),
    createPipeline:
      overrides?.createPipeline ?? vi.fn().mockResolvedValue(fakeDeclaration),
    updatePipeline:
      overrides?.updatePipeline ?? vi.fn().mockResolvedValue(fakeDeclaration),
    deletePipeline:
      overrides?.deletePipeline ?? vi.fn().mockResolvedValue(undefined),
    startPipelineExecution:
      overrides?.startPipelineExecution ??
      vi.fn().mockResolvedValue({ pipelineExecutionId: "" }),
    stopPipelineExecution:
      overrides?.stopPipelineExecution ??
      vi.fn().mockResolvedValue({ pipelineExecutionId: "" }),
    enableStageTransition:
      overrides?.enableStageTransition ?? vi.fn().mockResolvedValue(undefined),
    disableStageTransition:
      overrides?.disableStageTransition ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as AWS.M3LCodePipelineOperations;
}

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
export function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}
