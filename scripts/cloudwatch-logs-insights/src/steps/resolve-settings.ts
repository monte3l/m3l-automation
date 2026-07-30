/**
 * `steps/resolve-settings` — parses the resolved `cloudwatch-logs-insights`
 * config into a typed run-settings object.
 *
 * Business logic lives here — never in `main.ts`. Presence/non-emptiness of
 * `start`/`end` (and every other required parameter), plus the
 * cross-parameter `start < end` ordering constraint, are already enforced by
 * the declared config schema (`config.ts`'s `configParameters` and
 * `configValidators`) at config-load time; this module owns only the
 * ISO-8601 parse the per-parameter validators cannot express.
 */

import { Core } from "@m3l-automation/m3l-common";

/** Milliseconds in one second, used to convert `Date.parse` output to epoch seconds. */
const MS_PER_SECOND = 1000;

/** The `M3LError` code every `resolveSettings` guard throws with. */
const LOGS_INSIGHTS_SETTINGS_CODE = "ERR_LOGS_INSIGHTS_SETTINGS";

/** The declared literal set backing `LogsInsightsRunSettings.format`, for `Core.M3LConfigAccessor.oneOf`. */
const LOGS_INSIGHTS_OUTPUT_FORMATS = ["json", "csv"] as const;

/**
 * The typed, run-ready settings `run-cloudwatch-logs-insights.ts` composes
 * against — the resolved config plus `start`/`end` converted to epoch
 * seconds.
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
 * Parses `name`'s config value (an ISO-8601 date string) into epoch seconds.
 *
 * @param accessor - The script's bound `Core.M3LConfigAccessor`.
 * @param name - The parameter name (`"start"` or `"end"`).
 * @throws {@link Core.M3LError} coded `"ERR_LOGS_INSIGHTS_SETTINGS"` when the
 *   value is missing, empty, non-string, or not a parseable date.
 */
function parseEpochSeconds(
  accessor: Core.M3LConfigAccessor,
  name: string,
): number {
  const raw = accessor.requiredString(name, "run");
  const millis = Date.parse(raw);
  if (Number.isNaN(millis)) {
    throw new Core.M3LError(
      `configuration parameter '${name}' is not a valid ISO-8601 date: '${raw}'`,
      { code: LOGS_INSIGHTS_SETTINGS_CODE },
    );
  }
  return Math.floor(millis / MS_PER_SECOND);
}

/**
 * Parses the resolved `cloudwatch-logs-insights` config into a typed
 * {@link LogsInsightsRunSettings}, converting `start`/`end` to epoch seconds.
 *
 * @param config - The resolved configuration store (after `M3LScript`'s
 *   config-load stage has already enforced presence/non-emptiness of every
 *   required parameter, and the schema-level `start < end` ordering
 *   constraint via `config.ts`'s `configValidators`).
 * @returns The typed run settings.
 * @throws {@link Core.M3LError} coded `"ERR_LOGS_INSIGHTS_SETTINGS"` when
 *   `start`/`end` is not a parseable ISO-8601 date.
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
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: LOGS_INSIGHTS_SETTINGS_CODE,
  });
  const startEpochSeconds = parseEpochSeconds(accessor, "start");
  const endEpochSeconds = parseEpochSeconds(accessor, "end");

  return {
    logGroups: accessor.requiredStringArray("logGroups", "run"),
    query: accessor.requiredString("query", "run"),
    startEpochSeconds,
    endEpochSeconds,
    windowMinutes: accessor.requiredNumber("windowMinutes", "run"),
    limit: accessor.optionalNumber("limit"),
    format: accessor.oneOf("format", LOGS_INSIGHTS_OUTPUT_FORMATS),
    output: accessor.requiredString("output", "run"),
    resume: accessor.requiredBoolean("resume", "run"),
  };
}
