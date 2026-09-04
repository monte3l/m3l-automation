/**
 * `config/telemetry` — resolves the X8 telemetry rollup's boot-time
 * retention policy (ADR-0070) from environment variables: one retention
 * window per rollup granularity tier (`minute`, `hour`, `day`).
 *
 * The tiers are not arbitrary. A day of minute-grain detail is what an
 * incident review needs; a month of hour-grain detail is what a trend
 * needs; a year of day-grain detail is what a capacity review needs. The
 * defaults below are round multiples of a day, not tuned numbers.
 *
 * This module only DECLARES the policy — it never deletes anything itself.
 * ADR-0070 requires "an operator-run cleanup command — never silent
 * deletion", so pruning is `../telemetry-retention.js`'s job, invoked only
 * by an explicit operator action (X8 slice 5c).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";
import {
  CONFIG_INVALID_CODE,
  populateConfig,
  type SettingDescriptor,
  wrapConfigRead,
} from "./settings.js";

/** Dotted config key for the minute-tier retention window. */
const MINUTE_RETENTION_KEY = "m3l.console.telemetry.retention.minute.ms";
/** Dotted config key for the hour-tier retention window. */
const HOUR_RETENTION_KEY = "m3l.console.telemetry.retention.hour.ms";
/** Dotted config key for the day-tier retention window. */
const DAY_RETENTION_KEY = "m3l.console.telemetry.retention.day.ms";

/** Default minute-tier retention: 2 days, in milliseconds. */
const DEFAULT_MINUTE_RETENTION_MS = 172_800_000;
/** Default hour-tier retention: 31 days, in milliseconds. */
const DEFAULT_HOUR_RETENTION_MS = 2_678_400_000;
/** Default day-tier retention: 366 days, in milliseconds. */
const DEFAULT_DAY_RETENTION_MS = 31_622_400_000;

/**
 * Every documented setting this module resolves, as a
 * {@link SettingDescriptor} table passed to {@link populateConfig}.
 */
const SETTINGS: readonly SettingDescriptor[] = [
  {
    key: MINUTE_RETENTION_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_MINUTE_RETENTION_MS,
  },
  {
    key: HOUR_RETENTION_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_HOUR_RETENTION_MS,
  },
  {
    key: DAY_RETENTION_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_DAY_RETENTION_MS,
  },
];

/**
 * Reads one tier's resolved retention window and rejects a value below 1.
 *
 * `0` is refused rather than accepted as "prune everything": a very large
 * value is how an operator disables a tier's pruning in practice (nothing
 * ever gets old enough to match), so `0` would read ambiguously as either
 * "disable" or "delete all history" and this module picks neither — it is
 * simply not a valid retention window.
 */
function resolveRetentionMs(
  accessor: Core.M3LConfigAccessor,
  key: string,
  defaultValue: number,
): number {
  const retentionMs = wrapConfigRead(key, () =>
    accessor.numberWithDefault(key, defaultValue),
  );
  if (!Number.isInteger(retentionMs) || retentionMs < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${key}' must be an integer of at least 1`,
      { context: { key } },
    );
  }
  return retentionMs;
}

/**
 * The X8 telemetry rollup's resolved retention policy: one window per
 * granularity tier, in milliseconds. The key names deliberately spell the
 * `store/telemetry-repository-types.ts` `M3LTelemetryGranularity` members
 * structurally rather than importing that type — `config/` may not import
 * `store/` (see `bin/check-eslint-zones.mjs`'s zone table).
 *
 * @example
 * ```ts
 * function isDisabled(config: M3LConsoleTelemetryConfig): boolean {
 *   return config.retentionMs.minute > Number.MAX_SAFE_INTEGER / 2;
 * }
 * ```
 */
export interface M3LConsoleTelemetryConfig {
  /** One retention window per rollup granularity tier, in milliseconds. */
  readonly retentionMs: {
    /** How long minute-grain buckets are kept before they become prunable. */
    readonly minute: number;
    /** How long hour-grain buckets are kept before they become prunable. */
    readonly hour: number;
    /** How long day-grain buckets are kept before they become prunable. */
    readonly day: number;
  };
}

/**
 * Constructor options for {@link loadTelemetryConfig}.
 *
 * @example
 * ```ts
 * const options: LoadTelemetryConfigOptions = { env: process.env };
 * ```
 */
export interface LoadTelemetryConfigOptions {
  /** The environment variable map to resolve settings from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the X8 telemetry rollup's boot-time {@link M3LConsoleTelemetryConfig}
 * from environment variables. Every setting is read from `options.env` (or
 * `process.env` by default) — `options.env` is never mutated.
 *
 * `M3L_CONSOLE_TELEMETRY_RETENTION_MINUTE_MS`,
 * `M3L_CONSOLE_TELEMETRY_RETENTION_HOUR_MS`, and
 * `M3L_CONSOLE_TELEMETRY_RETENTION_DAY_MS` must each be an integer of at
 * least `1`; a failure surfaces as an {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_CONFIG_INVALID"`, naming the offending key.
 *
 * @param options - See {@link LoadTelemetryConfigOptions}.
 * @returns The resolved {@link M3LConsoleTelemetryConfig}.
 * @throws {@link M3LConsoleError} When any setting fails validation.
 *
 * @example
 * ```ts
 * import { loadTelemetryConfig } from "./config/telemetry.js";
 *
 * const config = loadTelemetryConfig({
 *   env: { M3L_CONSOLE_TELEMETRY_RETENTION_MINUTE_MS: "3600000" },
 * });
 * // { retentionMs: { minute: 3_600_000, hour: 2_678_400_000, day: 31_622_400_000 } }
 * ```
 */
export function loadTelemetryConfig(
  options: LoadTelemetryConfigOptions = {},
): M3LConsoleTelemetryConfig {
  const env = options.env ?? process.env;
  const reader = new Core.M3LConfigReader([
    new Core.M3LEnvironmentConfigProvider({ env }),
  ]);
  const config = new Core.M3LConfig();
  populateConfig(reader, config, SETTINGS);

  const accessor = new Core.M3LConfigAccessor({
    config,
    code: CONFIG_INVALID_CODE,
  });

  return {
    retentionMs: {
      minute: resolveRetentionMs(
        accessor,
        MINUTE_RETENTION_KEY,
        DEFAULT_MINUTE_RETENTION_MS,
      ),
      hour: resolveRetentionMs(
        accessor,
        HOUR_RETENTION_KEY,
        DEFAULT_HOUR_RETENTION_MS,
      ),
      day: resolveRetentionMs(
        accessor,
        DAY_RETENTION_KEY,
        DEFAULT_DAY_RETENTION_MS,
      ),
    },
  };
}
