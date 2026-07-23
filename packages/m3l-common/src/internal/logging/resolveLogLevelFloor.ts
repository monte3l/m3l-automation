/**
 * `internal/logging/resolveLogLevelFloor` — resolves a `M3LLogLevelFloor`
 * from CLI/env, with CLI taking precedence over environment (ADR-0035
 * phase 4b).
 *
 * Not exported from any barrel — `internal/` is private API, freely
 * changeable without a semver bump. `M3LScript`'s constructor is the sole
 * production caller, feeding the result to the default logger's `minLevel`.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import type { M3LLogLevelFloor } from "../../core/logging/M3LLogEventCategory.js";
import { M3LLogEventCategory } from "../../core/logging/M3LLogEventCategory.js";
import { parseArgv } from "../config/parseArgv.js";
import { parseLogLevelFloor } from "./levels.js";

/** The truthy spellings of `M3L_DEBUG` — anything else is treated as "off". */
const TRUTHY_M3L_DEBUG_VALUES: ReadonlySet<string> = new Set(["1", "true"]);

/** Number of leading argv entries (`node`, script path) `process.argv` carries. */
const PROCESS_ARGV_PREFIX_LENGTH = 2;

/**
 * Resolves the CLI tier: an explicit `--log-level` value, else the `--debug`
 * presence switch, else `undefined` when neither is set.
 *
 * A `log-level` key that IS present but carries no string value (a bare
 * trailing `--log-level`, or `--log-level --debug` where the parser reads
 * the next `--`-prefixed token as a separate flag rather than a value) is a
 * malformed explicit request, not an absent one — falling through to
 * `--debug`/env here would silently discard that mistake instead of
 * surfacing it, so it throws instead.
 */
function resolveFromArgv(
  argv: readonly string[],
): M3LLogLevelFloor | undefined {
  const parsedArgv = parseArgv(argv);
  const logLevelFlag = parsedArgv.get("log-level");
  if (logLevelFlag !== undefined) {
    if (typeof logLevelFlag !== "string") {
      throw new M3LError(
        "--log-level: requires a value (e.g. --log-level=warning)",
        { code: "ERR_INVALID_ARGUMENT" },
      );
    }
    return parseLogLevelFloor(logLevelFlag, "--log-level");
  }
  if (parsedArgv.has("debug")) {
    return M3LLogEventCategory.DEBUG;
  }
  return undefined;
}

/**
 * Resolves the env tier: an explicit `M3L_LOG_LEVEL` value, else the
 * `M3L_DEBUG` truthiness toggle, else `undefined` when neither is set.
 */
function resolveFromEnv(env: NodeJS.ProcessEnv): M3LLogLevelFloor | undefined {
  const envLogLevel = env.M3L_LOG_LEVEL;
  if (envLogLevel !== undefined && envLogLevel !== "") {
    return parseLogLevelFloor(envLogLevel, "M3L_LOG_LEVEL");
  }
  const envDebug = env.M3L_DEBUG;
  if (
    envDebug !== undefined &&
    TRUTHY_M3L_DEBUG_VALUES.has(envDebug.trim().toLowerCase())
  ) {
    return M3LLogEventCategory.DEBUG;
  }
  return undefined;
}

/**
 * The inputs `resolveLogLevelFloor` reads from — injectable so callers (and
 * tests) never depend on the real process globals directly.
 */
export interface ResolveLogLevelFloorOptions {
  /** Raw CLI arguments, defaulting to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /** The environment map to read, defaulting to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the log-level floor a default {@link M3LLogger} should be
 * constructed with, following a strict precedence chain: an explicit CLI
 * `--log-level` value beats the CLI `--debug` presence switch, which beats
 * the env `M3L_LOG_LEVEL` value, which beats the env `M3L_DEBUG` boolean
 * toggle; when none of the four are set, there is no floor.
 *
 * CLI and env are checked as two whole tiers (not interleaved) so a script
 * invoked with neither a CLI flag nor a relevant env var behaves identically
 * to today — this only ever narrows verbosity when a caller opts in.
 *
 * @param options - Injectable `argv`/`env`; both default to the real process
 *   globals so production call sites can call this with no arguments.
 * @returns The resolved floor, or `undefined` when nothing set one.
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when an explicit
 *   `--log-level` or `M3L_LOG_LEVEL` value is set but out of vocabulary — see
 *   {@link parseLogLevelFloor}. The `M3L_DEBUG`/`--debug` boolean toggles
 *   never throw; they are presence/truthiness switches, not vocabulary values.
 * @example
 * ```ts
 * import { resolveLogLevelFloor } from "../internal/logging/resolveLogLevelFloor.js";
 *
 * const floor = resolveLogLevelFloor({ argv: ["--log-level=warning"], env: {} });
 * // floor === "warning"
 * ```
 */
export function resolveLogLevelFloor(
  options?: ResolveLogLevelFloorOptions,
): M3LLogLevelFloor | undefined {
  const argv = options?.argv ?? process.argv.slice(PROCESS_ARGV_PREFIX_LENGTH);
  const env = options?.env ?? process.env;

  return resolveFromArgv(argv) ?? resolveFromEnv(env);
}
