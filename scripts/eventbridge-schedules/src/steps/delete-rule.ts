import type { AWS, Core } from "@m3l-automation/m3l-common";

import {
  readOptionalEventBusName,
  readRequiredRuleName,
} from "./config-helpers.js";

/**
 * `delete-rule` — deletes the EventBridge rule named by the config-declared
 * `ruleName`, scoped to `eventBusName` when given, and forced (removing a
 * managed rule's targets along with it) when `force` is literally `true`.
 */

/**
 * Runs the `delete` command: deletes the rule named by `ruleName`, honoring
 * `eventBusName` and `force`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, and
 *   the injected `AWS.M3LEventBridgeOperations`.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_CONFIG"`
 *   when `ruleName` is missing. A rejection from the underlying
 *   `deleteRule` call propagates unchanged.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { deleteRule } from "./delete-rule.js";
 *
 * declare const eventBridgeOperations: import("@m3l-automation/m3l-common/aws").M3LEventBridgeOperations;
 *
 * await deleteRule({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "eventbridge-schedules", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   eventBridgeOperations,
 * });
 * ```
 */
export async function deleteRule(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  const ruleName = readRequiredRuleName(deps.config, "delete");
  const eventBusName = readOptionalEventBusName(deps.config);
  const force = deps.config.get("force") === true;

  await deps.eventBridgeOperations.deleteRule(ruleName, {
    ...(eventBusName !== undefined && { eventBusName }),
    force,
  });

  deps.logger.step(
    `eventbridge-schedules delete run ${deps.correlationId} complete`,
    { ruleName, force },
  );
}
