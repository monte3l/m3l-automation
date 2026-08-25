import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/wait-nodegroup` — `wait-nodegroup-active` and
 * `wait-nodegroup-deleted`. Same pass-through contract as `wait-cluster`:
 * the `M3LEKSWaiterResult` is returned unchanged regardless of `state` (see
 * `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link waitNodegroup}, already guard-checked/resolved by `run-eks-ops`. */
export interface WaitNodegroupDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the two lifecycle waits to run. */
  readonly operation: "wait-nodegroup-active" | "wait-nodegroup-deleted";
  /** The owning cluster's name. */
  readonly cluster: string;
  /** The nodegroup's name. */
  readonly nodegroup: string;
  /** Seconds bounding the wait. */
  readonly maxWaitTime: number;
  /** Cooperative-cancellation signal (ADR-0049), forwarded to the waiter. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `waitUntilNodegroupActive(cluster, nodegroup, { maxWaitTime })` or
 * `waitUntilNodegroupDeleted(cluster, nodegroup, { maxWaitTime })`, keyed by
 * `deps.operation`.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked config values.
 * @returns The `M3LEKSWaiterResult` unchanged, whatever its `state`.
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { waitNodegroup } from "./wait-nodegroup.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const result = await waitNodegroup({
 *   operations,
 *   operation: "wait-nodegroup-active",
 *   cluster: "my-cluster",
 *   nodegroup: "my-nodegroup",
 *   maxWaitTime: 1200,
 * });
 * ```
 */
export function waitNodegroup(
  deps: WaitNodegroupDeps,
): Promise<AWS.M3LEKSWaiterResult> {
  if (deps.operation === "wait-nodegroup-active") {
    return deps.operations.waitUntilNodegroupActive(
      deps.cluster,
      deps.nodegroup,
      {
        maxWaitTime: deps.maxWaitTime,
        ...(deps.signal !== undefined && { signal: deps.signal }),
      },
    );
  }
  return deps.operations.waitUntilNodegroupDeleted(
    deps.cluster,
    deps.nodegroup,
    {
      maxWaitTime: deps.maxWaitTime,
      ...(deps.signal !== undefined && { signal: deps.signal }),
    },
  );
}
