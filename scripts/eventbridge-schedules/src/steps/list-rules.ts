import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import { readOptionalString } from "./config-helpers.js";

/**
 * Drains every `listRules()` page starting from `namePrefix`/`eventBusName`,
 * looping while a page's `nextToken` is present and threading it back as the
 * next call's `nextToken`.
 */
async function drainRules(
  eventBridgeOperations: AWS.M3LEventBridgeOperations,
  namePrefix: string | undefined,
  eventBusName: string | undefined,
): Promise<readonly AWS.M3LEventBridgeRule[]> {
  const rules: AWS.M3LEventBridgeRule[] = [];
  let nextToken: string | undefined;
  do {
    const result = await eventBridgeOperations.listRules({
      ...(namePrefix !== undefined && { namePrefix }),
      ...(eventBusName !== undefined && { eventBusName }),
      ...(nextToken !== undefined && { nextToken }),
    });
    rules.push(...result.rules);
    nextToken = result.nextToken;
  } while (nextToken !== undefined);
  return rules;
}

/**
 * `eventbridge-schedules`'s `list` operation: drains every page of
 * `eventBridgeOperations.listRules()` (optionally filtered by `namePrefix`/
 * `eventBusName`), then either writes the accumulated array to `output` (a
 * JSON array via {@link Core.M3LJSONListExporter}) or logs the count.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, and the provisioned `eventBridgeOperations` wrapper.
 * @throws Propagates a `listRules()` rejection unmodified.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { listRules } from "./list-rules.js";
 *
 * declare const eventBridgeOperations: AWS.M3LEventBridgeOperations;
 * await listRules({
 *   config: new Core.M3LConfig(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   eventBridgeOperations,
 * });
 * ```
 */
export async function listRules(deps: {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
}): Promise<void> {
  const namePrefix = readOptionalString(deps.config, "namePrefix");
  const eventBusName = readOptionalString(deps.config, "eventBusName");
  const output = readOptionalString(deps.config, "output");

  const rules = await drainRules(
    deps.eventBridgeOperations,
    namePrefix,
    eventBusName,
  );

  if (output !== undefined) {
    const exporter = new Core.M3LJSONListExporter<AWS.M3LEventBridgeRule>({
      filePath: deps.paths.resolveOutput(output),
      format: "array",
    });
    await exporter.export(rules);
    return;
  }

  deps.logger.step(
    `eventbridge-schedules run ${deps.correlationId} listed ${String(rules.length)} rule(s)`,
  );
}
