import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `waitServices` needs, already resolved by `run-ecs-ops` —
 * `services` arrives as the already-split/trimmed/non-empty list. This step
 * takes no raw `Core.M3LConfig` and never gates (no `prompt`/`confirm` field
 * at all; `wait-services-stable` is never destructive).
 */
interface WaitServicesDeps {
  readonly operations: AWS.M3LECSOperations;
  readonly cluster: string;
  readonly services: readonly string[];
  readonly maxWaitTime: number | undefined;
}

/**
 * Waits for one or more ECS services to reach a stable state via
 * `operations.waitUntilServicesStable(cluster, services, { maxWaitTime })`.
 *
 * This step deliberately does **not** inspect or throw on a non-`SUCCESS`
 * resolved state (`"TIMEOUT"`/`"ABORTED"`) — turning that into a run failure
 * is `run-ecs-ops`'s decision to make once the result has flowed back to the
 * dispatcher (so it can persist the result to `output` first, for
 * diagnosis).
 *
 * @param deps - The injected `AWS.M3LECSOperations`, the target `cluster`,
 *   the already-resolved `services` list, and the optional `maxWaitTime`
 *   override (in seconds).
 * @returns The `M3LECSWaiterResult`, unchanged.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { waitServices } from "./wait-services.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LECSOperations(script.aws.clients.ecs)`.
 * declare const operations: AWS.M3LECSOperations;
 *
 * const result = await waitServices({
 *   operations,
 *   cluster: "my-cluster",
 *   services: ["svc-a", "svc-b"],
 *   maxWaitTime: undefined,
 * });
 * ```
 */
export function waitServices(
  deps: WaitServicesDeps,
): Promise<AWS.M3LECSWaiterResult> {
  return deps.operations.waitUntilServicesStable(deps.cluster, deps.services, {
    ...(deps.maxWaitTime !== undefined && { maxWaitTime: deps.maxWaitTime }),
  });
}
