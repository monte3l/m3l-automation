/**
 * `config/sessions` — resolves the X6 workbench-sessions module's boot-time
 * configuration from environment variables: the inline-artifact byte
 * threshold, the per-artifact byte cap, the per-session running-total byte
 * cap, and the maximum number of concurrently open sessions.
 *
 * Unlike `config/runs.ts`'s `scriptsDir` (required, no default), every
 * setting here has a documented default — the workbench-sessions subsystem
 * is never "not configured" the way run orchestration can be.
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

/** Dotted config key for the inline-artifact byte threshold. */
const ARTIFACT_INLINE_MAX_BYTES_KEY =
  "m3l.console.sessions.artifact.inline.max.bytes";
/** Dotted config key for the per-artifact byte cap. */
const ARTIFACT_MAX_BYTES_KEY = "m3l.console.sessions.artifact.max.bytes";
/** Dotted config key for the per-session running-total byte cap. */
const SESSION_TOTAL_MAX_BYTES_KEY = "m3l.console.sessions.total.max.bytes";
/** Dotted config key for the maximum number of concurrently open sessions. */
const OPEN_SESSIONS_MAX_KEY = "m3l.console.sessions.open.max";

/** Default inline-artifact byte threshold: 64 KiB. */
const DEFAULT_ARTIFACT_INLINE_MAX_BYTES = 65536;
/** Default per-artifact byte cap: 32 MiB. */
const DEFAULT_ARTIFACT_MAX_BYTES = 33554432;
/** Default per-session running-total byte cap: 256 MiB. */
const DEFAULT_SESSION_TOTAL_MAX_BYTES = 268435456;
/** Default maximum number of concurrently open sessions. */
const DEFAULT_OPEN_SESSIONS_MAX = 32;

/**
 * Every documented setting this module resolves, as a
 * {@link SettingDescriptor} table passed to {@link populateConfig}. Every row
 * carries a `defaultValue` — see this module's own `@packageDocumentation`
 * for why.
 */
const SETTINGS: readonly SettingDescriptor[] = [
  {
    key: ARTIFACT_INLINE_MAX_BYTES_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_ARTIFACT_INLINE_MAX_BYTES,
  },
  {
    key: ARTIFACT_MAX_BYTES_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_ARTIFACT_MAX_BYTES,
  },
  {
    key: SESSION_TOTAL_MAX_BYTES_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_SESSION_TOTAL_MAX_BYTES,
  },
  {
    key: OPEN_SESSIONS_MAX_KEY,
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DEFAULT_OPEN_SESSIONS_MAX,
  },
];

/** Reads the resolved inline-artifact byte threshold and rejects a value below 1. */
function resolveArtifactInlineMaxBytes(
  accessor: Core.M3LConfigAccessor,
): number {
  const value = wrapConfigRead(ARTIFACT_INLINE_MAX_BYTES_KEY, () =>
    accessor.numberWithDefault(
      ARTIFACT_INLINE_MAX_BYTES_KEY,
      DEFAULT_ARTIFACT_INLINE_MAX_BYTES,
    ),
  );
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${ARTIFACT_INLINE_MAX_BYTES_KEY}' must be an integer of at least 1`,
      { context: { key: ARTIFACT_INLINE_MAX_BYTES_KEY } },
    );
  }
  return value;
}

/**
 * Reads the resolved per-artifact byte cap, rejects a value below 1, and
 * rejects a value below `artifactInlineMaxBytes` — the cross-field check
 * tying the two together.
 */
function resolveArtifactMaxBytes(
  accessor: Core.M3LConfigAccessor,
  artifactInlineMaxBytes: number,
): number {
  const value = wrapConfigRead(ARTIFACT_MAX_BYTES_KEY, () =>
    accessor.numberWithDefault(
      ARTIFACT_MAX_BYTES_KEY,
      DEFAULT_ARTIFACT_MAX_BYTES,
    ),
  );
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${ARTIFACT_MAX_BYTES_KEY}' must be an integer of at least 1`,
      { context: { key: ARTIFACT_MAX_BYTES_KEY } },
    );
  }
  if (value < artifactInlineMaxBytes) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${ARTIFACT_MAX_BYTES_KEY}' must be at least '${ARTIFACT_INLINE_MAX_BYTES_KEY}'`,
      { context: { key: ARTIFACT_MAX_BYTES_KEY } },
    );
  }
  return value;
}

/**
 * Reads the resolved per-session running-total byte cap, rejects a value
 * below 1, and rejects a value below `artifactMaxBytes` — the cross-field
 * check tying the two together.
 */
