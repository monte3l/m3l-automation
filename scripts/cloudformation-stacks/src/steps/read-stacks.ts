import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readStacks` needs, already resolved by
 * `run-cloudformation-stacks` — this step takes no raw `Core.M3LConfig` and
 * is never gated (neither `list-stacks` nor `describe-stack` is
 * destructive).
 */
interface ReadStacksDeps {
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly operation: "list-stacks" | "describe-stack";
  readonly stackName: string | undefined;
  readonly stackStatusFilter: readonly string[] | undefined;
  readonly nextToken: string | undefined;
}

/**
 * Runs `cloudformation-stacks`'s two read-only stack operations:
 * `list-stacks` (`operations.listStacks({ stackStatusFilter, nextToken })`)
 * and `describe-stack` (`operations.describeStack(stackName)`).
 *
 * Per the spec page, this step never classifies a `describe-stack` result of
 * `undefined` as an error — that is `run-cloudformation-stacks`'s decision to
 * make (`ERR_CLOUDFORMATION_STACKS_NOT_FOUND`), once the result has flowed
 * back to the dispatcher.
 *
 * @param deps - The injected `AWS.M3LCloudFormationOperations`, which
 *   operation to run, and the already-resolved `stackName`/
 *   `stackStatusFilter`/`nextToken` values.
 * @returns The raw `M3LCloudFormationListStacksResult` for `list-stacks`, or
 *   the raw `M3LCloudFormationStack | undefined` for `describe-stack`.
 * @throws {@link Core.M3LError} coded `"ERR_CLOUDFORMATION_STACKS_CONFIG"`
 *   when `stackName` is `undefined` for `describe-stack`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readStacks } from "./read-stacks.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCloudFormationOperations(script.aws.clients.cloudFormation)`.
 * declare const operations: AWS.M3LCloudFormationOperations;
 *
 * const stack = await readStacks({
 *   operations,
 *   operation: "describe-stack",
 *   stackName: "my-stack",
 *   stackStatusFilter: undefined,
 *   nextToken: undefined,
 * });
 * ```
 */
export async function readStacks(
  deps: ReadStacksDeps,
): Promise<
  AWS.M3LCloudFormationListStacksResult | AWS.M3LCloudFormationStack | undefined
> {
  if (deps.operation === "describe-stack") {
    if (deps.stackName === undefined) {
      throw new Core.M3LError(
        "readStacks: 'stackName' is required for 'describe-stack'",
        { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
      );
    }
    return deps.operations.describeStack(deps.stackName);
  }

  return deps.operations.listStacks({
    ...(deps.stackStatusFilter !== undefined && {
      stackStatusFilter: deps.stackStatusFilter,
    }),
    ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
  });
}
