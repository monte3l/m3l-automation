import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readServices` needs, already resolved and guard-checked
 * by `run-ecs-ops` — this step takes no raw `Core.M3LConfig` and never gates
 * (no `prompt`/`confirm` field at all; `list-services`/`describe-service` are
 * never destructive).
 */
interface ReadServicesDeps {
  readonly operations: AWS.M3LECSOperations;
  readonly operation: "list-services" | "describe-service";
  readonly cluster: string | undefined;
  readonly service: string | undefined;
  readonly nextToken: string | undefined;
}

/**
 * Runs `ecs-ops`'s two read-only service operations: `list-services`
 * (`operations.listServices({ cluster, nextToken })`) and `describe-service`
 * (`operations.describeService(cluster, service)`).
 *
 * @param deps - The injected `AWS.M3LECSOperations`, which of the two
 *   read-only operations to run, and the (per-operation, possibly-unset)
 *   `cluster`/`service`/`nextToken` values.
 * @returns The raw `M3LECSListServicesResult` (`list-services`) or
 *   `M3LECSServiceDescription` (`describe-service`), unchanged.
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_CONFIG"` when
 *   `operation` is `"describe-service"` and `cluster`/`service` is
 *   `undefined` — guarded defensively; `run-ecs-ops` already guard-checks
 *   this before dispatch.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readServices } from "./read-services.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LECSOperations(script.aws.clients.ecs)`.
 * declare const operations: AWS.M3LECSOperations;
 *
 * const result = await readServices({
 *   operations,
 *   operation: "list-services",
 *   cluster: "my-cluster",
 *   service: undefined,
 *   nextToken: undefined,
 * });
 * ```
 */
export async function readServices(
  deps: ReadServicesDeps,
): Promise<AWS.M3LECSListServicesResult | AWS.M3LECSServiceDescription> {
  switch (deps.operation) {
    case "list-services":
      return deps.operations.listServices({
        ...(deps.cluster !== undefined && { cluster: deps.cluster }),
        ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
      });
    case "describe-service": {
      if (deps.cluster === undefined) {
        throw new Core.M3LError(
          "readServices: 'cluster' is required for the 'describe-service' operation",
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      if (deps.service === undefined) {
        throw new Core.M3LError(
          "readServices: 'service' is required for the 'describe-service' operation",
          { code: "ERR_ECS_OPS_CONFIG" },
        );
      }
      return deps.operations.describeService(deps.cluster, deps.service);
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_ECS_OPS_CONFIG",
      });
    }
  }
}
