/**
 * `config/runs` — resolves the X4 run-governor's boot-time configuration
 * from environment variables: the scripts directory, per-script and global
 * concurrency limits, the run queue's capacity and timeout, the stream
 * retention window, and the kill-signal grace period.
 *
 * @packageDocumentation
 */

import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";
import {
  CONFIG_INVALID_CODE,
  MAX_TIMER_DELAY_MS,
  populateConfig,
  type SettingDescriptor,
  wrapConfigRead,
} from "./settings.js";

/** Dotted config key for the scripts directory. */
const SCRIPTS_DIR_KEY = "m3l.console.runs.scripts.dir";
/** Dotted config key for the per-script concurrency limit. */
const MAX_PER_SCRIPT_KEY = "m3l.console.runs.max.per.script";
/** Dotted config key for the run queue's capacity. */
const QUEUE_CAPACITY_KEY = "m3l.console.runs.queue.capacity";
/** Dotted config key for the per-run output stream retention window. */
const STREAM_RETENTION_KEY = "m3l.console.runs.stream.retention";
/** Dotted config key for the kill-signal grace period. */
const KILL_TIMEOUT_KEY = "m3l.console.runs.kill.timeout.ms";
/** Dotted config key for the global concurrency limit. */
const MAX_CONCURRENCY_KEY = "m3l.console.runs.max.concurrency";
/** Dotted config key for the queued-run timeout. */
const QUEUE_TIMEOUT_KEY = "m3l.console.runs.queue.timeout.ms";

/** Default per-script concurrency limit. */
const DEFAULT_MAX_PER_SCRIPT = 1;
/** Default run queue capacity. */
const DEFAULT_QUEUE_CAPACITY = 16;
/** Default per-run output stream retention window (line count). */
const DEFAULT_STREAM_RETENTION = 256;
/** Default kill-signal grace period, in milliseconds. */
const DEFAULT_KILL_TIMEOUT_MS = 5000;
/** Default global concurrency limit. */
const DEFAULT_MAX_CONCURRENCY = 4;
/** Default queued-run timeout, in milliseconds. */
const DEFAULT_QUEUE_TIMEOUT_MS = 30000;

/**
 * Every documented setting this module resolves, as a
 * {@link SettingDescriptor} table passed to {@link populateConfig}.
 * `scriptsDir` has `defaultValue: undefined` — required-with-no-default, left
 * unset for a later accessor read to reject.
 */
const SETTINGS: readonly SettingDescriptor[] = [
  {
    key: SCRIPTS_DIR_KEY,
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: undefined,
  },
  {
    key: MAX_PER_SCRIPT_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_MAX_PER_SCRIPT,
  },
  {
    key: QUEUE_CAPACITY_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_QUEUE_CAPACITY,
  },
  {
    key: STREAM_RETENTION_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_STREAM_RETENTION,
  },
  {
    key: KILL_TIMEOUT_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_KILL_TIMEOUT_MS,
  },
  {
    key: MAX_CONCURRENCY_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_MAX_CONCURRENCY,
  },
  {
    key: QUEUE_TIMEOUT_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_QUEUE_TIMEOUT_MS,
  },
];

/**
 * Reads the required scripts directory, rejects a missing, empty, or
 * whitespace-only value, and resolves it to an absolute path via
 * `path.resolve` — a relative value is resolved against `process.cwd()`.
 */
function resolveScriptsDir(accessor: Core.M3LConfigAccessor): string {
  const scriptsDir = wrapConfigRead(SCRIPTS_DIR_KEY, () =>
    accessor.requiredString(SCRIPTS_DIR_KEY, "start the console server"),
  );
  if (scriptsDir.trim().length === 0) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      "the run governor requires a scripts directory; M3L_CONSOLE_RUNS_SCRIPTS_DIR must not be blank",
      { context: { key: SCRIPTS_DIR_KEY } },
    );
  }
  return path.resolve(scriptsDir);
}

