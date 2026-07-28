import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/write-cluster` — the four cluster-mutating operations. Resource
 * identity always comes from `deps.cluster` (never from `deps.input`).
 * Returns the `M3LEKSUpdate`/`M3LEKSClusterSummary` unchanged — this step
 * never inspects `.status`; that decision belongs to `run-eks-ops` (see
 * `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link writeCluster}, already guard-checked/resolved and gated by `run-eks-ops`. */
export interface WriteClusterDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the four write operations to run. */
  readonly operation:
    | "create-cluster"
    | "update-cluster-config"
    | "update-cluster-version"
    | "delete-cluster";
  /** The cluster's name — the sole identity source, never read from `input`. */
  readonly cluster: string;
  /** The parsed `input` JSON payload for `create-cluster`/`update-cluster-config`. */
  readonly input: Record<string, unknown> | undefined;
  /** The target Kubernetes version for `update-cluster-version`. */
  readonly kubernetesVersion: string | undefined;
  /** Forces `update-cluster-version` past an EKS-reported health-issue block. */
  readonly force: boolean;
}

/**
 * Runs one of the four cluster-mutating operations, each mapped 1:1 onto the
 * corresponding `M3LEKSOperations` method — `createCluster`,
 * `updateClusterConfig`, `updateClusterVersion`, or `deleteCluster` — keyed by
 * `deps.operation`. See the step table in
 * `docs/reference/scripts/eks-ops.md` for the exact argument shape per
 * operation.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked, gated config values.
 * @returns The `M3LEKSClusterSummary` for create/delete, or the
 *   `M3LEKSUpdate` for the two `update-*` operations — unchanged, never
 *   inspected for a terminal `status`.
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { writeCluster } from "./write-cluster.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const update = await writeCluster({
 *   operations,
 *   operation: "update-cluster-version",
 *   cluster: "my-cluster",
 *   input: undefined,
 *   kubernetesVersion: "1.30",
 *   force: false,
 * });
 * ```
 */
export function writeCluster(
  deps: WriteClusterDeps,
): Promise<AWS.M3LEKSClusterSummary | AWS.M3LEKSUpdate> {
  switch (deps.operation) {
    case "create-cluster":
      return deps.operations.createCluster({
        ...deps.input,
        name: deps.cluster,
      } as AWS.M3LEKSCreateClusterInput);
    case "update-cluster-config":
      return deps.operations.updateClusterConfig({
        ...deps.input,
        name: deps.cluster,
      });
    case "update-cluster-version":
      return deps.operations.updateClusterVersion({
        name: deps.cluster,
        version: deps.kubernetesVersion ?? "",
        force: deps.force,
      });
    case "delete-cluster":
      return deps.operations.deleteCluster(deps.cluster);
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(
        `unhandled write-cluster operation: ${String(exhaustive)}`,
        {
          code: "ERR_EKS_OPS_CONFIG",
        },
      );
    }
  }
}
