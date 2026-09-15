/**
 * `config/settings` — resolves this package's boot configuration from
 * environment variables (ADR-0062). Deliberately one small module rather
 * than the `{settings,env}.ts` descriptor-table pair
 * `packages/m3l-console-server/src/config` uses: three keys don't justify a
 * `SettingDescriptor`/`populateConfig` layer, and every value here is read
 * exactly once at process start, never re-read or hot-reloaded.
 *
 * @packageDocumentation
 */

import { dirname, isAbsolute, join } from "node:path";

import { Core } from "@monte3l/m3l-common";

import { M3LMcpError } from "../errors/mcp-error.js";

/**
 * Node's `setTimeout`/`setInterval` silently truncate any delay above this
 * 32-bit signed-integer bound to 1ms (see Node's internal `timers.enroll`)
 * instead of throwing. A caller who armed `M3L_MCP_CLI_TIMEOUT_MS` past this
 * value would therefore not get "wait a very long time" but "kill the CLI
 * child almost immediately after spawning it" — the opposite of what the
 * setting asks for, and silent about it. Rejecting the value here, at
 * config-load time, turns that into a loud startup failure instead of a
 * subprocess that mysteriously never finishes; deferring the check to
 * whichever call eventually arms the timer would let the bad value travel
 * arbitrarily far from its source before anything notices.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Default for {@link M3LMcpSettings.cliTimeoutMs} when unset. */
const DEFAULT_CLI_TIMEOUT_MS = 30_000;

/** Default for {@link M3LMcpSettings.maxOutputBytes} when unset. */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * Upper bound for {@link M3LMcpSettings.maxOutputBytes}. This cap is the
 * only thing bounding the text `src/cli/envelopes.ts`'s `parseJsonText`
 * (V10c2) hands to `JSON.parse` after a CLI invocation completes, so an
 * unbounded `M3L_MCP_MAX_OUTPUT_BYTES` override would turn the setting meant
 * to bound the spawned CLI's output into one with no effective bound at all.
 * 64 MiB is far beyond any plausible `m3l doctor --json` payload (a few KB
 * per check) while leaving generous headroom for the larger envelopes later
 * slices add on top of the same cap.
 */
const MAX_OUTPUT_BYTES_CEILING = 67_108_864;

/**
 * Fixed, non-leaking message used when constructing a real `Core.M3LPaths`
 * fails. `Core.M3LPaths`'s constructor does two things that can each leak a
 * raw value into a thrown message: it reads several `M3L_*_DIR` environment
 * variables directly off the real `process.env` (never `options.env` — see
 * {@link LoadM3LMcpSettingsOptions.env}) and throws
 * `Core.M3LPathResolutionError` embedding the offending non-absolute value
 * verbatim, *and* it calls `Core.M3LExecutionEnvironment.detect()`, which
 * reads a **seventh** variable (`M3L_DEPLOYMENT_MODE`) and throws a
 * *different* class, `Core.M3LEnvironmentDetectionError`, embedding either
 * the raw unrecognised mode value or an absolute host directory path
 * (surfaced on an EACCES/EPERM failure during its workspace-marker
 * walk-up). Any of these values may be a secret (Security rule 2: "a config
 * coercion failure names the key, never the value"). This fixed string is
 * deliberately the entire thrown message, and the original error is
 * deliberately NOT chained as `cause` here — a departure from this module's
 * usual convention (see {@link resolveCliEntrypoint}'s own `cause`-chaining
 * branch, and {@link resolveBoundedIntSetting}) made necessary because
 * `Core.M3LError#toJSON` fully serializes a chained cause's `message`; were
 * it chained, the leak this constant exists to close would simply
 * reappear at `error.toJSON().cause.message`.
 */
const PATHS_CONSTRUCTION_FAILURE_MESSAGE =
  "failed to resolve project paths: constructing Core.M3LPaths failed " +
  "(a M3L_BASE_DIR/M3L_DATA_DIR/M3L_CONFIG_DIR/M3L_INPUT_DIR/" +
  "M3L_OUTPUT_DIR/M3L_CACHE_DIR override may be non-absolute, " +
  "M3L_DEPLOYMENT_MODE may be unrecognised, or environment detection may " +
  "have failed to read a directory during its workspace-marker walk-up); " +
  "set M3L_MCP_CLI_ENTRYPOINT explicitly to bypass path resolution entirely";

/**
 * This package's resolved boot configuration: everything the CLI-subprocess
 * layer (`src/cli/process.ts`) needs to spawn and bound the `m3l` CLI.
 *
 * @example
 * ```ts
 * import type { M3LMcpSettings } from "./settings.js";
 *
 * function describe(settings: M3LMcpSettings): string {
 *   return `${settings.cliEntrypoint} (timeout ${settings.cliTimeoutMs}ms)`;
 * }
 * ```
 */
