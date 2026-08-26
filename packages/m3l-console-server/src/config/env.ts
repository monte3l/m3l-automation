/**
 * `config/env` — resolves the console server's boot-time configuration from
 * environment variables (ADR-0071: loopback-only binding, a required
 * operator profile).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/** The single error code every configuration failure in this module raises. */
const CODE = "ERR_CONSOLE_CONFIG_INVALID";

/** Source label recorded for a value read from `env`. */
const ENVIRONMENT_SOURCE_LABEL = "environment-variable";

/** Source label recorded for a value that fell back to its documented default. */
const DEFAULT_SOURCE_LABEL = "default";

/** Dotted config key for the bind host. */
const HOST_KEY = "m3l.console.host";
/** Dotted config key for the bind port. */
const PORT_KEY = "m3l.console.port";
/** Dotted config key for the required operator name. */
const OPERATOR_NAME_KEY = "m3l.console.operator.name";
/** Dotted config key for the optional operator email. */
const OPERATOR_EMAIL_KEY = "m3l.console.operator.email";
/** Dotted config key for the graceful-drain timeout. */
const DRAIN_TIMEOUT_KEY = "m3l.console.drain.timeout.ms";
/** Dotted config key for the logger's severity floor. */
const LOG_LEVEL_KEY = "m3l.console.log.level";

/** Default bind host: loopback-only per ADR-0071. */
const DEFAULT_HOST = "127.0.0.1";
/** Default bind port. */
const DEFAULT_PORT = 8787;
/** Default graceful-drain timeout, in milliseconds. */
const DEFAULT_DRAIN_TIMEOUT_MS = 15000;
/** Default logger severity floor. */
const DEFAULT_LOG_LEVEL: Core.M3LLogLevelFloor = "info";

/** The lowest valid TCP port. */
const MIN_PORT = 1;
/** The highest valid TCP port. */
const MAX_PORT = 65535;

/**
 * The highest drain timeout this module accepts, in milliseconds — Node's
 * maximum representable 32-bit signed timer delay (`setTimeout`/`setInterval`
 * store the delay in an `int32`). A value above this is silently coerced to
 * `1`ms with a `TimeoutOverflowWarning`, so an operator asking the server to
 * "drain for a long time" would instead get an immediate kill that drops
 * in-flight work — the exact inverse of the intent. Rejecting it here, before
 * X2c ever arms a timer with it, turns that silent inversion into a loud
 * boot-time configuration error.
 */
const MAX_DRAIN_TIMEOUT_MS = 2_147_483_647;

/** The exact number of dot-separated segments a dotted-decimal IPv4 literal has. */
const IPV4_OCTET_COUNT = 4;
/** The highest valid value of a single IPv4 octet. */
const IPV4_MAX_OCTET = 255;
/** The first octet every address in the `127.0.0.0/8` loopback block carries. */
const LOOPBACK_FIRST_OCTET = "127";

/** Matches a single IPv4 octet's digit-only textual form (1-3 digits). */
const IPV4_OCTET_PATTERN = /^\d{1,3}$/;

/**
 * The longest prefix of a rejected `M3L_CONSOLE_HOST` value echoed back in
 * the failure message (see {@link resolveHost}). Host is the sole
 * deliberate exception to this module's "never echo the raw value" rule —
 * see {@link loadConsoleConfig}'s TSDoc — so this cap exists purely to stop
 * a pathological value (megabytes of text passed as an env var) from
 * flooding a log line; it is not a secrecy control.
 */
const MAX_ECHOED_HOST_LENGTH = 64;
/** Appended to an echoed host value truncated at {@link MAX_ECHOED_HOST_LENGTH}. */
const HOST_TRUNCATION_MARKER = "…(truncated)";

/**
 * Returns `host`, truncated to {@link MAX_ECHOED_HOST_LENGTH} characters with
 * {@link HOST_TRUNCATION_MARKER} appended when it exceeds that length.
 */
function truncateHostForEcho(host: string): string {
  if (host.length <= MAX_ECHOED_HOST_LENGTH) return host;
  return `${host.slice(0, MAX_ECHOED_HOST_LENGTH)}${HOST_TRUNCATION_MARKER}`;
}

