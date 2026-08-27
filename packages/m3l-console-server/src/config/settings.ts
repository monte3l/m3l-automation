/**
 * `config/settings` — the shared environment-descriptor plumbing every
 * `config/*` resolver is built on: reading a raw env value, coercing it,
 * storing it (or its default) into an `M3LConfig`, and wrapping a typed
 * accessor read into a uniform {@link M3LConsoleError}. Deliberately free of
 * any particular setting's keys or defaults, so a second resolver module can
 * reuse it without importing the first.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * The single error code every configuration failure raised by this module's
 * helpers carries.
 */
export const CONFIG_INVALID_CODE = "ERR_CONSOLE_CONFIG_INVALID";

/** Source label recorded for a value read from `env`. */
const ENVIRONMENT_SOURCE_LABEL = "environment-variable";

/** Source label recorded for a value that fell back to its documented default. */
const DEFAULT_SOURCE_LABEL = "default";

/**
 * The highest delay this plumbing's callers should accept for any timeout
 * setting, in milliseconds — Node's maximum representable 32-bit signed
 * timer delay (`setTimeout`/`setInterval` store the delay in an `int32`). A
 * value above this is silently coerced to `1`ms with a
 * `TimeoutOverflowWarning`, so an operator asking the server to "drain for a
 * long time" would instead get an immediate kill that drops in-flight work
 * — the exact inverse of the intent. Rejecting an out-of-range value before
 * it ever arms a timer turns that silent inversion into a loud, immediate
 * boot-time configuration error.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * One row of a caller-supplied descriptor table (`env.ts`'s `SETTINGS` is
 * one such table) driving {@link populateConfig}.
 */
export interface SettingDescriptor {
  readonly key: string;
  readonly type:
    | typeof Core.M3LConfigParameterType.STRING
    | typeof Core.M3LConfigParameterType.INT;
  readonly defaultValue: string | number | undefined;
}

/**
 * Reads `key` from `reader` and stores its coerced value into `config`. When
 * `key` is unset in every provider, stores `defaultValue` when one is
 * supplied (labelled `"default"`), or leaves `key` unset in `config`
 * otherwise — the latter is how a required-with-no-default setting (the
 * operator name) is left for the later accessor read to reject.
 *
 * A coercion failure is wrapped as an {@link M3LConsoleError} naming the
 * offending key — never the raw value, which may be a secret — chaining the
 * original {@link Core.M3LConfigCoercionError} as `cause`.
 */
function storeFromEnv(
  reader: Core.M3LConfigReader,
  config: Core.M3LConfig,
  key: string,
  type:
    | typeof Core.M3LConfigParameterType.STRING
    | typeof Core.M3LConfigParameterType.INT,
  defaultValue: string | number | undefined,
): void {
  const raw = reader.getRawValue(key);
  if (raw === undefined) {
    if (defaultValue !== undefined) {
      config.set(key, defaultValue, DEFAULT_SOURCE_LABEL);
    }
    return;
  }
  let value: string | number;
  try {
    value = Core.coerceConfigValue(raw, type);
  } catch (cause) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `failed to read configuration key '${key}'`,
      { cause, context: { key } },
    );
  }
  config.set(key, value, ENVIRONMENT_SOURCE_LABEL);
}

/**
 * Runs `read`, wrapping any thrown value as an {@link M3LConsoleError}
 * naming `key` — covers a bare `Core.M3LError` thrown by
 * {@link Core.M3LConfigAccessor}'s typed readers, which otherwise would not
 * be an `M3LConsoleError` instance.
 */
export function wrapConfigRead<T>(key: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    // A non-`M3LError` escaping `read` is a bug in this module, not invalid
    // operator configuration — relabelling it as a config error would send
    // the operator to fix their environment for a defect in our code.
    if (!(cause instanceof Core.M3LError)) throw cause;
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      `invalid value for configuration key '${key}'`,
      { cause, context: { key } },
    );
  }
}

/**
 * Stores every descriptor's raw-or-default value into `config`, by calling
 * {@link storeFromEnv} once per row of `settings`.
 */
export function populateConfig(
  reader: Core.M3LConfigReader,
  config: Core.M3LConfig,
  settings: readonly SettingDescriptor[],
): void {
  for (const setting of settings) {
    storeFromEnv(
      reader,
      config,
      setting.key,
      setting.type,
      setting.defaultValue,
    );
  }
}
