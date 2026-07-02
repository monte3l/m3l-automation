/**
 * `core/config/M3LEnvironmentConfigProvider` — a config provider backed by
 * `process.env` and an optional `.env` file.
 *
 * @packageDocumentation
 */

import * as fs from "fs";

import { parseDotenv } from "../../internal/config/parseDotenv.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/** Constructor options for {@link M3LEnvironmentConfigProvider}. */
interface M3LEnvironmentConfigProviderOptions {
  /** The environment variable map to read from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Path to an optional `.env` file. Its values fill in for keys absent from
   * `env`; a missing file is tolerated (no throw).
   */
  readonly dotenvPath?: string;
}

/** Matches characters replaced with `_` when deriving the SCREAMING_SNAKE_CASE key. */
const KEY_NORMALIZATION_PATTERN = /[.-]/g;

/**
 * Derives the SCREAMING_SNAKE_CASE environment variable name for a dotted or
 * dashed config key, e.g. `"canonical.name"` → `"CANONICAL_NAME"`.
 */
function toEnvKey(key: string): string {
  return key.replace(KEY_NORMALIZATION_PATTERN, "_").toUpperCase();
}

/**
 * Reads and parses an optional `.env` file into a lookup map. A missing file
 * is tolerated (checked via `existsSync` before reading) and yields an empty
 * map; any filesystem error surfaced by the read itself (e.g. EACCES/EPERM)
 * propagates to the caller.
 */
function readDotenvFile(dotenvPath: string): Map<string, string> {
  if (!fs.existsSync(dotenvPath)) {
    return new Map();
  }
  const content = fs.readFileSync(dotenvPath, "utf8");
  return parseDotenv(content);
}

/**
 * A config provider backed by `process.env` (or a caller-supplied env map)
 * plus an optional `.env` file. Lookup tries, in order: the exact key, then
 * the key's SCREAMING_SNAKE_CASE form (`.`/`-` replaced with `_`,
 * uppercased) against `env`, then that same normalized form against the
 * parsed `.env` file. `process.env` (or the supplied `env`) always wins over
 * a `.env` file value for the same key — the file only fills gaps.
 *
 * @example
 * ```ts
 * import { M3LEnvironmentConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LEnvironmentConfigProvider();
 * provider.getRawValue("canonical.name"); // reads process.env.CANONICAL_NAME
 * ```
 */
export class M3LEnvironmentConfigProvider extends M3LConfigProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly dotenv: ReadonlyMap<string, string>;

  /**
   * Creates a new `M3LEnvironmentConfigProvider`.
   *
   * @param options - Optional overrides; `env` defaults to `process.env`,
   *   `dotenvPath` is unset by default (no `.env` file consulted).
   */
  constructor(options?: M3LEnvironmentConfigProviderOptions) {
    super();
    this.env = options?.env ?? process.env;
    this.dotenv =
      options?.dotenvPath !== undefined
        ? readDotenvFile(options.dotenvPath)
        : new Map();
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    const envKey = toEnvKey(key);
    return this.env[key] ?? this.env[envKey] ?? this.dotenv.get(envKey);
  }
}
