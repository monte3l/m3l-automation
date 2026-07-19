import { Core } from "@m3l-automation/m3l-common";

/**
 * `config-helpers` — the config-read helpers shared across every
 * `eventbridge-schedules` step (`list-rules`, `describe-rule`, `put-rule`,
 * `delete-rule`, `enable-rule`, `disable-rule`). Every operation-specific
 * requiredness check (e.g. `ruleName` for `describe`/`delete`/`enable`/
 * `disable`/`create`/`update`) is guard-checked here rather than on the
 * shared config schema, since `ruleName` is never declared `required: true`
 * there (see `src/config.ts`).
 */

/** The config-error code every `eventbridge-schedules` guard/parse failure throws with. */
export const CONFIG_ERROR_CODE = "ERR_EVENTBRIDGE_SCHEDULES_CONFIG";

/**
 * Reads an optional string config parameter, treating an empty string as
 * unset.
 *
 * @param config - The resolved script configuration.
 * @param name - The config parameter name to read.
 * @returns The string value, or `undefined` when unset, empty, or stored as
 *   a non-string value.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { readOptionalString } from "./config-helpers.js";
 *
 * declare const config: Core.M3LConfig;
 * const namePrefix = readOptionalString(config, "namePrefix");
 * ```
 */
export function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

/**
 * Reads the required `ruleName` config parameter, throwing when it is
 * missing or was stored as an empty/non-string value.
 *
 * @param config - The resolved script configuration.
 * @param operation - The operation name requiring `ruleName`, echoed into
 *   both the thrown error's message and its `context`.
 * @returns The non-empty `ruleName` string.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_CONFIG"`
 *   with `context: { operation }` when `ruleName` is missing.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { readRequiredRuleName } from "./config-helpers.js";
 *
 * declare const config: Core.M3LConfig;
 * const ruleName = readRequiredRuleName(config, "delete");
 * ```
 */
export function readRequiredRuleName(
  config: Core.M3LConfig,
  operation: string,
): string {
  const value = readOptionalString(config, "ruleName");
  if (value === undefined) {
    throw new Core.M3LError(`'ruleName' is required for '${operation}'`, {
      code: CONFIG_ERROR_CODE,
      context: { operation },
    });
  }
  return value;
}

/**
 * Reads the optional `eventBusName` config parameter.
 *
 * @param config - The resolved script configuration.
 * @returns The non-empty `eventBusName` string, or `undefined` when unset,
 *   empty, or stored as a non-string value.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { readOptionalEventBusName } from "./config-helpers.js";
 *
 * declare const config: Core.M3LConfig;
 * const eventBusName = readOptionalEventBusName(config);
 * ```
 */
export function readOptionalEventBusName(
  config: Core.M3LConfig,
): string | undefined {
  return readOptionalString(config, "eventBusName");
}
