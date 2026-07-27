import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The two stage-transition operations `transitions` dispatches. */
type TransitionOperation =
  "enable-stage-transition" | "disable-stage-transition";

/**
 * The dependencies `transitions` needs, already resolved and guard-checked
 * by `run-codepipeline-ops`. Neither operation is destructive-gated — a
 * stage transition toggle is reversible by its own inverse operation, unlike
 * `write-pipeline`'s three gated mutations.
 */
interface TransitionsDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly operation: TransitionOperation;
  readonly pipeline: string;
  readonly stage: string;
  readonly transitionType: AWS.M3LCodePipelineStageTransitionType;
  readonly reason: string | undefined;
}

/**
 * Runs `codepipeline-ops`'s two stage-transition operations:
 * `enable-stage-transition` (`operations.enableStageTransition`) and
 * `disable-stage-transition` (`operations.disableStageTransition`).
 *
 * The wrapper's two input types are asymmetric:
 * `M3LCodePipelineEnableStageTransitionInput` has no `reason` field at all,
 * while `M3LCodePipelineDisableStageTransitionInput.reason` is **required**.
 * This step enforces that asymmetry rather than passing `reason` through
 * uniformly.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, which of the
 *   two operations to run, the target `pipeline`/`stage`/`transitionType`,
 *   and (`disable-stage-transition` only) the required `reason`.
 * @returns Resolves with no value on success (both wrapper methods return
 *   `void`).
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when
 *   `operation` is `"disable-stage-transition"` and `reason` is
 *   `undefined` — guarded defensively; `run-codepipeline-ops` already
 *   guard-checks this before dispatch.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { transitions } from "./transitions.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * await transitions({
 *   operations,
 *   operation: "enable-stage-transition",
 *   pipeline: "my-pipeline",
 *   stage: "Deploy",
 *   transitionType: "Inbound",
 *   reason: undefined,
 * });
 * ```
 */
export async function transitions(deps: TransitionsDeps): Promise<void> {
  switch (deps.operation) {
    case "enable-stage-transition":
      return deps.operations.enableStageTransition({
        pipelineName: deps.pipeline,
        stageName: deps.stage,
        transitionType: deps.transitionType,
      });
    case "disable-stage-transition": {
      if (deps.reason === undefined) {
        throw new Core.M3LError(
          "transitions: 'reason' is required for the 'disable-stage-transition' operation",
          { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
        );
      }
      return deps.operations.disableStageTransition({
        pipelineName: deps.pipeline,
        stageName: deps.stage,
        transitionType: deps.transitionType,
        reason: deps.reason,
      });
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
    }
  }
}
