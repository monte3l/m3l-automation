/**
 * `steps/resolve-settings` — parses the resolved `athena-query` config into a
 * typed run-settings object.
 *
 * Business logic lives here — never in `main.ts`. Presence/non-emptiness of
 * every required parameter is already enforced by the declared config schema
 * (`config.ts`) at config-load time; this module owns only the per-field type
 * narrowing `M3LConfig#get` cannot express (it returns `unknown`) and the
 * assembly of the `StartAthenaQueryInput`, omitting any unset optional field
 * rather than passing it through as `undefined`.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `M3LError` code every `resolveAthenaSettings` guard throws with. */
const ATHENA_SETTINGS_CODE = "ERR_ATHENA_SETTINGS";

/** The declared literal set backing `AthenaQuerySettings.format`, for `Core.M3LConfigAccessor.oneOf`. */
const ATHENA_OUTPUT_FORMATS = ["json", "csv"] as const;

/**
 * The typed, run-ready settings `run-athena-query.ts` composes against — the
 * `StartAthenaQueryInput` plus the output-handling fields `runAthenaQuery`
 * reads directly.
 */
export interface AthenaQuerySettings {
  /** The `AWS.M3LAthenaClient.startQuery()` input, ready to pass through. */
  readonly startInput: AWS.StartAthenaQueryInput;
  /** Output format, selecting the exporter. */
  readonly format: "json" | "csv";
  /** Output file name, resolved under `M3L_OUTPUT_DIR`. */
  readonly output: string;
  /** Whether to resume from the checkpoint instead of starting over. */
  readonly resume: boolean;
}

/**
 * Builds the `StartAthenaQueryInput` from the resolved config, omitting any
 * unset optional field rather than passing it through as `undefined`.
 */
function buildStartInput(
  accessor: Core.M3LConfigAccessor,
): AWS.StartAthenaQueryInput {
  const queryString = accessor.requiredString("queryString", "run");
  const database = accessor.optionalString("database");
  const catalog = accessor.optionalString("catalog");
  const outputLocation = accessor.optionalString("outputLocation");
  const workGroup = accessor.optionalString("workGroup");
  const executionParameters = accessor.optionalStringArray(
    "executionParameters",
  );

  return {
    queryString,
    ...(database !== undefined && { database }),
    ...(catalog !== undefined && { catalog }),
    ...(outputLocation !== undefined && { outputLocation }),
    ...(workGroup !== undefined && { workGroup }),
    ...(executionParameters !== undefined && { executionParameters }),
  };
}

/**
 * Parses the resolved `athena-query` config into a typed
 * {@link AthenaQuerySettings}, narrowing every field to the type `config.ts`
 * declared and assembling the `StartAthenaQueryInput`.
 *
 * @param config - The resolved configuration store (after `M3LScript`'s
 *   config-load stage has already enforced presence/non-emptiness of every
 *   required parameter).
 * @returns The typed run settings.
 * @throws {@link Core.M3LError} coded `"ERR_ATHENA_SETTINGS"` when a declared
 *   config value resolves to an unexpected type.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { resolveAthenaSettings } from "./resolve-settings.js";
 *
 * function run(config: Core.M3LConfig): void {
 *   const settings = resolveAthenaSettings(config);
 *   console.log(settings.output, settings.format);
 * }
 * ```
 */
export function resolveAthenaSettings(
  config: Core.M3LConfig,
): AthenaQuerySettings {
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: ATHENA_SETTINGS_CODE,
  });
  const output = accessor.requiredString("output", "run");
  const format = accessor.oneOf("format", ATHENA_OUTPUT_FORMATS);
  const resume = accessor.requiredBoolean("resume", "run");
  const startInput = buildStartInput(accessor);

  return { startInput, format, output, resume };
}