export interface M3LMcpSettings {
  /** Absolute path to the Node executable used to spawn the `m3l` CLI. */
  readonly nodeExecPath: string;
  /** Absolute path to the `m3l` CLI's entrypoint script. */
  readonly cliEntrypoint: string;
  /**
   * Working directory for the spawned CLI process. Always
   * `dirname(cliEntrypoint)`, never this process's own `cwd` — see
   * {@link loadM3LMcpSettings} for why.
   */
  readonly cwd: string;
  /** Milliseconds before a spawned CLI invocation is killed as timed out. */
  readonly cliTimeoutMs: number;
  /** Per-stream byte cap before a spawned CLI invocation is truncated. */
  readonly maxOutputBytes: number;
}

/**
 * Options accepted by {@link loadM3LMcpSettings}.
 *
 * `env` is an injectable seam, but only for this module's own three keys
 * (`M3L_MCP_CLI_ENTRYPOINT`/`M3L_MCP_CLI_TIMEOUT_MS`/
 * `M3L_MCP_MAX_OUTPUT_BYTES`) — it is **not** a full environment seam. When
 * `paths` is omitted *and* `M3L_MCP_CLI_ENTRYPOINT` is unset, a real
 * `Core.M3LPaths` is constructed to derive the default entrypoint, and its
 * construction reads several `M3L_*_DIR` variables *and* `M3L_DEPLOYMENT_MODE`
 * (seven keys total — see {@link PATHS_CONSTRUCTION_FAILURE_MESSAGE})
 * directly off the *real* `process.env` — never `options.env`. A test that
 * wants to exercise that specific branch must stub the real environment
 * (e.g. `vi.stubEnv`, restored in `afterEach`), not just pass `env`; every
 * other code path in this module reads only `options.env`.
 *
 * @example
 * ```ts
 * import type { LoadM3LMcpSettingsOptions } from "./settings.js";
 *
 * const options: LoadM3LMcpSettingsOptions = { env: {} };
 * ```
 */
export interface LoadM3LMcpSettingsOptions {
  /** Source environment. Defaults to `process.env`. Never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Project-root resolver. Narrowed to just `getProjectRoot` so a test can
   * supply a plain object literal instead of standing up the real
   * path-resolution machinery. When omitted, a real `Core.M3LPaths` is
   * constructed **lazily** — only when `M3L_MCP_CLI_ENTRYPOINT` is unset and
   * the default entrypoint must be derived from the resolved project root.
   * An explicit `M3L_MCP_CLI_ENTRYPOINT` means a real `Core.M3LPaths` is
   * never constructed at all, so its constructor never runs and cannot
   * throw.
   */
  readonly paths?: Pick<Core.M3LPaths, "getProjectRoot">;
  /** Node executable path. Defaults to `process.execPath`. */
  readonly nodeExecPath?: string;
}

/**
 * Validates a path value before it can reach `cwd = dirname(...)` or,
 * downstream, `child_process.spawn`'s argv/`cwd`. A relative value would
 * silently resolve `cwd` to `"."` — exactly the failure
 * `cwd = dirname(cliEntrypoint)` exists to prevent, since the `m3l` CLI's
 * own project/data-root resolution would then depend on wherever this
 * process happens to have been started from. An embedded NUL byte (`"\0"`)
 * makes Node's `child_process.spawn` throw synchronously. Every rejection
 * names `label` and the violated rule, never the value itself (Security
 * rule 2).
 *
 * Shared by {@link resolveCliEntrypoint} for both the explicit
 * `M3L_MCP_CLI_ENTRYPOINT` override and — as defence in depth, not a fix for
 * a reachable bug; see the call site — the *derived* default built from
 * `paths.getProjectRoot()`, and by {@link loadM3LMcpSettings} for
 * `options.nodeExecPath`, so the invariant is total over every value that
 * ends up in the spawn's argv/`cwd` rather than only the one path an
 * operator can set directly.
 */
function validatePathValue(label: string, value: string): string {
  if (value === "") {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `configuration key '${label}' must not be empty`,
      { context: { key: label, rule: "non-empty" } },
    );
  }
  if (value.includes("\0")) {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `configuration key '${label}' must not contain a NUL byte`,
      { context: { key: label, rule: "no-nul-byte" } },
    );
  }
  if (!isAbsolute(value)) {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `configuration key '${label}' must be an absolute path`,
      { context: { key: label, rule: "absolute-path" } },
    );
  }
  return value;
}

