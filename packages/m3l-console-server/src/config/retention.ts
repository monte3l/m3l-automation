/**
 * `config/retention` — resolves the X8 run-output retention policy
 * (ADR-0070) from environment variables: how long a terminal run's output
 * directory is kept before it becomes eligible for deletion.
 *
 * A run's output directory is what an operator re-reads when investigating
 * a failure or diffing a rerun, so the default window is a release cycle
 * rather than an incident window: 30 days, a round multiple of a day and
 * not a tuned number.
 *
 * The key lives in the `m3l.console.runs.*` namespace, but this module owns
 * it by concern, not by namespace — `config/paths.ts` already spans three
 * namespaces (`m3l.console.sessions.artifact.root`, `m3l.console.audit.root`,
 * `m3l.console.runs.output.root`), so a retention module distinct from
 * `config/runs.ts` follows that precedent. Adding a required field to
 * `M3LConsoleRunsConfig` instead would break every test building a
 * `streamRetention:` object literal, and would falsify
 * `runs/orchestrator-types.ts`'s claim to mirror `config/runs.js`'s
 * `M3LConsoleRunsConfig` field for field with a setting the orchestrator
 * never reads.
 *
 * This module only DECLARES the policy — it never deletes anything itself.
 * ADR-0070 requires "an operator-run cleanup command — never silent
 * deletion", so pruning is `../run-output-retention.js`'s job, invoked only
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

/** Dotted config key for the run-output retention window. */
const RUN_OUTPUT_RETENTION_KEY = "m3l.console.runs.output.retention.ms";

/** Default run-output retention: 30 days, in milliseconds. */
const DEFAULT_RUN_OUTPUT_RETENTION_MS = 2_592_000_000;

/**
 * Every documented setting this module resolves, as a
 * {@link SettingDescriptor} table passed to {@link populateConfig}.
 */
const SETTINGS: readonly SettingDescriptor[] = [
  {
    key: RUN_OUTPUT_RETENTION_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_RUN_OUTPUT_RETENTION_MS,
  },
];

/**
 * Reads the run-output retention window and rejects a value below 1.
 *
 * `0` is refused rather than accepted as "prune everything": a very large
 * value is how an operator effectively disables the sweep in practice
 * (nothing ever gets old enough to match), so `0` would read ambiguously as
 * either "disable" or "delete all history" and this module picks neither —
 * it is simply not a valid retention window.
 */
function resolveRunOutputRetentionMs(
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
 * The X8 run-output retention policy's resolved value.
 *
 * @example
 * ```ts
 * function isDisabled(config: M3LConsoleRetentionConfig): boolean {
 *   return config.runOutputMs > Number.MAX_SAFE_INTEGER / 2;
 * }
 * ```
 */
export interface M3LConsoleRetentionConfig {
  /** Milliseconds a terminal run's output directory is retained after it ended. */
  readonly runOutputMs: number;
}

/**
 * Constructor options for {@link loadRetentionConfig}.
 *
 * @example
 * ```ts
 * const options: LoadRetentionConfigOptions = { env: process.env };
 * ```
 */
export interface LoadRetentionConfigOptions {
  /** The environment variable map to resolve settings from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the X8 run-output retention policy's boot-time
 * {@link M3LConsoleRetentionConfig} from environment variables. The setting
 * is read from `options.env` (or `process.env` by default) — `options.env`
 * is never mutated.
 *
 * `M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS` must be an integer of at least `1`;
 * a failure surfaces as an {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_CONFIG_INVALID"`, naming the offending key.
 *
 * @param options - See {@link LoadRetentionConfigOptions}.
 * @returns The resolved {@link M3LConsoleRetentionConfig}.
 * @throws {@link M3LConsoleError} When the setting fails validation.
 *
 * @example
 * ```ts
 * import { loadRetentionConfig } from "./config/retention.js";
 *
 * const config = loadRetentionConfig({
 *   env: { M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS: "3600000" },
 * });
 * // { runOutputMs: 3_600_000 }
 * ```
 */
export function loadRetentionConfig(
  options: LoadRetentionConfigOptions = {},
): M3LConsoleRetentionConfig {
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
    runOutputMs: resolveRunOutputRetentionMs(
      accessor,
      RUN_OUTPUT_RETENTION_KEY,
      DEFAULT_RUN_OUTPUT_RETENTION_MS,
    ),
  };
}