/** The closed set of accepted `M3LLogLevelFloor` spellings for `M3L_CONSOLE_LOG_LEVEL`. */
const LOG_LEVELS: readonly Core.M3LLogLevelFloor[] = [
  "debug",
  "info",
  "success",
  "warning",
  "error",
  "fatal",
];

/**
 * Returns `true` when `host` is a dotted-decimal IPv4 literal inside the
 * `127.0.0.0/8` loopback block.
 */
function isIPv4Loopback(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== IPV4_OCTET_COUNT) return false;

  const allValid = octets.every((octet) => {
    if (!IPV4_OCTET_PATTERN.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= IPV4_MAX_OCTET;
  });
  return allValid && octets[0] === LOOPBACK_FIRST_OCTET;
}

/**
 * Strips the bracketed URL-authority wrapping (turns `[::1]` into `::1`)
 * from an IPv6 host literal, when present. Returns `host` unchanged
 * otherwise.
 * Shared by {@link isIPv6Loopback} (which tests the unbracketed form) and
 * {@link resolveHost} (which must *return* the unbracketed form — Node's
 * `net`/`http` binder resolves `[::1]` as a literal, unbindable hostname,
 * not the address `::1`).
 */
function unwrapBracketedHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Returns `true` when `host` is the IPv6 loopback address, in either its
 * compressed (`::1`) or fully expanded (`0:0:0:0:0:0:0:1`) form, optionally
 * wrapped in the bracketed URL-authority form (`[::1]`).
 */
function isIPv6Loopback(host: string): boolean {
  const unbracketed = unwrapBracketedHost(host);
  return unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1";
}

/**
 * Returns `true` when `host` is a loopback-only address or hostname, per
 * ADR-0071: `localhost` (case-insensitively), any IPv4 literal in
 * `127.0.0.0/8`, or the IPv6 loopback address (compressed, expanded, or
 * bracketed).
 *
 * The accepted set is deliberately narrow and fails closed: forms that are
 * genuinely loopback but not recognized here — `127.1` (short IPv4),
 * `2130706433`/`0x7f000001` (integer/hex IPv4), `::ffff:127.0.0.1`
 * (IPv4-mapped IPv6), `localhost.` (trailing-dot FQDN) — are rejected rather
 * than silently accepted. Widening this set is a conscious follow-up, not an
 * oversight; do not "fix" a rejection of one of these forms without adding
 * it here deliberately.
 *
 * @param host - The candidate host string.
 * @returns `true` when `host` resolves exclusively to the local loopback
 *   interface.
 *
 * @example
 * ```ts
 * isLoopbackHost("127.0.0.1"); // true
 * isLoopbackHost("0.0.0.0"); // false
 * ```
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost") return true;
  if (isIPv6Loopback(normalized)) return true;
  return isIPv4Loopback(normalized);
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
      CODE,
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
function wrapConfigRead<T>(key: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    // A non-`M3LError` escaping `read` is a bug in this module, not invalid
    // operator configuration — relabelling it as a config error would send
    // the operator to fix their environment for a defect in our code.
    if (!(cause instanceof Core.M3LError)) throw cause;
    throw new M3LConsoleError(
      CODE,
      `invalid value for configuration key '${key}'`,
      { cause, context: { key } },
    );
  }
}

/** Stores every documented setting's raw-or-default value into `config`. */
function populateConfigFromEnv(
  reader: Core.M3LConfigReader,
  config: Core.M3LConfig,
): void {
  storeFromEnv(
    reader,
    config,
    HOST_KEY,
    Core.M3LConfigParameterType.STRING,
    DEFAULT_HOST,
  );
  storeFromEnv(
    reader,
    config,
    PORT_KEY,
    Core.M3LConfigParameterType.INT,
    DEFAULT_PORT,
  );
  storeFromEnv(
    reader,
    config,
    OPERATOR_NAME_KEY,
    Core.M3LConfigParameterType.STRING,
    undefined,
  );
  storeFromEnv(
    reader,
    config,
    OPERATOR_EMAIL_KEY,
    Core.M3LConfigParameterType.STRING,
    undefined,
  );
  storeFromEnv(
    reader,
    config,
    DRAIN_TIMEOUT_KEY,
    Core.M3LConfigParameterType.INT,
    DEFAULT_DRAIN_TIMEOUT_MS,
  );
  storeFromEnv(
    reader,
    config,
    LOG_LEVEL_KEY,
    Core.M3LConfigParameterType.STRING,
    DEFAULT_LOG_LEVEL,
  );
}