/**
 * Constructs a real `Core.M3LPaths`, containing the leak its constructor can
 * produce. Contained by *call site*, not by error class: `new Core.M3LPaths()`
 * can throw `Core.M3LPathResolutionError` (a non-absolute `M3L_*_DIR`
 * override) or `Core.M3LEnvironmentDetectionError` (an unrecognised
 * `M3L_DEPLOYMENT_MODE`, or an unreadable directory during environment
 * detection's workspace-marker walk-up) — two different classes, both capable
 * of embedding sensitive raw data in their message. Matching on either class
 * by name would leave the door open for a future library error class to reopen
 * this leak silently, so every failure out of this constructor call, whatever
 * its class, collapses to the same fixed, non-leaking message. See
 * {@link PATHS_CONSTRUCTION_FAILURE_MESSAGE} for why the original error is
 * deliberately not chained as `cause`.
 */
function createRealPaths(): Core.M3LPaths {
  try {
    return new Core.M3LPaths();
  } catch {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      PATHS_CONSTRUCTION_FAILURE_MESSAGE,
      { context: { hint: "M3L_MCP_CLI_ENTRYPOINT" } },
    );
  }
}

/**
 * Resolves {@link M3LMcpSettings.cliEntrypoint} and, implicitly, whether the
 * monorepo's project-root resolution is even consulted.
 *
 * An explicit `M3L_MCP_CLI_ENTRYPOINT` short-circuits path resolution
 * entirely — a real `Core.M3LPaths` is never constructed and
 * `paths.getProjectRoot()` is never called in that case, which matters
 * outside the monorepo (a standalone install of this package has no project
 * root to resolve) and also means a poisoned `M3L_*_DIR` variable in the
 * real environment cannot surface at all when the entrypoint is supplied
 * explicitly.
 */
function resolveCliEntrypoint(
  env: Readonly<Record<string, string | undefined>>,
  suppliedPaths: Pick<Core.M3LPaths, "getProjectRoot"> | undefined,
): string {
  const explicit = env["M3L_MCP_CLI_ENTRYPOINT"];
  if (explicit !== undefined) {
    return validatePathValue("M3L_MCP_CLI_ENTRYPOINT", explicit);
  }

  // Constructed lazily: only reached when no explicit entrypoint was given,
  // so `Core.M3LPaths`'s constructor (which reads the real process.env for
  // its own M3L_*_DIR overrides) never runs otherwise.
  const paths = suppliedPaths ?? createRealPaths();

  let projectRoot: string;
  try {
    projectRoot = paths.getProjectRoot();
  } catch (cause) {
    // A standalone (non-monorepo) install has no project root to derive the
    // default entrypoint from — that is operator misconfiguration (the key
    // must be set explicitly) and gets a typed, actionable error. Any other
    // failure out of getProjectRoot() is a bug in the resolver itself, not
    // something this loader knows how to explain, so it propagates as-is.
    // (getProjectRoot()'s own M3LPathResolutionError message is a fixed
    // string with no interpolated value, unlike the one createRealPaths()
    // guards against, so chaining it as `cause` here does not leak anything.)
    if (cause instanceof Core.M3LPathResolutionError) {
      throw new M3LMcpError(
        "ERR_MCP_CONFIG",
        "M3L_MCP_CLI_ENTRYPOINT must be set explicitly outside the monorepo",
        { cause, context: { key: "M3L_MCP_CLI_ENTRYPOINT" } },
      );
    }
    throw cause;
  }
  // Defence in depth, not a fix for a reachable bug: the real `Core.M3LPaths`
  // always returns an absolute, non-empty, NUL-free `projectRoot` today, so
  // this branch cannot currently throw through that path. But
  // `options.paths` is a public seam typed as `Pick<Core.M3LPaths,
  // "getProjectRoot">` — a caller-injected stub can return anything — and
  // both this join()'d result and `options.nodeExecPath` (validated in
  // {@link loadM3LMcpSettings}) become the future spawn's argv/`cwd`, so the
  // invariant validated on the *explicit* `M3L_MCP_CLI_ENTRYPOINT` above must
  // hold for the *derived* value too, not only for operator-supplied input.
  return validatePathValue(
    "cliEntrypoint (derived from project root)",
    join(projectRoot, "packages", "m3l-cli", "bin", "m3l.mjs"),
  );
}

/**
 * Resolves one positive-integer environment setting: reads `key` from `env`,
 * falls back to `defaultValue` when unset, coerces via
 * `Core.coerceConfigValue`, and enforces `> 0` plus, when given, `<= maxBound`.
 *
 * A coercion failure names only `key` — never the raw string `env[key]` held,
 * which may be a secret. A range violation may name `key` and `maxBound` (a
 * fixed bound is not caller data) but likewise never the offending value.
 */
