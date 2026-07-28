import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/read-clusters` — `list-clusters` and `describe-cluster`, the two
 * never-gated cluster read operations. `describeCluster` may resolve
 * `undefined` (the wrapper's not-found convention); this step returns that
 * `undefined` unchanged — converting it into `ERR_EKS_OPS_NOT_FOUND` is
 * `run-eks-ops`'s job, not this step's (see
 * `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link readClusters}, already guard-checked/resolved by `run-eks-ops`. */
export interface ReadClustersDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the two read operations to run. */
  readonly operation: "list-clusters" | "describe-cluster";
  /** The cluster's name — required for `describe-cluster`, unused for `list-clusters`. */
  readonly cluster: string | undefined;
  /** Continuation token from a previous `list-clusters` page. */
  readonly nextToken: string | undefined;
  /** Page size for `list-clusters`. */
  readonly maxResults: number | undefined;
  /** Cluster-kind filter for `list-clusters`. */
  readonly include: readonly string[] | undefined;
}

/**
 * Runs `list-clusters` (`listClusters({ nextToken, maxResults, include })`)
 * or `describe-cluster` (`describeCluster(cluster)`), returning the result
 * exactly as the wrapper resolved it.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked config values.
 * @returns The `list-clusters` page, the `describe-cluster` summary, or
 *   `undefined` when `describe-cluster` finds no matching cluster.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_CONFIG"` when `operation`
 *   is `"describe-cluster"` and `cluster` is `undefined` (a defensive guard —
 *   `run-eks-ops` already checks this before dispatch).
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { readClusters } from "./read-clusters.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const page = await readClusters({
 *   operations,
 *   operation: "list-clusters",
 *   cluster: undefined,
 *   nextToken: undefined,
 *   maxResults: 25,
 *   include: undefined,
 * });
 * ```
 */
export async function readClusters(
  deps: ReadClustersDeps,
): Promise<
  AWS.M3LEKSListClustersResult | AWS.M3LEKSClusterSummary | undefined
> {
  if (deps.operation === "list-clusters") {
    return deps.operations.listClusters({
      ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
      ...(deps.maxResults !== undefined && { maxResults: deps.maxResults }),
      ...(deps.include !== undefined && { include: deps.include }),
    });
  }

  if (deps.cluster === undefined) {
    throw new Core.M3LError(
      "'cluster' is required for operation 'describe-cluster'",
      { code: "ERR_EKS_OPS_CONFIG" },
    );
  }
  return deps.operations.describeCluster(deps.cluster);
}