function resolveSessionTotalMaxBytes(
  accessor: Core.M3LConfigAccessor,
  artifactMaxBytes: number,
): number {
  const value = wrapConfigRead(SESSION_TOTAL_MAX_BYTES_KEY, () =>
    accessor.numberWithDefault(
      SESSION_TOTAL_MAX_BYTES_KEY,
      DEFAULT_SESSION_TOTAL_MAX_BYTES,
    ),
  );
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${SESSION_TOTAL_MAX_BYTES_KEY}' must be an integer of at least 1`,
      { context: { key: SESSION_TOTAL_MAX_BYTES_KEY } },
    );
  }
  if (value < artifactMaxBytes) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${SESSION_TOTAL_MAX_BYTES_KEY}' must be at least '${ARTIFACT_MAX_BYTES_KEY}'`,
      { context: { key: SESSION_TOTAL_MAX_BYTES_KEY } },
    );
  }
  return value;
}

/** Reads the resolved maximum number of concurrently open sessions and rejects a value below 1. */
function resolveOpenSessionsMax(accessor: Core.M3LConfigAccessor): number {
  const value = wrapConfigRead(OPEN_SESSIONS_MAX_KEY, () =>
    accessor.numberWithDefault(
      OPEN_SESSIONS_MAX_KEY,
      DEFAULT_OPEN_SESSIONS_MAX,
    ),
  );
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `configuration key '${OPEN_SESSIONS_MAX_KEY}' must be an integer of at least 1`,
      { context: { key: OPEN_SESSIONS_MAX_KEY } },
    );
  }
  return value;
}

/**
 * The X6 workbench-sessions module's resolved boot-time configuration.
 *
 * @example
 * ```ts
 * function describe(config: M3LConsoleSessionsConfig): string {
 *   return `inline <= ${String(config.artifactInlineMaxBytes)}B, up to ${String(config.openSessionsMax)} open sessions`;
 * }
 * ```
 */
export interface M3LConsoleSessionsConfig {
  /** The maximum JSON-serialized byte size a step-output artifact may be to be stored inline, rather than as a file. */
  readonly artifactInlineMaxBytes: number;
  /** The maximum JSON-serialized byte size any single step-output artifact may be, inline or file-backed. Always at least `artifactInlineMaxBytes`. */
  readonly artifactMaxBytes: number;
  /** The maximum cumulative byte size of every artifact persisted within one session. Always at least `artifactMaxBytes`. */
  readonly sessionTotalMaxBytes: number;
  /** The maximum number of sessions allowed to be concurrently `open`. */
  readonly openSessionsMax: number;
}

/**
 * Constructor options for {@link loadSessionsConfig}.
 *
 * @example
 * ```ts
 * const options: LoadSessionsConfigOptions = { env: process.env };
 * ```
 */
export interface LoadSessionsConfigOptions {
  /** The environment variable map to resolve settings from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the X6 workbench-sessions module's boot-time
 * {@link M3LConsoleSessionsConfig} from environment variables. Every setting
 * is read from `options.env` (or `process.env` by default) — `options.env`
 * is never mutated, and every setting has a documented default, so this
 * module never throws for being "unconfigured".
 *
 * `M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES`,
 * `M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES`,
 * `M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES`, and
 * `M3L_CONSOLE_SESSIONS_OPEN_MAX` must each be an integer of at least `1`.
 * Two cross-field checks additionally apply, each checked after both
 * operands individually pass their own standalone validation:
 * `artifactMaxBytes` must be at least `artifactInlineMaxBytes`, and
 * `sessionTotalMaxBytes` must be at least `artifactMaxBytes`. Every failure
 * surfaces as an {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_CONFIG_INVALID"`, naming the offending key.
 *
 * @param options - See {@link LoadSessionsConfigOptions}.
 * @returns The resolved {@link M3LConsoleSessionsConfig}.
 * @throws {@link M3LConsoleError} When any setting fails validation.
 *
 * @example
 * ```ts
 * import { loadSessionsConfig } from "./config/sessions.js";
 *
 * const config = loadSessionsConfig({
 *   env: { M3L_CONSOLE_SESSIONS_OPEN_MAX: "8" },
 * });
 * // { artifactInlineMaxBytes: 65536, artifactMaxBytes: 33554432, ... }
 * ```
 */
export function loadSessionsConfig(
  options: LoadSessionsConfigOptions = {},
): M3LConsoleSessionsConfig {
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

  const artifactInlineMaxBytes = resolveArtifactInlineMaxBytes(accessor);
  const artifactMaxBytes = resolveArtifactMaxBytes(
    accessor,
    artifactInlineMaxBytes,
  );
  const sessionTotalMaxBytes = resolveSessionTotalMaxBytes(
    accessor,
    artifactMaxBytes,
  );
  const openSessionsMax = resolveOpenSessionsMax(accessor);

  return {
    artifactInlineMaxBytes,
    artifactMaxBytes,
    sessionTotalMaxBytes,
    openSessionsMax,
  };
}
