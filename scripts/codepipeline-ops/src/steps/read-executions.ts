import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readExecutions` needs, already resolved and
 * guard-checked by `run-codepipeline-ops` — this step takes no raw
 * `Core.M3LConfig` and never gates (`list-executions`/`describe-execution`
 * are never destructive).
 */
interface ReadExecutionsDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly operation: "list-executions" | "describe-execution";
  readonly pipeline: string;
  readonly executionId: string | undefined;
  readonly nextToken: string | undefined;
  readonly maxResults: number | undefined;
}

/**
 * Runs `codepipeline-ops`'s two read-only execution operations:
 * `list-executions` (`operations.listPipelineExecutions`) and
 * `describe-execution` (`operations.getPipelineExecution`).
 *
 * `list-executions` throws (never resolves an empty page) when `pipeline`
 * itself does not exist — the wrapper treats a listing call as "operate on
 * this named pipeline", unlike the not-found-tolerant read methods. The
 * wrapper resolves `describe-execution` to `undefined` on either
 * `PipelineNotFoundException` or `PipelineExecutionNotFoundException`; this
 * step converts that into a typed, run-failing error.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, which of the
 *   two read-only operations to run, the target `pipeline`, and the
 *   (per-operation, possibly-unset) `executionId`/`nextToken`/`maxResults`
 *   values.
 * @returns The raw `M3LCodePipelineListExecutionsResult`
 *   (`list-executions`) or `M3LCodePipelineExecution`
 *   (`describe-execution`), unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when
 *   `operation` is `"describe-execution"` and `executionId` is
 *   `undefined` — guarded defensively; `run-codepipeline-ops` already
 *   guard-checks this before dispatch.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_NOT_FOUND"` when
 *   `describe-execution` resolves `undefined`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readExecutions } from "./read-executions.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * const result = await readExecutions({
 *   operations,
 *   operation: "list-executions",
 *   pipeline: "my-pipeline",
 *   executionId: undefined,
 *   nextToken: undefined,
 *   maxResults: undefined,
 * });
 * ```
 */
export async function readExecutions(
  deps: ReadExecutionsDeps,
): Promise<
  AWS.M3LCodePipelineListExecutionsResult | AWS.M3LCodePipelineExecution
> {
  switch (deps.operation) {
    case "list-executions":
      return deps.operations.listPipelineExecutions(deps.pipeline, {
        ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
        ...(deps.maxResults !== undefined && {
          maxResults: deps.maxResults,
        }),
      });
    case "describe-execution": {
      if (deps.executionId === undefined) {
        throw new Core.M3LError(
          "readExecutions: 'executionId' is required for the 'describe-execution' operation",
          { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
        );
      }
      const execution = await deps.operations.getPipelineExecution(
        deps.pipeline,
        deps.executionId,
      );
      if (execution === undefined) {
        throw new Core.M3LError(
          `readExecutions: execution '${deps.executionId}' not found on pipeline '${deps.pipeline}'`,
          { code: "ERR_CODEPIPELINE_OPS_NOT_FOUND" },
        );
      }
      return execution;
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
    }
  }
}