/** Reads the resolved per-script concurrency limit and rejects a value below 1. */
function resolveMaxPerScript(accessor: Core.M3LConfigAccessor): number {
  const maxPerScript = wrapConfigRead(MAX_PER_SCRIPT_KEY, () =>
    accessor.numberWithDefault(MAX_PER_SCRIPT_KEY, DEFAULT_MAX_PER_SCRIPT),
  );
  if (!Number.isInteger(maxPerScript) || maxPerScript < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${MAX_PER_SCRIPT_KEY}' must be an integer of at least 1`,
      { context: { key: MAX_PER_SCRIPT_KEY } },
    );
  }
  return maxPerScript;
}

/** Reads the resolved run queue capacity and rejects a negative value. */
function resolveQueueCapacity(accessor: Core.M3LConfigAccessor): number {
  const queueCapacity = wrapConfigRead(QUEUE_CAPACITY_KEY, () =>
    accessor.numberWithDefault(QUEUE_CAPACITY_KEY, DEFAULT_QUEUE_CAPACITY),
  );
  if (!Number.isInteger(queueCapacity) || queueCapacity < 0) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${QUEUE_CAPACITY_KEY}' must be a non-negative integer`,
      { context: { key: QUEUE_CAPACITY_KEY } },
    );
  }
  return queueCapacity;
}

/** Reads the resolved stream retention and rejects a value below 1. */
function resolveStreamRetention(accessor: Core.M3LConfigAccessor): number {
  const streamRetention = wrapConfigRead(STREAM_RETENTION_KEY, () =>
    accessor.numberWithDefault(STREAM_RETENTION_KEY, DEFAULT_STREAM_RETENTION),
  );
  if (!Number.isInteger(streamRetention) || streamRetention < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${STREAM_RETENTION_KEY}' must be an integer of at least 1`,
      { context: { key: STREAM_RETENTION_KEY } },
    );
  }
  return streamRetention;
}

/**
 * Reads the resolved kill-signal grace period and rejects a non-positive
 * value or one above {@link MAX_TIMER_DELAY_MS} — the same Node 32-bit
 * signed timer bound `config/env.ts`'s drain timeout is capped at.
 */
function resolveKillTimeoutMs(accessor: Core.M3LConfigAccessor): number {
  const killTimeoutMs = wrapConfigRead(KILL_TIMEOUT_KEY, () =>
    accessor.numberWithDefault(KILL_TIMEOUT_KEY, DEFAULT_KILL_TIMEOUT_MS),
  );
  if (
    !Number.isInteger(killTimeoutMs) ||
    killTimeoutMs <= 0 ||
    killTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${KILL_TIMEOUT_KEY}' must be a positive integer number of milliseconds, at most ${String(MAX_TIMER_DELAY_MS)}`,
      { context: { key: KILL_TIMEOUT_KEY } },
    );
  }
  return killTimeoutMs;
}

/** Reads the resolved global concurrency limit and rejects a value below 1. */
function resolveMaxConcurrency(accessor: Core.M3LConfigAccessor): number {
  const maxConcurrency = wrapConfigRead(MAX_CONCURRENCY_KEY, () =>
    accessor.numberWithDefault(MAX_CONCURRENCY_KEY, DEFAULT_MAX_CONCURRENCY),
  );
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${MAX_CONCURRENCY_KEY}' must be an integer of at least 1`,
      { context: { key: MAX_CONCURRENCY_KEY } },
    );
  }
  return maxConcurrency;
}

/**
 * Reads the resolved queued-run timeout and rejects a non-positive value or
 * one above {@link MAX_TIMER_DELAY_MS}.
 */
function resolveQueueTimeoutMs(accessor: Core.M3LConfigAccessor): number {
  const queueTimeoutMs = wrapConfigRead(QUEUE_TIMEOUT_KEY, () =>
    accessor.numberWithDefault(QUEUE_TIMEOUT_KEY, DEFAULT_QUEUE_TIMEOUT_MS),
  );
  if (
    !Number.isInteger(queueTimeoutMs) ||
    queueTimeoutMs <= 0 ||
    queueTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${QUEUE_TIMEOUT_KEY}' must be a positive integer number of milliseconds, at most ${String(MAX_TIMER_DELAY_MS)}`,
      { context: { key: QUEUE_TIMEOUT_KEY } },
    );
  }
  return queueTimeoutMs;
}

