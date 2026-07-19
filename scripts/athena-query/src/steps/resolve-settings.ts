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

/**
 * Thrown by {@link resolveAthenaSettings} when a declared config value
 * resolves to a type other than the one `config.ts` declared. A
 * config-wiring bug — not a runtime condition a caller can recover from.
 * Local to this script — never re-exported from the library.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // resolveAthenaSettings(config)
 * } catch (error) {
 *   if (error instanceof M3LError) {
 *     console.error(error.code, error.message);
 *   }
 * }
 * ```
 */
class AthenaSettingsError extends Core.M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ATHENA_SETTINGS"`. */
  override readonly code = "ERR_ATHENA_SETTINGS" as const;

  /**
   * Creates a new `AthenaSettingsError`.
   *
   * @param message - Human-readable description of the failure.
   */
  constructor(message: string) {
    super(message, { code: "ERR_ATHENA_SETTINGS" });
  }
}

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

/** Narrows an unknown config value to a `string`. See {@link AthenaSettingsError}. */
function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AthenaSettingsError(
      `configuration parameter '${name}' resolved to a non-string value`,
    );
  }
  return value;
}

/** Narrows an unknown, possibly-`undefined` config value to an optional `string`. */
function asOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : asString(value, name);
}

/** Narrows an unknown, possibly-`undefined` config value to an optional `readonly string[]`. */
function asOptionalStringArray(
  value: unknown,
  name: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AthenaSettingsError(
      `configuration parameter '${name}' resolved to a non-string-array value`,
    );
  }
  // `Array.isArray` narrows to `any[]` (a known lib.es5.d.ts quirk), and the
  // guard above has already verified every element is a `string`.
  return value as readonly string[];
}

/** Narrows an unknown config value to a `boolean`. See {@link AthenaSettingsError}. */
function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new AthenaSettingsError(
      `configuration parameter '${name}' resolved to a non-boolean value`,
    );
  }
  return value;
}

/** Narrows an unknown config value to the declared `format` union. See {@link AthenaSettingsError}. */
function asFormat(value: unknown): "json" | "csv" {
  if (value !== "json" && value !== "csv") {
    throw new AthenaSettingsError(
      `configuration parameter 'format' resolved to an unsupported value`,
    );
  }
  return value;
}

/**
 * Builds the `StartAthenaQueryInput` from the resolved config, omitting any
 * unset optional field rather than passing it through as `undefined`.
 */
function buildStartInput(config: Core.M3LConfig): AWS.StartAthenaQueryInput {
  const queryString = asString(config.get("queryString"), "queryString");
  const database = asOptionalString(config.get("database"), "database");
  const catalog = asOptionalString(config.get("catalog"), "catalog");
  const outputLocation = asOptionalString(
    config.get("outputLocation"),
    "outputLocation",
  );
  const workGroup = asOptionalString(config.get("workGroup"), "workGroup");
  const executionParameters = asOptionalStringArray(
    config.get("executionParameters"),
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
 * @throws {@link AthenaSettingsError} When a declared config value resolves
 *   to an unexpected type.
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
  const output = asString(config.get("output"), "output");
  const format = asFormat(config.get("format"));
  const resume = asBoolean(config.get("resume"), "resume");
  const startInput = buildStartInput(config);

  return { startInput, format, output, resume };
}
