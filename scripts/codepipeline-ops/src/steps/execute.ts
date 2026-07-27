import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The two execution-control operations `execute` dispatches. */
type ExecuteOperation = "start-execution" | "stop-execution";

/**
 * The dependencies `execute` needs, already resolved and guard-checked by
 * `run-codepipeline-ops`. `start-execution` is not gated (triggering a
 * pipeline is not destructive in the confirm-before-destroy sense);
 * `stop-execution` is neither destructive-gated — stopping is the safety
 * action, not the risk.
 */
interface ExecuteDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly operation: ExecuteOperation;
  readonly pipeline: string;
  readonly executionId: string | undefined;
  readonly clientRequestToken: string | undefined;
  readonly abandon: boolean;
  readonly reason: string | undefined;
}

/**
 * Runs `codepipeline-ops`'s two execution-control operations:
 * `start-execution` (`operations.startPipelineExecution`) and
 * `stop-execution` (`operations.stopPipelineExecution`).
 *
 * `start-execution` is not idempotent without `clientRequestToken` — a
 * retried trigger without it starts a *second* execution, per the wrapper's
 * own documented contract. `stop-execution` is **not** forgiving of an
 * already-terminal or already-stopping execution (unlike `delete-pipeline`'s
 * no-op-on-absent behavior) — it throws.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, which of the
 *   two operations to run, the target `pipeline`, and the (per-operation,
 *   possibly-unset) `executionId`/`clientRequestToken`/`abandon`/`reason`
 *   values.
 * @returns The `M3LCodePipelineStartExecutionResult` (`start-execution`) or
 *   `M3LCodePipelineStopExecutionResult` (`stop-execution`).
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when
 *   `operation` is `"stop-execution"` and `executionId` is `undefined` —
 *   guarded defensively; `run-codepipeline-ops` already guard-checks this
 *   before dispatch.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { execute } from "./execute.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * const result = await execute({
 *   operations,
 *   operation: "start-execution",
 *   pipeline: "my-pipeline",
 *   executionId: undefined,
 *   clientRequestToken: undefined,
 *   abandon: false,
 *   reason: undefined,
 * });
 * ```
 */
export async function execute(
  deps: ExecuteDeps,
): Promise<
  | AWS.M3LCodePipelineStartExecutionResult
  | AWS.M3LCodePipelineStopExecutionResult
> {
  switch (deps.operation) {
    case "start-execution":
      return deps.operations.startPipelineExecution(deps.pipeline, {
        ...(deps.clientRequestToken !== undefined && {
          clientRequestToken: deps.clientRequestToken,
        }),
      });
    case "stop-execution": {
      if (deps.executionId === undefined) {
        throw new Core.M3LError(
          "execute: 'executionId' is required for the 'stop-execution' operation",
          { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
        );
      }
      return deps.operations.stopPipelineExecution({
        pipelineName: deps.pipeline,
        pipelineExecutionId: deps.executionId,
        abandon: deps.abandon,
        ...(deps.reason !== undefined && { reason: deps.reason }),
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
