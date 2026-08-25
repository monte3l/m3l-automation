import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/wait-cluster` — `wait-cluster-active` and `wait-cluster-deleted`.
 * Returns the `M3LEKSWaiterResult` unchanged regardless of `state` — this
 * step never throws or inspects `state`; that decision belongs to
 * `run-eks-ops` (see `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link waitCluster}, already guard-checked/resolved by `run-eks-ops`. */
export interface WaitClusterDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the two lifecycle waits to run. */
  readonly operation: "wait-cluster-active" | "wait-cluster-deleted";
  /** The cluster's name. */
  readonly cluster: string;
  /** Seconds bounding the wait. */
  readonly maxWaitTime: number;
  /** Cooperative-cancellation signal (ADR-0049), forwarded to the waiter. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `waitUntilClusterActive(cluster, { maxWaitTime })` or
 * `waitUntilClusterDeleted(cluster, { maxWaitTime })`, keyed by
 * `deps.operation`.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked config values.
 * @returns The `M3LEKSWaiterResult` unchanged, whatever its `state`.
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { waitCluster } from "./wait-cluster.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const result = await waitCluster({
 *   operations,
 *   operation: "wait-cluster-active",
 *   cluster: "my-cluster",
 *   maxWaitTime: 1200,
 * });
 * ```
 */
export function waitCluster(
  deps: WaitClusterDeps,
): Promise<AWS.M3LEKSWaiterResult> {
  if (deps.operation === "wait-cluster-active") {
    return deps.operations.waitUntilClusterActive(deps.cluster, {
      maxWaitTime: deps.maxWaitTime,
      ...(deps.signal !== undefined && { signal: deps.signal }),
    });
  }
  return deps.operations.waitUntilClusterDeleted(deps.cluster, {
    maxWaitTime: deps.maxWaitTime,
    ...(deps.signal !== undefined && { signal: deps.signal }),
  });
}
