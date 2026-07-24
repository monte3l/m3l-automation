import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readClusters` needs, already resolved and guard-checked
 * by `run-ecs-ops` — this step takes no raw `Core.M3LConfig` and never gates
 * (no `prompt`/`confirm` field at all; `list-clusters`/`describe-cluster` are
 * read-only cluster context, never destructive).
 */
interface ReadClustersDeps {
  readonly operations: AWS.M3LECSOperations;
  readonly operation: "list-clusters" | "describe-cluster";
  readonly cluster: string | undefined;
  readonly nextToken: string | undefined;
}

/**
 * Runs `ecs-ops`'s two read-only cluster operations: `list-clusters`
 * (`operations.listClusters({ nextToken })`) and `describe-cluster`
 * (`operations.describeCluster(cluster)`).
 *
 * @param deps - The injected `AWS.M3LECSOperations`, which of the two
 *   read-only operations to run, and the (per-operation, possibly-unset)
 *   `cluster`/`nextToken` values.
 * @returns The raw `M3LECSListClustersResult` (`list-clusters`) or
 *   `M3LECSClusterSummary` (`describe-cluster`), unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_CONFIG"` when
 *   `operation` is `"describe-cluster"` and `cluster` is `undefined` —
 *   guarded defensively; `run-ecs-ops` already guard-checks this before
 *   dispatch.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readClusters } from "./read-clusters.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LECSOperations(script.aws.clients.ecs)`.
 * declare const operations: AWS.M3LECSOperations;
 *
 * const result = await readClusters({
 *   operations,
 *   operation: "list-clusters",
 *   cluster: undefined,
 *   nextToken: undefined,
 * });
 * ```
 */
export async function readClusters(
  deps: ReadClustersDeps,
): Promise<AWS.M3LECSListClustersResult | AWS.M3LECSClusterSummary> {
  switch (deps.operation) {
    case "list-clusters":
      return deps.operations.listClusters({
        ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
      });
    case "describe-cluster": {
      if (deps.cluster === undefined) {
        throw new Core.M3LError(
          "readClusters: 'cluster' is required for the 'describe-cluster' operation",
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      return deps.operations.describeCluster(deps.cluster);
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_ECS_OPS_CONFIG",
      });
    }
  }
}