/**
 * Reads the required operator name and rejects a missing, empty, or
 * whitespace-only value — ADR-0071 requires a declared operator profile
 * before the process ever binds a socket. The stored value is returned
 * as-read (never trimmed).
 */
function resolveOperatorName(accessor: Core.M3LConfigAccessor): string {
  const operatorName = wrapConfigRead(OPERATOR_NAME_KEY, () =>
    accessor.requiredString(OPERATOR_NAME_KEY, "start the console server"),
  );
  if (operatorName.trim().length === 0) {
    throw new M3LConsoleError(
      CODE,
      "the console server requires a declared operator profile (ADR-0071); M3L_CONSOLE_OPERATOR_NAME must not be blank",
      { context: { key: OPERATOR_NAME_KEY } },
    );
  }
  return operatorName;
}

/**
 * Reads the resolved host and rejects a non-loopback address (ADR-0071).
 *
 * Deliberate exception to this module's "never echo the raw value" rule
 * (see {@link loadConsoleConfig}): a rejected host IS named in the failure
 * message, truncated at {@link MAX_ECHOED_HOST_LENGTH} — it is the
 * operator's own env var, not a secret, and by far the most useful
 * diagnostic for a rejected bind address.
 *
 * The returned host is normalized: a bracketed IPv6 URL-authority literal
 * (`[::1]`) is unwrapped to the bare address (`::1`) — {@link isLoopbackHost}
 * accepts both forms, but only the unbracketed form is bindable (Node's
 * `net`/`http` binder resolves `[::1]` as a literal, unbindable hostname).
 */
function resolveHost(accessor: Core.M3LConfigAccessor): string {
  const host =
    wrapConfigRead(HOST_KEY, () => accessor.optionalString(HOST_KEY)) ??
    DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new M3LConsoleError(
      CODE,
      `host '${truncateHostForEcho(host)}' is not a loopback address; ADR-0071 requires the console server to bind loopback-only`,
      { context: { key: HOST_KEY } },
    );
  }
  return unwrapBracketedHost(host);
}

/** Reads the resolved port and rejects a value outside `1..65535`. */
function resolvePort(accessor: Core.M3LConfigAccessor): number {
  const port = wrapConfigRead(PORT_KEY, () =>
    accessor.numberWithDefault(PORT_KEY, DEFAULT_PORT),
  );
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new M3LConsoleError(
      CODE,
      `port must be an integer between ${String(MIN_PORT)} and ${String(MAX_PORT)}`,
      { context: { key: PORT_KEY } },
    );
  }
  return port;
}

/**
 * Reads the resolved drain timeout and rejects a non-positive value or one
 * above {@link MAX_DRAIN_TIMEOUT_MS} — see that constant's TSDoc for why an
 * unbounded value is a silent, inverted footgun rather than a merely large
 * one.
 */
function resolveDrainTimeoutMs(accessor: Core.M3LConfigAccessor): number {
  const drainTimeoutMs = wrapConfigRead(DRAIN_TIMEOUT_KEY, () =>
    accessor.numberWithDefault(DRAIN_TIMEOUT_KEY, DEFAULT_DRAIN_TIMEOUT_MS),
  );
  if (
    !Number.isInteger(drainTimeoutMs) ||
    drainTimeoutMs <= 0 ||
    drainTimeoutMs > MAX_DRAIN_TIMEOUT_MS
  ) {
    throw new M3LConsoleError(
      CODE,
      `drain timeout must be a positive integer number of milliseconds, at most ${String(MAX_DRAIN_TIMEOUT_MS)} (Node's maximum 32-bit signed timer delay — above it, the timer silently coerces to 1ms)`,
      { context: { key: DRAIN_TIMEOUT_KEY } },
    );
  }
  return drainTimeoutMs;
}

