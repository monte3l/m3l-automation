import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import { readOptionalString, readRequiredRuleName } from "./config-helpers.js";

/**
 * `eventbridge-schedules`'s `describe` operation: fetches one rule's full
 * detail via `eventBridgeOperations.describeRule()`, then either writes the
 * detail to `output` as a single JSON document (via
 * {@link Core.M3LJSONFileExporter} — never wrapped in an array) or logs it.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, and the provisioned `eventBridgeOperations` wrapper.
 * @throws {@link Core.M3LError} coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` when
 *   `ruleName` is missing.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { describeRule } from "./describe-rule.js";
 *
 * declare const eventBridgeOperations: AWS.M3LEventBridgeOperations;
 * await describeRule({
 *   config: new Core.M3LConfig(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   eventBridgeOperations,
 * });
 * ```
 */
export async function describeRule(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  const ruleName = readRequiredRuleName(deps.config, "describe");
  const eventBusName = readOptionalString(deps.config, "eventBusName");
  const output = readOptionalString(deps.config, "output");

  const detail = await deps.eventBridgeOperations.describeRule(ruleName, {
    ...(eventBusName !== undefined && { eventBusName }),
  });

  if (output !== undefined) {
    const exporter = new Core.M3LJSONFileExporter({
      filePath: deps.paths.resolveOutput(output),
    });
    await exporter.export(detail);
    return;
  }

  deps.logger.step(
    `eventbridge-schedules run ${deps.correlationId} described rule '${ruleName}'`,
    { detail },
  );
}
