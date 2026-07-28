import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/read-nodegroups` — `list-nodegroups` and `describe-nodegroup`, the
 * two never-gated nodegroup read operations. Same `undefined`-on-not-found
 * passthrough as `read-clusters` for `describe-nodegroup`; `listNodegroups`
 * itself throws (never resolves `undefined`) on an unknown `cluster` — that
 * failure propagates unchanged as `AWS.M3LEKSOperationError`, this step
 * performs no catch of its own (see `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link readNodegroups}, already guard-checked/resolved by `run-eks-ops`. */
export interface ReadNodegroupsDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the two read operations to run. */
  readonly operation: "list-nodegroups" | "describe-nodegroup";
  /** The owning cluster's name. */
  readonly cluster: string;
  /** The nodegroup's name — required for `describe-nodegroup`, unused for `list-nodegroups`. */
  readonly nodegroup: string | undefined;
  /** Continuation token from a previous `list-nodegroups` page. */
  readonly nextToken: string | undefined;
  /** Page size for `list-nodegroups`. */
  readonly maxResults: number | undefined;
}

/**
 * Runs `list-nodegroups`
 * (`listNodegroups(cluster, { nextToken, maxResults })`) or
 * `describe-nodegroup` (`describeNodegroup(cluster, nodegroup)`), returning
 * the result exactly as the wrapper resolved it.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked config values.
 * @returns The `list-nodegroups` page, the `describe-nodegroup` summary, or
 *   `undefined` when `describe-nodegroup` finds no matching nodegroup.
 * @throws {@link Core.M3LError} coded `"ERR_EKS_OPS_CONFIG"` when `operation`
 *   is `"describe-nodegroup"` and `nodegroup` is `undefined` (a defensive
 *   guard — `run-eks-ops` already checks this before dispatch).
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { readNodegroups } from "./read-nodegroups.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const page = await readNodegroups({
 *   operations,
 *   operation: "list-nodegroups",
 *   cluster: "my-cluster",
 *   nodegroup: undefined,
 *   nextToken: undefined,
 *   maxResults: 25,
 * });
 * ```
 */
export async function readNodegroups(
  deps: ReadNodegroupsDeps,
): Promise<
  AWS.M3LEKSListNodegroupsResult | AWS.M3LEKSNodegroupSummary | undefined
> {
  if (deps.operation === "list-nodegroups") {
    return deps.operations.listNodegroups(deps.cluster, {
      ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
      ...(deps.maxResults !== undefined && { maxResults: deps.maxResults }),
    });
  }

  if (deps.nodegroup === undefined) {
    throw new Core.M3LError(
      "'nodegroup' is required for operation 'describe-nodegroup'",
      { code: "ERR_EKS_OPS_CONFIG" },
    );
  }
  return deps.operations.describeNodegroup(deps.cluster, deps.nodegroup);
}
