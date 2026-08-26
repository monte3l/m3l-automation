import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import { CONFIG_ERROR_CODE } from "./config-helpers.js";

/**
 * Drains every `listRules()` page starting from `namePrefix`/`eventBusName`,
 * looping while a page's `nextToken` is present and threading it back as the
 * next call's `nextToken`; a `nextToken` repeated across two consecutive
 * pages throws `ERR_NO_PROGRESS` instead of looping forever.
 */
async function drainRules(
  eventBridgeOperations: AWS.M3LEventBridgeOperations,
  namePrefix: string | undefined,
  eventBusName: string | undefined,
): Promise<readonly AWS.M3LEventBridgeRule[]> {
  const rules: AWS.M3LEventBridgeRule[] = [];
  let nextToken: string | undefined;
  let pagesFetched = 0;
  do {
    const result = await eventBridgeOperations.listRules({
      ...(namePrefix !== undefined && { namePrefix }),
      ...(eventBusName !== undefined && { eventBusName }),
      ...(nextToken !== undefined && { nextToken }),
    });
    pagesFetched += 1;
    rules.push(...result.rules);
    const previousToken = nextToken;
    nextToken = result.nextToken;
    if (
      nextToken !== undefined &&
      previousToken !== undefined &&
      nextToken === previousToken
    ) {
      throw new Core.M3LError(
        "eventbridge-schedules listRules pagination did not advance: nextToken repeated across pages",
        { code: "ERR_NO_PROGRESS", context: { nextToken, pagesFetched } },
      );
    }
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
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: CONFIG_ERROR_CODE,
  });
  const namePrefix = accessor.optionalNonEmptyString("namePrefix");
  const eventBusName = accessor.optionalNonEmptyString("eventBusName");
  const output = accessor.optionalNonEmptyString("output");

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
