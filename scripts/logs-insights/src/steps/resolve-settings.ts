/**
 * `steps/resolve-settings` — parses the resolved `logs-insights` config into
 * a typed run-settings object.
 *
 * Business logic lives here — never in `main.ts`. Presence/non-emptiness of
 * `start`/`end` (and every other required parameter) is already enforced by
 * the declared config schema (`config.ts`) at config-load time; this module
 * owns only the cross-parameter/format guard the per-parameter validators
 * cannot express — ISO-8601 parsing and `start < end`.
 */

import { Core } from "@m3l-automation/m3l-common";

/** Milliseconds in one second, used to convert `Date.parse` output to epoch seconds. */
const MS_PER_SECOND = 1000;

/**
 * Thrown by {@link resolveSettings} when `start`/`end` cannot be parsed as
 * ISO-8601 dates, or when the resolved range is empty or inverted
 * (`start >= end`). Local to this script — never re-exported from the
 * library.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // resolveSettings(config)
 * } catch (error) {
 *   if (error instanceof M3LError) {
 *     console.error(error.code, error.message);
 *   }
 * }
 * ```
 */
class LogsInsightsSettingsError extends Core.M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_LOGS_INSIGHTS_SETTINGS"`. */
  override readonly code = "ERR_LOGS_INSIGHTS_SETTINGS" as const;

  /**
   * Creates a new `LogsInsightsSettingsError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - An optional `cause` chaining the underlying failure
   *   (e.g. an unparseable date string never throws its own error, so this
   *   is typically omitted).
   */
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, {
      code: "ERR_LOGS_INSIGHTS_SETTINGS",
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}

/**
 * The typed, run-ready settings `run-logs-insights.ts` composes against —
 * the resolved config plus `start`/`end` converted to epoch seconds.
 */
export interface LogsInsightsRunSettings {
  /** Log group names, forwarded verbatim to every window's `StartQuery`. */
  readonly logGroups: readonly string[];
  /** The Logs Insights query string, applied identically to every window. */
  readonly query: string;
  /** Inclusive start of the overall time range, epoch seconds. */
  readonly startEpochSeconds: number;
  /** Exclusive end of the overall time range, epoch seconds. */
  readonly endEpochSeconds: number;
  /** Size of each query window, in minutes. */
  readonly windowMinutes: number;
  /** Optional per-window row cap. */
  readonly limit: number | undefined;
  /** Output format, selecting the exporter. */
  readonly format: "json" | "csv";
  /** Output file name, resolved under `M3L_OUTPUT_DIR`. */
  readonly output: string;
  /** Whether to resume from the checkpoint instead of starting over. */
  readonly resume: boolean;
}

/**
 * Narrows an unknown config value to a `string`, throwing
 * {@link LogsInsightsSettingsError} when it is not — a config-wiring bug
 * (the schema declared this parameter `STRING`), not a runtime condition.
 */
function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new LogsInsightsSettingsError(
      `configuration parameter '${name}' resolved to a non-string value`,
    );
  }
  return value;
}

/** Narrows an unknown config value to a `readonly string[]`. See {@link asString}. */
function asStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new LogsInsightsSettingsError(
      `configuration parameter '${name}' resolved to a non-string-array value`,
    );
  }
  // `Array.isArray` narrows to `any[]` (a known lib.es5.d.ts quirk), and the
  // guard above has already verified every element is a `string`.
  return value as readonly string[];
}

/** Narrows an unknown config value to a `number`. See {@link asString}. */
function asNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new LogsInsightsSettingsError(
      `configuration parameter '${name}' resolved to a non-number value`,
    );
  }
  return value;
}

/** Narrows an unknown config value to a `boolean`. See {@link asString}. */
function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new LogsInsightsSettingsError(
      `configuration parameter '${name}' resolved to a non-boolean value`,
    );
  }
  return value;
}

/** Narrows an unknown config value to the declared `format` union. See {@link asString}. */
function asFormat(value: unknown): "json" | "csv" {
  if (value !== "json" && value !== "csv") {
    throw new LogsInsightsSettingsError(
      `configuration parameter 'format' resolved to an unsupported value`,
    );
  }
  return value;
}

/**
 * Parses `value` (an ISO-8601 date string) into epoch seconds.
 *
 * @param value - The raw config value for `start`/`end`.
 * @param name - The parameter name, for the thrown error message.
 * @throws {@link LogsInsightsSettingsError} When `value` is not a string, or
 *   is not a parseable date.
 */
function parseEpochSeconds(value: unknown, name: string): number {
  const raw = asString(value, name);
  const millis = Date.parse(raw);
  if (Number.isNaN(millis)) {
    throw new LogsInsightsSettingsError(
      `configuration parameter '${name}' is not a valid ISO-8601 date: '${raw}'`,
    );
  }
  return Math.floor(millis / MS_PER_SECOND);
}

/**
 * Parses the resolved `logs-insights` config into a typed
 * {@link LogsInsightsRunSettings}, converting `start`/`end` to epoch seconds
 * and guarding the cross-parameter constraint `start < end`.
 *
 * @param config - The resolved configuration store (after `M3LScript`'s
 *   config-load stage has already enforced presence/non-emptiness of every
 *   required parameter).
 * @returns The typed run settings.
 * @throws {@link LogsInsightsSettingsError} When `start`/`end` is not a
 *   parseable ISO-8601 date, or when the resolved range is empty or inverted
 *   (`start >= end`).
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { resolveSettings } from "./resolve-settings.js";
 *
 * function run(config: Core.M3LConfig): void {
 *   const settings = resolveSettings(config);
 *   console.log(settings.startEpochSeconds, settings.endEpochSeconds);
 * }
 * ```
 */
export function resolveSettings(
  config: Core.M3LConfig,
): LogsInsightsRunSettings {
  const startEpochSeconds = parseEpochSeconds(config.get("start"), "start");
  const endEpochSeconds = parseEpochSeconds(config.get("end"), "end");

  if (startEpochSeconds >= endEpochSeconds) {
    throw new LogsInsightsSettingsError(
      "'start' must be strictly before 'end'",
    );
  }

  const limitRaw = config.get("limit");

  return {
    logGroups: asStringArray(config.get("logGroups"), "logGroups"),
    query: asString(config.get("query"), "query"),
    startEpochSeconds,
    endEpochSeconds,
    windowMinutes: asNumber(config.get("windowMinutes"), "windowMinutes"),
    limit: limitRaw === undefined ? undefined : asNumber(limitRaw, "limit"),
    format: asFormat(config.get("format")),
    output: asString(config.get("output"), "output"),
    resume: asBoolean(config.get("resume"), "resume"),
  };
}
