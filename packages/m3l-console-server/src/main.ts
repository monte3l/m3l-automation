/**
 * `main` — the console server's composition root and process entry point.
 *
 * {@link createConsoleRuntime} is a pure composition step: it resolves
 * configuration, builds the logger, and wires the router/middleware chains,
 * without ever binding a socket or touching a process signal.
 * {@link startConsole} is the actual lifecycle entry point layered on top:
 * it binds the listener, registers shutdown signal handlers, and drives the
 * ADR-0049 drain on the way down. Nothing else in this package imports this
 * module.
 *
 * @packageDocumentation
 */

import type { Server } from "node:http";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleConfig } from "./config/env.js";
import { loadConsoleConfig } from "./config/env.js";
import type { M3LConsoleRunsConfig } from "./config/runs.js";
import { tryLoadRunsConfig } from "./config/runs.js";
import { chainSecondaryFailure } from "./errors/chain-secondary-failure.js";
import { createSingleOperatorProvider } from "./auth/identity.js";
import type {
  M3LOperatorProfile,
  M3LOperatorProvider,
} from "./auth/identity.js";
import { createConsoleRequestListener } from "./http/handler.js";
import type { M3LConsoleRequestListener } from "./http/handler.js";
import { createRouter } from "./http/router.js";
import type { M3LRoute, M3LRouter } from "./http/router.js";
import { createHealthRoutes } from "./http/routes/health.js";
import { createOriginGuard } from "./http/origin-guard.js";
import { createDrainMiddleware } from "./http/drain-middleware.js";
import { createAuthMiddleware } from "./http/auth-middleware.js";
import { createDrainController } from "./lifecycle/drain.js";
import type { M3LDrainController, M3LDrainOutcome } from "./lifecycle/drain.js";
import { startConsoleServer } from "./lifecycle/http-server.js";
import type { M3LListeningServer } from "./lifecycle/http-server.js";
import {
  createShutdown,
  registerConsoleShutdownSignals,
} from "./lifecycle/shutdown.js";
import { createRunSubsystem } from "./runs/composition.js";
import type { M3LRunSubsystem } from "./runs/composition.js";
import type { M3LRunRegistry } from "./runs/registry.js";
import { openConsoleStore } from "./store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
  M3LConsoleStoreLifecycle,
  OpenConsoleStoreOptions,
} from "./store/store.js";

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
   * Additional routes registered alongside the built-in health routes (see
   * {@link createConsoleRuntime}). Defaults to an empty table. Exposed so
   * tests can drive the request listener without a live server.
   */
  readonly routes?: readonly M3LRoute[];
  /** Pre-resolved config; when supplied, `loadConsoleConfig` is skipped (see {@link startConsole}). */
  readonly config?: M3LConsoleConfig;
  /** The opened console store (ADR-0069), when the caller already has one. */
  readonly store?: M3LConsoleStoreHandle;
  /** Pre-resolved X4 run-governor config; skips `loadRunsConfig` (mirrors {@link config}). */
  readonly runsConfig?: M3LConsoleRunsConfig;
  /** The run-persistence port the X4 run subsystem builds from; see {@link createConsoleRuntime}. */
  readonly runs?: M3LRunRegistry;
}

