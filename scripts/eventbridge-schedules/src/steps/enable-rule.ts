import type { AWS, Core } from "@m3l-automation/m3l-common";

import {
  readOptionalEventBusName,
  readRequiredRuleName,
} from "./config-helpers.js";

/**
 * `enable-rule` — enables the EventBridge rule named by the config-declared
 * `ruleName`, scoped to `eventBusName` when given, so EventBridge resumes
 * matching events against it.
 */

/**
 * Runs the `enable` command: enables the rule named by `ruleName`, honoring
 * `eventBusName`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, and
 *   the injected `AWS.M3LEventBridgeOperations`.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_CONFIG"`
 *   when `ruleName` is missing. A rejection from the underlying
 *   `enableRule` call propagates unchanged.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { enableRule } from "./enable-rule.js";
 *
 * declare const eventBridgeOperations: import("@m3l-automation/m3l-common/aws").M3LEventBridgeOperations;
 *
 * await enableRule({
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
export async function enableRule(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  const ruleName = readRequiredRuleName(deps.config, "enable");
  const eventBusName = readOptionalEventBusName(deps.config);

  await deps.eventBridgeOperations.enableRule(ruleName, {
    ...(eventBusName !== undefined && { eventBusName }),
  });

  deps.logger.step(
    `eventbridge-schedules enable run ${deps.correlationId} complete`,
    { ruleName },
  );
}
