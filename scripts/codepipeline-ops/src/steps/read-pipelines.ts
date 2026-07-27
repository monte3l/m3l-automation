import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readPipelines` needs, already resolved and guard-checked
 * by `run-codepipeline-ops` — this step takes no raw `Core.M3LConfig` and
 * never gates (no `prompt`/`confirm` field at all; `list-pipelines`/
 * `describe-pipeline` are never destructive).
 */
interface ReadPipelinesDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly operation: "list-pipelines" | "describe-pipeline";
  readonly pipeline: string | undefined;
  readonly version: number | undefined;
  readonly nextToken: string | undefined;
  readonly maxResults: number | undefined;
}

/**
 * Runs `codepipeline-ops`'s two read-only pipeline-declaration operations:
 * `list-pipelines` (`operations.listPipelines({ nextToken, maxResults })`)
 * and `describe-pipeline` (`operations.getPipeline(pipeline, { version })`).
 *
 * The wrapper resolves `getPipeline` to `undefined` when the SDK reports
 * `PipelineNotFoundException` — a valid outcome the library never throws
 * for — so this step converts that into a typed, run-failing error rather
 * than passing `undefined` on to `persistOutput`/consumers expecting a
 * pipeline.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, which of the
 *   two read-only operations to run, and the (per-operation,
 *   possibly-unset) `pipeline`/`version`/`nextToken`/`maxResults` values.
 * @returns The raw `M3LCodePipelineListPipelinesResult` (`list-pipelines`) or
 *   `M3LCodePipelineDefinition` (`describe-pipeline`), unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when
 *   `operation` is `"describe-pipeline"` and `pipeline` is `undefined` —
 *   guarded defensively; `run-codepipeline-ops` already guard-checks this
 *   before dispatch.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_NOT_FOUND"` when
 *   `describe-pipeline` resolves `undefined` (the named pipeline does not
 *   exist).
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readPipelines } from "./read-pipelines.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * const result = await readPipelines({
 *   operations,
 *   operation: "list-pipelines",
 *   pipeline: undefined,
 *   version: undefined,
 *   nextToken: undefined,
 *   maxResults: undefined,
 * });
 * ```
 */
export async function readPipelines(
  deps: ReadPipelinesDeps,
): Promise<
  AWS.M3LCodePipelineListPipelinesResult | AWS.M3LCodePipelineDefinition
> {
  switch (deps.operation) {
    case "list-pipelines":
      return deps.operations.listPipelines({
        ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
        ...(deps.maxResults !== undefined && {
          maxResults: deps.maxResults,
        }),
      });
    case "describe-pipeline": {
      if (deps.pipeline === undefined) {
        throw new Core.M3LError(
          "readPipelines: 'pipeline' is required for the 'describe-pipeline' operation",
          { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
        );
      }
      const definition = await deps.operations.getPipeline(deps.pipeline, {
        ...(deps.version !== undefined && { version: deps.version }),
      });
      if (definition === undefined) {
        throw new Core.M3LError(
          `readPipelines: pipeline '${deps.pipeline}' not found`,
          { code: "ERR_CODEPIPELINE_OPS_NOT_FOUND" },
        );
      }
      return definition;
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
    }
  }
}
