/**
 * `main` — the console server's composition root.
 *
 * Resolves boot-time configuration and builds the logger the rest of the
 * server writes through. At this slice ({@link createConsoleRuntime}, v1)
 * nothing here binds a socket, listens, or registers a process signal
 * handler — that lands with the HTTP/lifecycle wiring in a later slice.
 * Nothing else in this package imports this module.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleConfig } from "./config/env.js";
import { loadConsoleConfig } from "./config/env.js";
import { createSingleOperatorProvider } from "./auth/identity.js";
import type {
  M3LOperatorProfile,
  M3LOperatorProvider,
} from "./auth/identity.js";
import { createConsoleRequestListener } from "./http/handler.js";
import type { M3LConsoleRequestListener } from "./http/handler.js";
import { createRouter } from "./http/router.js";
import type { M3LRoute, M3LRouter } from "./http/router.js";
import { M3LConsoleError } from "./errors/console-error.js";

/**
 * Constructor options for {@link createConsoleRuntime}.
 *
 * @example
 * ```ts
 * const options: M3LConsoleRuntimeOptions = { env: process.env };
 * ```
 */
export interface M3LConsoleRuntimeOptions {
  /** The environment variable map to resolve configuration from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Log sinks the runtime's logger fans events out to; defaults to a single
   * {@link Core.M3LJsonLoggerHandler} floored at the resolved
   * {@link M3LConsoleConfig.logLevel} — a daemon's output is machine-read,
   * so JSON lines rather than the pretty console handler.
   */
  readonly handlers?: readonly Core.M3LLoggerHandler[];
  /**
   * The route table the runtime's router is built over; defaults to an
   * empty table (routes land in a later slice). Exposed so tests can drive
   * the request listener without a live server.
   *
   * No route may declare `auth: "required"` yet: {@link createConsoleRuntime}
   * builds the request listener with an empty middleware chain, so nothing
   * currently consumes {@link M3LConsoleRuntime.operatorProvider} — an
   * `auth: "required"` route would otherwise be served with no
   * authentication step at all. {@link createConsoleRuntime} rejects such a
   * route with `ERR_CONSOLE_CONFIG_INVALID` at composition time. This
   * restriction lifts once the auth middleware lands and is wired into
   * {@link createConsoleRequestListener}'s `middlewares`.
   */
  readonly routes?: readonly M3LRoute[];
}

/**
 * The console server's resolved runtime: its boot-time configuration and the
 * logger every other layer writes through.
 *
 * @example
 * ```ts
 * function describe(runtime: M3LConsoleRuntime): string {
 *   return `operator: ${runtime.config.operatorName}`;
 * }
 * ```
 */
export interface M3LConsoleRuntime {
  /** The resolved boot-time configuration. */
  readonly config: M3LConsoleConfig;
  /** The logger the rest of the server writes through. */
  readonly logger: Core.M3LLogger;
  /** The single operator profile resolved from configuration at boot. */
  readonly operator: M3LOperatorProfile;
  /** The ADR-0071 auth seam, resolved to {@link operator} for every request. */
  readonly operatorProvider: M3LOperatorProvider;
  /** The compiled router; empty at this slice — routes land in a later one. */
  readonly router: M3LRouter;
  /** The `node:http` request listener built over {@link router}. */
  readonly requestListener: M3LConsoleRequestListener;
  /**
   * The drain signal threaded into every in-flight request context
   * (ADR-0049). Backed by a bare `AbortController` at this slice; a later
   * slice replaces the owner with `M3LDrainController` without changing
   * this field's shape.
   */
  readonly signal: AbortSignal;
}

/**
 * Builds this runtime's default log sinks: a single JSON-lines handler
 * floored at `logLevel`.
 */
function buildDefaultHandlers(
  logLevel: Core.M3LLogLevelFloor,
): readonly Core.M3LLoggerHandler[] {
  return [new Core.M3LJsonLoggerHandler({ minLevel: logLevel })];
}

