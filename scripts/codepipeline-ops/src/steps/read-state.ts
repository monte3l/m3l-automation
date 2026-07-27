import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readState` needs, already resolved and guard-checked by
 * `run-codepipeline-ops` — this step takes no raw `Core.M3LConfig` and never
 * gates (`get-pipeline-state` is never destructive).
 */
interface ReadStateDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly pipeline: string;
}

/**
 * Runs `codepipeline-ops`'s `get-pipeline-state` operation
 * (`operations.getPipelineState(pipeline)`).
 *
 * The wrapper resolves `undefined` when the SDK reports
 * `PipelineNotFoundException`; this step converts that into a typed,
 * run-failing error. A pipeline with zero stages resolves a state whose
 * `stageStates` is an empty array — the wrapper's `undefined → []` mapping,
 * not a not-found signal — and is returned unchanged.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations` and the target
 *   `pipeline` name.
 * @returns The `M3LCodePipelineState`, unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_NOT_FOUND"` when
 *   the named pipeline does not exist.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readState } from "./read-state.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * const state = await readState({ operations, pipeline: "my-pipeline" });
 * ```
 */
export async function readState(
  deps: ReadStateDeps,
): Promise<AWS.M3LCodePipelineState> {
  const state = await deps.operations.getPipelineState(deps.pipeline);
  if (state === undefined) {
    throw new Core.M3LError(
      `readState: pipeline '${deps.pipeline}' not found`,
      { code: "ERR_CODEPIPELINE_OPS_NOT_FOUND" },
    );
  }
  return state;
}
