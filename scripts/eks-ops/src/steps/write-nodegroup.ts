import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `steps/write-nodegroup` — the four nodegroup-mutating operations, scoped
 * to `deps.cluster`/`deps.nodegroup` (never from `deps.input`). Returns the
 * `M3LEKSUpdate`/`M3LEKSNodegroupSummary` unchanged — never inspects
 * `.status` (see `docs/reference/scripts/eks-ops.md`).
 *
 * @packageDocumentation
 */

/** Dependencies for {@link writeNodegroup}, already guard-checked/resolved and gated by `run-eks-ops`. */
export interface WriteNodegroupDeps {
  /** The injected EKS operations wrapper. */
  readonly operations: AWS.M3LEKSOperations;
  /** Which of the four write operations to run. */
  readonly operation:
    | "create-nodegroup"
    | "update-nodegroup-config"
    | "update-nodegroup-version"
    | "delete-nodegroup";
  /** The owning cluster's name — never read from `input`. */
  readonly cluster: string;
  /** The nodegroup's name — the sole identity source, never read from `input`. */
  readonly nodegroup: string;
  /** The parsed `input` JSON payload for `create-nodegroup`/`update-nodegroup-config`. */
  readonly input: Record<string, unknown> | undefined;
  /** The target Kubernetes version for `update-nodegroup-version` (optional there). */
  readonly kubernetesVersion: string | undefined;
  /** The target AMI release version for `update-nodegroup-version` (optional there). */
  readonly releaseVersion: string | undefined;
  /** Forces `update-nodegroup-version` past an EKS-reported health-issue block. */
  readonly force: boolean;
}

/**
 * Runs one of the four nodegroup-mutating operations, each mapped 1:1 onto
 * the corresponding `M3LEKSOperations` method — `createNodegroup`,
 * `updateNodegroupConfig`, `updateNodegroupVersion`, or `deleteNodegroup` —
 * keyed by `deps.operation`. See the step table in
 * `docs/reference/scripts/eks-ops.md` for the exact argument shape per
 * operation.
 *
 * @param deps - The injected operations wrapper and already-resolved,
 *   guard-checked, gated config values.
 * @returns The `M3LEKSNodegroupSummary` for create/delete, or the
 *   `M3LEKSUpdate` for the two `update-*` operations — unchanged, never
 *   inspected for a terminal `status`.
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 * import { writeNodegroup } from "./write-nodegroup.js";
 *
 * declare const operations: AWS.M3LEKSOperations;
 *
 * const update = await writeNodegroup({
 *   operations,
 *   operation: "update-nodegroup-version",
 *   cluster: "my-cluster",
 *   nodegroup: "my-nodegroup",
 *   input: undefined,
 *   kubernetesVersion: "1.30",
 *   releaseVersion: undefined,
 *   force: false,
 * });
 * ```
 */
export function writeNodegroup(
  deps: WriteNodegroupDeps,
): Promise<AWS.M3LEKSNodegroupSummary | AWS.M3LEKSUpdate> {
  switch (deps.operation) {
    case "create-nodegroup":
      return deps.operations.createNodegroup({
        ...deps.input,
        clusterName: deps.cluster,
        nodegroupName: deps.nodegroup,
      } as AWS.M3LEKSCreateNodegroupInput);
    case "update-nodegroup-config":
      return deps.operations.updateNodegroupConfig({
        ...deps.input,
        clusterName: deps.cluster,
        nodegroupName: deps.nodegroup,
      });
    case "update-nodegroup-version":
      return deps.operations.updateNodegroupVersion({
        clusterName: deps.cluster,
        nodegroupName: deps.nodegroup,
        ...(deps.kubernetesVersion !== undefined && {
          version: deps.kubernetesVersion,
        }),
        ...(deps.releaseVersion !== undefined && {
          releaseVersion: deps.releaseVersion,
        }),
        force: deps.force,
      });
    case "delete-nodegroup":
      return deps.operations.deleteNodegroup(deps.cluster, deps.nodegroup);
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(
        `unhandled write-nodegroup operation: ${String(exhaustive)}`,
        { code: "ERR_EKS_OPS_CONFIG" },
      );
    }
  }
}