/**
 * The console server's resolved boot-time configuration.
 *
 * @example
 * ```ts
 * function describe(config: M3LConsoleConfig): string {
 *   return `${config.operatorName} @ ${config.host}:${String(config.port)}`;
 * }
 * ```
 */
export interface M3LConsoleConfig {
  /** The loopback host to bind (ADR-0071). */
  readonly host: string;
  /** The TCP port to bind, in `1..65535`. */
  readonly port: number;
  /** The declared operator's name (ADR-0071 requires a profile at boot). */
  readonly operatorName: string;
  /** The declared operator's email, when supplied. Never logged. */
  readonly operatorEmail: string | undefined;
  /** How long the server waits for in-flight work during a graceful drain. */
  readonly drainTimeoutMs: number;
  /** The logger's minimum severity floor. */
  readonly logLevel: Core.M3LLogLevelFloor;
}

/**
 * Constructor options for {@link loadConsoleConfig}.
 *
 * @example
 * ```ts
 * const options: LoadConsoleConfigOptions = { env: process.env };
 * ```
 */
export interface LoadConsoleConfigOptions {
  /** The environment variable map to resolve settings from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the console server's boot-time {@link M3LConsoleConfig} from
 * environment variables. Every setting is read from `options.env` (or
 * `process.env` by default) — `options.env` is never mutated.
 *
 * A missing, empty, or whitespace-only `M3L_CONSOLE_OPERATOR_NAME` throws:
 * ADR-0071 requires a declared operator profile before the process ever
 * binds a socket. `M3L_CONSOLE_HOST` must resolve to a loopback address (see
 * {@link isLoopbackHost}); `M3L_CONSOLE_PORT` must be an integer in
 * `1..65535`; `M3L_CONSOLE_DRAIN_TIMEOUT_MS` must be a positive integer no
 * greater than {@link MAX_DRAIN_TIMEOUT_MS};
 * `M3L_CONSOLE_LOG_LEVEL` must be one of the six documented
 * {@link Core.M3LLogLevelFloor} spellings. Every failure surfaces as an
 * {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`, naming
 * the offending key and never echoing the raw value (which may be a secret)
 * — with one deliberate, reasoned exception: a rejected `M3L_CONSOLE_HOST`
 * IS named in its failure message (see {@link resolveHost}), truncated at
 * {@link MAX_ECHOED_HOST_LENGTH}, because it is the operator's own env var
 * and the single most useful diagnostic for a rejected bind address.
 *
 * @param options - See {@link LoadConsoleConfigOptions}.
 * @returns The resolved {@link M3LConsoleConfig}.
 * @throws {@link M3LConsoleError} When any setting fails validation.
 *
 * @example
 * ```ts
 * import { loadConsoleConfig } from "./config/env.js";
 *
 * const config = loadConsoleConfig({
 *   env: { M3L_CONSOLE_OPERATOR_NAME: "ada" },
 * });
 * // { host: "127.0.0.1", port: 8787, operatorName: "ada", ... }
 * ```
 */
export function loadConsoleConfig(
  options: LoadConsoleConfigOptions = {},
): M3LConsoleConfig {
  const env = options.env ?? process.env;
  const reader = new Core.M3LConfigReader([
    new Core.M3LEnvironmentConfigProvider({ env }),
  ]);
  const config = new Core.M3LConfig();
  populateConfigFromEnv(reader, config);

  const accessor = new Core.M3LConfigAccessor({ config, code: CODE });

  const operatorName = resolveOperatorName(accessor);
  const operatorEmail = wrapConfigRead(OPERATOR_EMAIL_KEY, () =>
    accessor.optionalNonEmptyString(OPERATOR_EMAIL_KEY),
  );
  const host = resolveHost(accessor);
  const port = resolvePort(accessor);
  const drainTimeoutMs = resolveDrainTimeoutMs(accessor);
  const logLevel = wrapConfigRead(LOG_LEVEL_KEY, () =>
    accessor.oneOf(LOG_LEVEL_KEY, LOG_LEVELS),
  );

  return { host, port, operatorName, operatorEmail, drainTimeoutMs, logLevel };
}
