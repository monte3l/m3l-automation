import type { AWS } from "@m3l-automation/m3l-common";

/**
 * The dependencies `readStackEvents` needs, already resolved by
 * `run-cloudformation-stacks` — this step takes no raw `Core.M3LConfig` and
 * is never gated (read-only).
 */
interface ReadStackEventsDeps {
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly stackName: string;
  readonly nextToken: string | undefined;
}

/**
 * Runs `describe-stack-events`
 * (`operations.describeStackEvents(stackName, { nextToken })`), returning the
 * raw `M3LCloudFormationDescribeStackEventsResult` unchanged.
 *
 * @param deps - The injected `AWS.M3LCloudFormationOperations`, the target
 *   `stackName`, and the optional `nextToken`.
 * @returns The raw `M3LCloudFormationDescribeStackEventsResult`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { readStackEvents } from "./read-stack-events.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCloudFormationOperations(script.aws.clients.cloudFormation)`.
 * declare const operations: AWS.M3LCloudFormationOperations;
 *
 * const { stackEvents } = await readStackEvents({
 *   operations,
 *   stackName: "my-stack",
 *   nextToken: undefined,
 * });
 * ```
 */
export function readStackEvents(
  deps: ReadStackEventsDeps,
): Promise<AWS.M3LCloudFormationDescribeStackEventsResult> {
  return deps.operations.describeStackEvents(deps.stackName, {
    ...(deps.nextToken !== undefined && { nextToken: deps.nextToken }),
  });
}