/**
 * Throws `ERR_CONSOLE_CONFIG_INVALID` when `routes` declares an
 * `auth: "required"` entry. Until the auth middleware lands and is wired
 * into {@link createConsoleRequestListener}'s `middlewares`, nothing
 * consumes {@link M3LOperatorProvider} — registering such a route today
 * would silently serve it with no authentication step at all, which is a
 * composition-time misconfiguration rather than a request-time failure.
 */
function assertNoRequiredAuthRoutes(routes: readonly M3LRoute[]): void {
  const unauthenticated = routes.find((route) => route.auth === "required");
  if (unauthenticated === undefined) return;
  throw new M3LConsoleError(
    "ERR_CONSOLE_CONFIG_INVALID",
    `route '${unauthenticated.method} ${unauthenticated.path}' declares ` +
      `auth: "required", but no auth middleware is wired in yet`,
  );
}

/**
 * Names the config fields this runtime's logger treats as secret, on top of
 * `M3LLogger`'s built-in key-name heuristic. `operatorEmail`/`email` is NOT
 * in the library's built-in `SENSITIVE_KEY_NAMES` set (`core/logging/redact.ts`),
 * so without this port, a later layer doing something as ordinary as
 * `logger.info(msg, { ...runtime.config })` would print the operator's email
 * verbatim — {@link M3LConsoleConfig.operatorEmail}'s "Never logged" TSDoc
 * would then be convention, not a control. Wiring this once here, at the
 * logger's construction, makes the guarantee structural for every later
 * slice that writes through this logger, not just the boot-line log call in
 * {@link logPosture}.
 */
const runtimeSecrets: Core.M3LSecretNamesPort = {
  isSecret: (name) => name === "operatorEmail" || name === "email",
};

/**
 * Emits the one posture line every boot logs: the resolved host, port,
 * operator name, drain timeout, and log level. The operator email is
 * deliberately never included — it is caller PII, and the library does not
 * log caller data by default.
 */
function logPosture(logger: Core.M3LLogger, config: M3LConsoleConfig): void {
  logger.info("console server configuration resolved", {
    host: config.host,
    port: config.port,
    operatorName: config.operatorName,
    drainTimeoutMs: config.drainTimeoutMs,
    logLevel: config.logLevel,
  });
}

/**
 * Resolves the console server's configuration and builds its logger. Does
 * not bind a socket, start listening, or register any process signal
 * handler — this is a pure composition step, side-effect-free at import
 * time.
 *
 * @param options - See {@link M3LConsoleRuntimeOptions}.
 * @returns The resolved {@link M3LConsoleRuntime}.
 * @throws {@link M3LConsoleError} When configuration resolution fails (see
 *   {@link loadConsoleConfig}) — propagated, never swallowed — or when
 *   `options.routes` declares an `auth: "required"` route (see
 *   {@link M3LConsoleRuntimeOptions.routes}).
 *
 * @example
 * ```ts
 * import { createConsoleRuntime } from "./main.js";
 *
 * const runtime = createConsoleRuntime();
 * runtime.logger.info("ready");
 * ```
 */
export function createConsoleRuntime(
  options: M3LConsoleRuntimeOptions = {},
): M3LConsoleRuntime {
  const config = loadConsoleConfig(
    options.env !== undefined ? { env: options.env } : {},
  );
  const handlers = options.handlers ?? buildDefaultHandlers(config.logLevel);
  const logger = new Core.M3LLogger(handlers, {
    minLevel: config.logLevel,
    secrets: runtimeSecrets,
  });

  logPosture(logger, config);

  const operator: M3LOperatorProfile = {
    name: config.operatorName,
    email: config.operatorEmail,
  };
  const operatorProvider = createSingleOperatorProvider(operator);
  const routes = options.routes ?? [];
  assertNoRequiredAuthRoutes(routes);
  const router = createRouter(routes);
  const drainController = new AbortController();
  const requestListener = createConsoleRequestListener({
    router,
    middlewares: [],
    preRouting: [],
    logger,
    signal: drainController.signal,
  });

  return {
    config,
    logger,
    operator,
    operatorProvider,
    router,
    requestListener,
    signal: drainController.signal,
  };
}