/**
 * The console server's resolved runtime: its boot-time configuration, the
 * logger every other layer writes through, and the composed request
 * listener.
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
  /**
   * The compiled router built from `options.routes` verbatim — reflects
   * exactly what the caller registered, for introspection. The built-in
   * health routes are dispatched by {@link requestListener} but are
   * deliberately NOT reflected here (see `buildDispatchRouter`'s TSDoc).
   */
  readonly router: M3LRouter;
  /** The `node:http` request listener; dispatches through the built-in health routes plus {@link router}'s routes. */
  readonly requestListener: M3LConsoleRequestListener;
  /**
   * The ADR-0049 drain controller every in-flight request is tracked
   * against. Exposed so a caller (or `/ready`) can read its `state` without
   * threading a second reference through.
   */
  readonly drain: M3LDrainController;
  /**
   * The drain signal threaded into every in-flight request context
   * (ADR-0049). Equivalent to `drain.signal`.
   */
  readonly signal: AbortSignal;
  /**
   * The opened console store (ADR-0069), when `options.store` supplied one
   * — narrowed to its {@link M3LConsoleStoreLifecycle} view: this composition
   * root has no business issuing queries itself, so the full
   * {@link M3LConsoleStoreHandle} (which carries the SQL query surface) never
   * republishes past this field.
   */
  readonly store?: M3LConsoleStoreLifecycle;
  /**
   * The wired X4 run subsystem, present only when a runs config resolved AND
   * {@link M3LConsoleRuntimeOptions.runs} was supplied. Satisfies
   * `lifecycle/shutdown.ts`'s `M3LShutdownDrainable` structurally, so its
   * `drain()` runs alongside the HTTP drain with no `runs/` import there.
   */
  readonly runs?: M3LRunSubsystem;
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
 * Names the config/context fields this runtime's logger treats as secret, on
 * top of `M3LLogger`'s built-in key-name heuristic. `operatorEmail`/`email`
 * is NOT in the library's built-in `SENSITIVE_KEY_NAMES` set
 * (`core/logging/redact.ts`), so without this port, a later layer doing
 * something as ordinary as `logger.info(msg, { ...runtime.config })` would
 * print the operator's email verbatim — {@link M3LConsoleConfig.operatorEmail}'s
 * "Never logged" TSDoc would then be convention, not a control. Wiring this
 * once here, at the logger's construction, makes the guarantee structural
 * for every later slice that writes through this logger, not just the
 * boot-line log call in {@link logPosture}.
 *
 * `headers`/`cookie` are the same structural fix applied to a second leak:
 * `M3LRequestContext` (`http/context.ts`) now carries the inbound request
 * headers, and MEASURED behavior of `M3LLogger`'s redaction is that it
 * recurses and DOES redact a nested `authorization` header (it is in the
 * library's `SENSITIVE_KEY_NAMES`), but `cookie` is NOT in that set and
 * would leak an operator's session cookie verbatim. Naming `"headers"`
 * redacts the whole object regardless of which keys it happens to contain;
 * naming `"cookie"` also catches a cookie value hoisted to a top-level field
 * by some future call site. The library's key-name heuristic cannot know a
 * consumer's vocabulary — which is exactly what `M3LSecretNamesPort` exists
 * for.
 *
 * `sql`/`parameters`/`bindings`/`expandedSQL` are the same structural fix
 * for the ADR-0069 store: a repository logging a failed query's context as
 * ordinary as `logger.error(msg, { sql, parameters })` must never print the
 * raw SQL, its bound parameters/bindings, or its interpolated `expandedSQL`
 * form — the sqlite driver's own TSDoc documents `expandedSQL` as
 * interpolating bound values, so it is never loggable. `query`/`statement`
 * (near-synonyms for `sql`) and `params`/`values`/`args` (near-synonyms for
 * `parameters`/`bindings`) round out the same store vocabulary: a security
 * probe measured all five leaking verbatim through the real logger, and
 * `params` in particular is an entirely ordinary shorthand at a real call
 * site, not an exotic one this port can afford to skip.
 */
const RUNTIME_SECRET_NAMES: ReadonlySet<string> = new Set([
  "operatorEmail",
  "email",
  "headers",
  "cookie",
  "sql",
  "parameters",
  "bindings",
  "expandedSQL",
  "query",
  "statement",
  "params",
  "values",
  "args",
]);

const runtimeSecrets: Core.M3LSecretNamesPort = {
  isSecret: (name) => RUNTIME_SECRET_NAMES.has(name),
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
 * Builds the router the request listener actually dispatches through: the
 * built-in health routes (see {@link createHealthRoutes}) ahead of
 * `routes`, so a caller can never accidentally shadow `/health`/`/ready`.
 * Deliberately a SEPARATE router instance from the one exposed as
 * {@link M3LConsoleRuntime.router} — that field reflects `options.routes`
 * verbatim, so a caller introspecting it sees exactly what it registered,
 * not an implementation detail of how liveness/readiness are served.
 *
 * `store` is threaded through to {@link createHealthRoutes} so `/ready`
 * actually reflects the real store's health in every deployment — this call
 * site is also the compiler-checked proof that
 * {@link M3LConsoleStoreLifecycle} (and the full {@link M3LConsoleStoreHandle}
 * that satisfies it) structurally conforms to `health.ts`'s
 * `M3LReadinessProbe`, without creating an `http -> store` ESLint zone edge
 * (that module deliberately declares its own narrower shape rather than
 * importing this one).
 */
function buildDispatchRouter(
  drain: M3LDrainController,
  routes: readonly M3LRoute[],
  store: M3LConsoleStoreLifecycle | undefined,
): M3LRouter {
  const healthRoutes = createHealthRoutes({
    drain,
    startedAt: Date.now(),
    ...(store !== undefined && { store }),
  });
  return createRouter([...healthRoutes, ...routes]);
}

/**
 * Resolves the console server's configuration, builds its logger, and
 * composes its router/middleware chains. Does not bind a socket, start
 * listening, or register any process signal handler — this is a pure
 * composition step, side-effect-free at import time (see {@link startConsole}
 * for the lifecycle entry point that does those things).
 *
 * @param options - See {@link M3LConsoleRuntimeOptions}.
 * @returns The resolved {@link M3LConsoleRuntime}.
 * @throws {@link M3LConsoleError} When configuration resolution fails (see
 *   {@link loadConsoleConfig}) — propagated, never swallowed.
 *
 * @example
 * ```ts
 * import { createConsoleRuntime } from "./main.js";
 *
 * const runtime = createConsoleRuntime();
 * runtime.logger.info("ready");
 * ```
 */
/** Resolves the boot config: `options.config` verbatim if supplied, else `loadConsoleConfig`. */
function resolveConfig(options: M3LConsoleRuntimeOptions): M3LConsoleConfig {
  return (
    options.config ??
    loadConsoleConfig(options.env !== undefined ? { env: options.env } : {})
  );
}

/** The env var naming the X4 scripts directory, named in the disabled-orchestration posture line. */
const RUNS_SCRIPTS_DIR_ENV = "M3L_CONSOLE_RUNS_SCRIPTS_DIR";

/**
 * Builds the X4 run subsystem when `options.runs` was supplied AND a runs
 * config resolved (`options.runsConfig` verbatim, else
 * `tryLoadRunsConfig`); else `undefined`, logging one `warning` posture
 * line. Checks `options.runs` FIRST — nothing to wire a resolved config to
 * without a registry, and skipping config resolution (and the warning)
 * entirely when no registry was ever supplied is what keeps every existing
 * caller that never mentions `runs` silent; the warning only fires once a
 * caller has actually opted in by supplying one.
 */
function buildRunSubsystem(
  options: M3LConsoleRuntimeOptions,
  logger: Core.M3LLogger,
): M3LRunSubsystem | undefined {
  if (options.runs === undefined) return undefined;
  const config: M3LConsoleRunsConfig | undefined =
    options.runsConfig ?? tryLoadRunsConfig(options.env ?? process.env);
  if (config === undefined) {
    logger.warning("run orchestration disabled: scripts directory unset", {
      variable: RUNS_SCRIPTS_DIR_ENV,
    });
    return undefined;
  }
  return createRunSubsystem({ config, logger, registry: options.runs });
}

export function createConsoleRuntime(
  options: M3LConsoleRuntimeOptions = {},
): M3LConsoleRuntime {
  const config = resolveConfig(options);
  const handlers = options.handlers ?? buildDefaultHandlers(config.logLevel);
  const logger = new Core.M3LLogger(handlers, {
    minLevel: config.logLevel,
    secrets: runtimeSecrets,
  });

  logPosture(logger, config);
  const runs = buildRunSubsystem(options, logger);

  const operator: M3LOperatorProfile = {
    name: config.operatorName,
    email: config.operatorEmail,
  };
  const operatorProvider = createSingleOperatorProvider(operator);
  const drain = createDrainController({ timeoutMs: config.drainTimeoutMs });
  const routes = options.routes ?? [];
  const router = createRouter(routes);
  // Drain refusal is per-route policy, like auth, so it belongs in
  // `middlewares` (which only wraps a matched route's handler, once
  // `ctx.accessMode` is populated) — never `preRouting` (which runs before
  // routing has resolved, so it would refuse `auth: "exempt"` health routes
  // right alongside real work; see `createDrainMiddleware`'s TSDoc for the
  // full rationale). It runs ahead of auth so a drain refusal never pays the
  // cost of resolving an operator first.
  const requestListener = createConsoleRequestListener({
    router: buildDispatchRouter(drain, routes, options.store),
    middlewares: [
      createDrainMiddleware(drain),
      createAuthMiddleware(operatorProvider),
    ],
    preRouting: [createOriginGuard()],
    logger,
    signal: drain.signal,
    maxBodyBytes: config.maxBodyBytes,
  });

  return {
    config,
    logger,
    operator,
    operatorProvider,
    router,
    requestListener,
    drain,
    signal: drain.signal,
    ...(options.store !== undefined && { store: options.store }),
    ...(runs !== undefined && { runs }),
  };
}

// =============================================================================
// startConsole — the lifecycle entry point
// =============================================================================

/** The default signal trap set, mirroring `internal/script/signalHandlers`'s `HANDLED_SIGNALS`. */
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGTERM",
  "SIGINT",
  "SIGQUIT",
];

/**
 * Constructor options for {@link startConsole}.
 *
 * @example
 * ```ts
 * const options: StartConsoleOptions = { env: process.env };
 * ```
 */
export interface StartConsoleOptions extends M3LConsoleRuntimeOptions {
  /** The process signals that trigger a graceful shutdown. Defaults to `["SIGTERM", "SIGINT", "SIGQUIT"]`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Test seam: builds the underlying `Server` instead of `node:http`'s `createServer`. */
  readonly createServer?: () => Server;
  /**
   * Test seam: opens the console store instead of `openConsoleStore`.
   * Widened to `& M3LConsoleStore` so `startConsole` can reach `store.runs`.
   */
  readonly openStore?: (
    options: OpenConsoleStoreOptions,
  ) => M3LConsoleStoreHandle & M3LConsoleStore;
}

/**
 * A running console server: its runtime, the verified listening server, and
 * the two distinct lifecycle handles described below.
 *
 * @example
 * ```ts
 * function describe(running: M3LRunningConsole): string {
 *   return `listening on ${running.server.host}:${String(running.server.port)}`;
 * }
 * ```
 */
export interface M3LRunningConsole {
  /** The composed runtime this console was started from. */
  readonly runtime: M3LConsoleRuntime;
  /** The verified, actually-listening server (see `lifecycle/http-server.ts`). */
  readonly server: M3LListeningServer;
  /**
   * The console store (ADR-0069) opened before the listener bound; closed
   * after the drain settles. Narrowed to {@link M3LConsoleStoreLifecycle} —
   * see {@link M3LConsoleRuntimeOptions.store}'s TSDoc for why this
   * composition root never republishes the full query surface.
   */
  readonly store: M3LConsoleStoreLifecycle;
  /**
   * Settles once a shutdown has been triggered AND completed — by a call to
   * {@link shutdown} or by a trapped signal, whichever happens first. Never
   * settles merely because the process is idle: nothing about awaiting this
   * promise itself starts a drain. The process entry point should `await`
   * this, not {@link shutdown} — see {@link shutdown}'s TSDoc for why those
   * are not interchangeable.
   *
   * REJECTS, rather than staying pending forever, if the underlying shutdown
   * sequence (drain + listener close) itself fails — carrying the original
   * cause unchanged. A caller that only ever expects the happy path should
   * still attach a rejection handler (or await inside a `try`/`catch`); an
   * unobserved rejection here is an unhandled-rejection warning like any
   * other promise.
   */
  readonly closed: Promise<M3LDrainOutcome>;
  /**
   * TRIGGERS the shutdown sequence (drain, then close the listener) and
   * resolves once it completes. Idempotent — a second call re-returns the
   * first call's outcome without draining or closing a second time.
   *
   * Deliberately distinct from {@link closed}: a process entry point that
   * `await`ed `shutdown()` instead of `closed` would tear the server down
   * the instant it finished booting, since calling this function is itself
   * what starts the drain.
   */
  shutdown(): Promise<M3LDrainOutcome>;
}

/** Logs the one line every boot emits once the listener is verified. Never the operator email. */
function logListening(
  logger: Core.M3LLogger,
  server: M3LListeningServer,
): void {
  logger.info("console server listening", {
    host: server.host,
    port: server.port,
  });
}

/** Logs the one line every shutdown emits once the drain has settled. */
function logDrainCompletion(
  logger: Core.M3LLogger,
  outcome: M3LDrainOutcome,
): void {
  logger.info("console server drain completed", {
    graceful: outcome.graceful,
    abandoned: outcome.abandoned,
    durationMs: outcome.durationMs,
  });
}

/** Logs the one line every boot emits once the console store is confirmed open. */
function logStoreReady(
  logger: Core.M3LLogger,
  store: M3LConsoleStoreHandle,
): void {
  logger.info("console store ready", {
    location: store.location,
    schemaVersion: store.schemaVersion,
  });
}

/**
 * Builds the {@link M3LConsoleRuntime} and binds its listener (ADR-0071,
 * `lifecycle/http-server.ts`), closing `store` if EITHER step fails. A
 * runtime-construction failure (e.g. `createRouter` raising
 * `ERR_CONSOLE_ROUTE_CONFLICT` on a duplicate route) is exactly the same
 * handle/WAL-sidecar leak class a bind failure is, so both are guarded by
 * this one region rather than only the bind.
 *
 * The failure that triggered the close always propagates UNCHANGED — a
 * failing `store.close()` here is best-effort and must never shadow it: it
 * is logged through the runtime's own logger when one exists (construction
 * succeeded, only the bind failed), or else chained onto the triggering
 * failure's own cause chain, since `createConsoleRuntime` is what threw and
 * so there is no logger yet to report it through.
 */
async function buildRuntimeAndBindListener(
  options: StartConsoleOptions,
  config: M3LConsoleConfig,
  store: M3LConsoleStoreHandle & M3LConsoleStore,
): Promise<{
  readonly runtime: M3LConsoleRuntime;
  readonly server: M3LListeningServer;
}> {
  let runtime: M3LConsoleRuntime | undefined;
  try {
    runtime = createConsoleRuntime({
      ...options,
      config,
      store,
      runs: store.runs,
    });
    // A database write (reconciling SIGKILL-orphaned rows), so it belongs
    // here — not in createConsoleRuntime, a pure composition step — and
    // strictly before the bind below.
    runtime.runs?.orchestrator.reconcileOnBoot();
    const server = await startConsoleServer({
      host: runtime.config.host,
      port: runtime.config.port,
      listener: runtime.requestListener,
      closeTimeoutMs: runtime.config.drainTimeoutMs,
      ...(options.createServer !== undefined && {
        createServer: options.createServer,
      }),
    });
    return { runtime, server };
  } catch (cause) {
    // Best-effort: the construction/bind failure below is what the caller
    // needs to see, and a failing close() here must never shadow it.
    try {
      store.close();
    } catch (closeCause) {
      if (runtime === undefined) {
        // createConsoleRuntime is what threw — there is no runtime, and so
        // no logger, for the close failure to be reported through. It has
        // nowhere left to go but cause's own cause chain.
        chainSecondaryFailure(cause, closeCause);
      } else {
        // Logged, like the structurally identical close-failure path in
        // `lifecycle/shutdown.ts`, but the ORIGINAL bind failure is still
        // what gets re-thrown below.
        runtime.logger.error("console store close failed", {
          cause: Core.getErrorMessage(closeCause),
        });
      }
    }
    throw cause;
  }
}

/**
 * Starts the console server: builds the {@link M3LConsoleRuntime}, binds and
 * verifies its listener (ADR-0071, `lifecycle/http-server.ts`), and
 * registers shutdown signal handlers.
 *
 * @param options - See {@link StartConsoleOptions}.
 * @returns A promise resolving to the running {@link M3LRunningConsole}.
 * @throws {@link M3LConsoleError} When configuration resolution or the
 *   listener bind fails — propagated, never swallowed.
 *
 * @example
 * ```ts
 * import { startConsole } from "./main.js";
 *
 * const running = await startConsole();
 * const outcome = await running.closed;
 * console.log(outcome.graceful);
 * ```
 */
export async function startConsole(
  options: StartConsoleOptions = {},
): Promise<M3LRunningConsole> {
  const config = resolveConfig(options);
  const openStore = options.openStore ?? openConsoleStore;
  const store = openStore({
    location: config.databasePath,
    busyTimeoutMs: config.databaseBusyTimeoutMs,
  });

  const { runtime, server } = await buildRuntimeAndBindListener(
    options,
    config,
    store,
  );

  logListening(runtime.logger, server);
  logStoreReady(runtime.logger, store);

  let resolveClosed!: (outcome: M3LDrainOutcome) => void;
  let rejectClosed!: (cause: unknown) => void;
  const closed = new Promise<M3LDrainOutcome>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Only the fulfillment branch logs — a rejected shutdown sequence never
  // "completed", so there is no drain outcome to report; the failure itself
  // is surfaced through `closed`/`shutdown()` rejecting, not this log line.
  // The rejection handler here exists solely to keep this internal chain
  // from becoming an unhandled rejection of its own.
  void closed.then(
    (outcome) => {
      logDrainCompletion(runtime.logger, outcome);
    },
    () => {
      // Deliberately swallowed — see comment above.
    },
  );

  const shutdown = createShutdown(
    runtime,
    server,
    store,
    resolveClosed,
    rejectClosed,
  );
  const signals = options.signals ?? DEFAULT_SIGNALS;
  registerConsoleShutdownSignals(signals, shutdown, closed, runtime.logger);

  return { runtime, server, store, closed, shutdown };
}
