import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The three `wait-stack-*-complete` operations `waitStack` dispatches. */
type WaitOperation =
  | "wait-stack-create-complete"
  | "wait-stack-update-complete"
  | "wait-stack-delete-complete";

/**
 * The dependencies `waitStack` needs, already resolved by
 * `run-cloudformation-stacks` — this step takes no raw `Core.M3LConfig` and
 * never gates (no `prompt`/`confirm` field at all; none of the three wait
 * operations is destructive).
 */
interface WaitStackDeps {
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly operation: WaitOperation;
  readonly stackName: string;
  readonly maxWaitTime: number | undefined;
}

/**
 * Runs the three `wait-stack-*-complete` operations: calls the matching
 * `waitUntilStackCreateComplete`/`waitUntilStackUpdateComplete`/
 * `waitUntilStackDeleteComplete(stackName, { maxWaitTime })`.
 *
 * This step deliberately does **not** inspect or throw on a non-`SUCCESS`
 * resolved state (`"TIMEOUT"`/`"ABORTED"`) — turning that into a run failure
 * is `run-cloudformation-stacks`'s decision to make once the result has
 * flowed back to the dispatcher (so it can persist the result to `output`
 * first, for diagnosis).
 *
 * @param deps - The injected `AWS.M3LCloudFormationOperations`, which wait
 *   operation to run, the target `stackName`, and the optional `maxWaitTime`
 *   override (in seconds).
 * @returns The `M3LCloudFormationWaiterResult`, unchanged.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { waitStack } from "./wait-stack.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCloudFormationOperations(script.aws.clients.cloudFormation)`.
 * declare const operations: AWS.M3LCloudFormationOperations;
 *
 * const result = await waitStack({
 *   operations,
 *   operation: "wait-stack-create-complete",
 *   stackName: "my-stack",
 *   maxWaitTime: undefined,
 * });
 * ```
 */
export function waitStack(
  deps: WaitStackDeps,
): Promise<AWS.M3LCloudFormationWaiterResult> {
  const options = {
    ...(deps.maxWaitTime !== undefined && { maxWaitTime: deps.maxWaitTime }),
  };

  switch (deps.operation) {
    case "wait-stack-create-complete":
      return deps.operations.waitUntilStackCreateComplete(
        deps.stackName,
        options,
      );
    case "wait-stack-update-complete":
      return deps.operations.waitUntilStackUpdateComplete(
        deps.stackName,
        options,
      );
    case "wait-stack-delete-complete":
      return deps.operations.waitUntilStackDeleteComplete(
        deps.stackName,
        options,
      );
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      });
    }
  }
}
