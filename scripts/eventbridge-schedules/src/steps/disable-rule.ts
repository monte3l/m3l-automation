import type { AWS, Core } from "@m3l-automation/m3l-common";

import {
  readOptionalEventBusName,
  readRequiredRuleName,
} from "./config-helpers.js";

/**
 * `disable-rule` — disables the EventBridge rule named by the
 * config-declared `ruleName`, scoped to `eventBusName` when given, so
 * EventBridge stops matching events against it without deleting it or its
 * targets.
 */

/**
 * Runs the `disable` command: disables the rule named by `ruleName`,
 * honoring `eventBusName`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, and
 *   the injected `AWS.M3LEventBridgeOperations`.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_CONFIG"`
 *   when `ruleName` is missing. A rejection from the underlying
 *   `disableRule` call propagates unchanged.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { disableRule } from "./disable-rule.js";
 *
 * declare const eventBridgeOperations: import("@m3l-automation/m3l-common/aws").M3LEventBridgeOperations;
 *
 * await disableRule({
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
export async function disableRule(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  const ruleName = readRequiredRuleName(deps.config, "disable");
  const eventBusName = readOptionalEventBusName(deps.config);

  await deps.eventBridgeOperations.disableRule(ruleName, {
    ...(eventBusName !== undefined && { eventBusName }),
  });

  deps.logger.step(
    `eventbridge-schedules disable run ${deps.correlationId} complete`,
    { ruleName },
  );
}
