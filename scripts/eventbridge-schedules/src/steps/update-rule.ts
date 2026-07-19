import type { AWS, Core } from "@m3l-automation/m3l-common";

import { putRuleStep } from "./put-rule.js";

/**
 * `eventbridge-schedules`'s `update` operation: a thin delegate to the
 * shared `putRuleStep` helper (`src/steps/put-rule.ts`), called with
 * `operation: "update"`. All guard-checking (`ruleName`, the exactly-one
 * `eventPattern`/`scheduleExpression` discriminant) and the `putRule` +
 * optional `putTargets` calls live in `putRuleStep` — this module owns no
 * logic of its own beyond the delegation.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, and the provisioned `eventBridgeOperations` wrapper.
 * @throws {@link Core.M3LError} coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` when
 *   `ruleName` is missing, the `eventPattern`/`scheduleExpression`
 *   discriminant is not exactly one, or `targets` is malformed (see
 *   `putRuleStep`).
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { updateRule } from "./update-rule.js";
 *
 * declare const eventBridgeOperations: AWS.M3LEventBridgeOperations;
 * await updateRule({
 *   config: new Core.M3LConfig(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   eventBridgeOperations,
 * });
 * ```
 */
export async function updateRule(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  return putRuleStep(deps, "update");
}