/**
 * The X4 run-governor's resolved boot-time configuration.
 *
 * @example
 * ```ts
 * function describe(config: M3LConsoleRunsConfig): string {
 *   return `${config.scriptsDir} (max ${String(config.maxConcurrency)} concurrent)`;
 * }
 * ```
 */
export interface M3LConsoleRunsConfig {
  /** The resolved, absolute path to the scripts directory. */
  readonly scriptsDir: string;
  /** The maximum number of concurrent runs allowed per script. */
  readonly maxPerScript: number;
  /** The maximum number of runs the queue may hold once every slot is busy. */
  readonly queueCapacity: number;
  /** How many output lines a run's stream retains for replay. */
  readonly streamRetention: number;
  /** How long a killed run is given to exit before it is force-killed. */
  readonly killTimeoutMs: number;
  /** The maximum number of runs allowed to execute concurrently, across every script. */
  readonly maxConcurrency: number;
  /** How long a queued run waits for a free slot before it times out. */
  readonly queueTimeoutMs: number;
}

/**
 * Constructor options for {@link loadRunsConfig}.
 *
 * @example
 * ```ts
 * const options: LoadRunsConfigOptions = { env: process.env };
 * ```
 */
export interface LoadRunsConfigOptions {
  /** The environment variable map to resolve settings from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the X4 run-governor's boot-time {@link M3LConsoleRunsConfig} from
 * environment variables. Every setting is read from `options.env` (or
 * `process.env` by default) — `options.env` is never mutated.
 *
 * A missing, empty, or whitespace-only `M3L_CONSOLE_RUNS_SCRIPTS_DIR` throws;
 * the resolved value is always made absolute via `path.resolve` (a relative
 * value resolves against `process.cwd()`). `M3L_CONSOLE_RUNS_MAX_PER_SCRIPT`
 * and `M3L_CONSOLE_RUNS_MAX_CONCURRENCY` must be integers of at least `1`;
 * `M3L_CONSOLE_RUNS_QUEUE_CAPACITY` must be a non-negative integer;
 * `M3L_CONSOLE_RUNS_STREAM_RETENTION` must be an integer of at least `1`;
 * `M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS` and `M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS`
 * must be positive integers no greater than {@link MAX_TIMER_DELAY_MS} (see
 * that constant's TSDoc for why an unbounded timer delay is a silent,
 * inverted footgun). Every failure surfaces as an {@link M3LConsoleError}
 * with code `"ERR_CONSOLE_CONFIG_INVALID"`, naming the offending key.
 *
 * @param options - See {@link LoadRunsConfigOptions}.
 * @returns The resolved {@link M3LConsoleRunsConfig}.
 * @throws {@link M3LConsoleError} When any setting fails validation.
 *
 * @example
 * ```ts
 * import { loadRunsConfig } from "./config/runs.js";
 *
 * const config = loadRunsConfig({
 *   env: { M3L_CONSOLE_RUNS_SCRIPTS_DIR: "/opt/scripts" },
 * });
 * // { scriptsDir: "/opt/scripts", maxPerScript: 1, queueCapacity: 16, ... }
 * ```
 */
export function loadRunsConfig(
  options: LoadRunsConfigOptions = {},
): M3LConsoleRunsConfig {
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

  const scriptsDir = resolveScriptsDir(accessor);
  const maxPerScript = resolveMaxPerScript(accessor);
  const queueCapacity = resolveQueueCapacity(accessor);
  const streamRetention = resolveStreamRetention(accessor);
  const killTimeoutMs = resolveKillTimeoutMs(accessor);
  const maxConcurrency = resolveMaxConcurrency(accessor);
  const queueTimeoutMs = resolveQueueTimeoutMs(accessor);

  return {
    scriptsDir,
    maxPerScript,
    queueCapacity,
    streamRetention,
    killTimeoutMs,
    maxConcurrency,
    queueTimeoutMs,
  };
}