function resolveBoundedIntSetting(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  defaultValue: number,
  maxBound?: number,
): number {
  const raw = env[key];
  if (raw === undefined) return defaultValue;

  let coerced: number;
  try {
    coerced = Core.coerceConfigValue(raw, Core.M3LConfigParameterType.INT);
  } catch (cause) {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `failed to read configuration key '${key}'`,
      { cause, context: { key } },
    );
  }

  if (coerced <= 0) {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `configuration key '${key}' must be a positive integer`,
      { context: { key } },
    );
  }
  if (maxBound !== undefined && coerced > maxBound) {
    throw new M3LMcpError(
      "ERR_MCP_CONFIG",
      `configuration key '${key}' must not exceed ${maxBound}`,
      { context: { key, maxBound } },
    );
  }
  return coerced;
}

/**
 * Loads this package's boot configuration from `options.env` (default
 * `process.env`), `options.paths` (default: a real `Core.M3LPaths`,
 * constructed lazily and only when `M3L_MCP_CLI_ENTRYPOINT` is unset — see
 * {@link LoadM3LMcpSettingsOptions.paths}), and `options.nodeExecPath`
 * (default `process.execPath`). Synchronous — nothing here does I/O beyond
 * reading already-in-memory environment variables.
 *
 * `cwd` is always `dirname(cliEntrypoint)`, never this process's own
 * `process.cwd()`. The `m3l` CLI resolves its own project and data roots
 * relative to its own entrypoint script's location (see
 * `Core.M3LExecutionEnvironment`'s monorepo-marker search), not relative to
 * whatever directory happened to invoke it — so the entrypoint's own
 * directory is the only spawn `cwd` that reliably reproduces the CLI's
 * normal resolution, regardless of where this MCP server process itself
 * was started from.
 *
 * @param options - See {@link LoadM3LMcpSettingsOptions}. `options.env` is
 *   read only, never mutated.
 * @returns The resolved {@link M3LMcpSettings}.
 * @throws {@link M3LMcpError} (`ERR_MCP_CONFIG`) When an int-typed key fails
 *   to coerce, fails its range check, `M3L_MCP_CLI_ENTRYPOINT` (explicit or
 *   derived), or `options.nodeExecPath`, is empty, relative, or contains a
 *   NUL byte, `M3L_MCP_CLI_ENTRYPOINT` is unset outside the monorepo, or
 *   (when `options.paths` is not injected and `M3L_MCP_CLI_ENTRYPOINT` is
 *   unset) constructing the real `Core.M3LPaths` fails for any reason — see
 *   {@link PATHS_CONSTRUCTION_FAILURE_MESSAGE}.
 *
 * @example
 * ```ts
 * import { loadM3LMcpSettings } from "./settings.js";
 *
 * const settings = loadM3LMcpSettings();
 * ```
 */
export function loadM3LMcpSettings(
  options: LoadM3LMcpSettingsOptions = {},
): M3LMcpSettings {
  const env = options.env ?? process.env;
  // Defence in depth (see resolveCliEntrypoint's own derived-default
  // validation for the parallel case): `options.nodeExecPath` becomes the
  // future spawn's executable, and `process.execPath` is always absolute, so
  // this cannot currently reject a real caller — it exists so an injected
  // override cannot silently produce a relative/NUL-bearing spawn target.
  const nodeExecPath = validatePathValue(
    "nodeExecPath",
    options.nodeExecPath ?? process.execPath,
  );

  // `options.paths` is passed through unresolved (possibly `undefined`) so
  // that a real `Core.M3LPaths` is constructed lazily, inside
  // resolveCliEntrypoint, only when actually needed — never when
  // M3L_MCP_CLI_ENTRYPOINT is set explicitly.
  const cliEntrypoint = resolveCliEntrypoint(env, options.paths);
  const cwd = dirname(cliEntrypoint);
  const cliTimeoutMs = resolveBoundedIntSetting(
    env,
    "M3L_MCP_CLI_TIMEOUT_MS",
    DEFAULT_CLI_TIMEOUT_MS,
    MAX_TIMER_DELAY_MS,
  );
  const maxOutputBytes = resolveBoundedIntSetting(
    env,
    "M3L_MCP_MAX_OUTPUT_BYTES",
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES_CEILING,
  );

  return { nodeExecPath, cliEntrypoint, cwd, cliTimeoutMs, maxOutputBytes };
}
