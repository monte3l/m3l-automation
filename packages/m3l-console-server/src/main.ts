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

import type { M3LHumanActionAuditPort } from "./audit/port.js";
import { indexHumanActionAuditPort } from "./boot/audit-index.js";
import { rebuildHumanActionIndexOnBoot } from "./boot/audit-rebuild.js";
import { buildDispatchRouter } from "./boot/dispatch-router.js";
import {
  buildHumanActionAuditPort,
  resolveHumanActionAuditRoot,
} from "./boot/human-action-audit.js";
import {
  createRuntimeLogger,
  logDrainCompletion,
  logListening,
  logPosture,
  logStoreReady,
} from "./boot/logging.js";
import type { M3LConsoleConfig } from "./config/env.js";
import { loadConsoleConfig } from "./config/env.js";
import type { M3LConsoleRunsConfig } from "./config/runs.js";
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
import {
  adaptSessionService,
  toRunsRouteOptions,
  toSessionsRouteOptions,
} from "./http/routes/built-in.js";
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
import type { M3LRunSubsystem } from "./runs/composition.js";
import type { M3LRunRegistry } from "./runs/registry.js";
import type { M3LSessionSubsystem } from "./sessions/composition.js";
import { buildConsoleSubsystems } from "./subsystems.js";
import { openConsoleStore } from "./store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
  M3LConsoleStoreLifecycle,
  OpenConsoleStoreOptions,
} from "./store/store.js";
import type { M3LConsoleAuditRepository } from "./store/audit-repository.js";
import type { M3LConsoleSessionsRepository } from "./store/sessions-repository.js";
import type { M3LConsoleSessionsConfig } from "./config/sessions.js";
import type { M3LConsoleTelemetryRepository } from "./store/telemetry-repository.js";
import { createNoOpTelemetryRecorder } from "./telemetry/no-op.js";
import type { M3LTelemetryRecorder } from "./telemetry/port.js";
import { createStoreTelemetryRecorder } from "./telemetry-recorder.js";

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
   *
   * **A route supplied here is NOT audited.** `boot/dispatch-router.ts`
   * applies the ADR-0070 human-action audit gate to the console's OWN routes
   * and then appends this table verbatim, so no entry is recorded for a route
   * registered through this option — not even a write. That is deliberate,
   * not an oversight: `applyHumanActionAudit`'s spec table is keyed by this
   * console's own path templates, so it can never hold a spec for a route a
   * caller invented, and enforcing its exhaustiveness guard against those
   * would make this seam unusable — every caller route would fail boot. The
   * console's own write routes are all audited, and adding an unaudited one
   * still fails at boot. See `boot/human-action-audit.ts`'s
   * `applyHumanActionAudit` for the full boundary.
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
  /** Pre-resolved X6 workbench-sessions config; skips `loadSessionsConfig` (mirrors {@link runsConfig}). */
  readonly sessionsConfig?: M3LConsoleSessionsConfig;
  /** The workbench-sessions persistence port the X6 session subsystem builds from; see {@link createConsoleRuntime}. */
  readonly sessions?: M3LConsoleSessionsRepository;
  /**
   * The ADR-0070 SQLite audit INDEX every trail entry is additionally
   * projected into (X7c). Supplied as a sibling of `runs`/`sessions` rather
   * than reached through {@link store}, which is typed
   * {@link M3LConsoleStoreHandle} and carries no repositories.
   *
   * When absent — a storeless console, which {@link store} being optional
   * makes a supported state — {@link auditPort} stays the bare JSONL stream
   * and no index row is written. The trail is unaffected either way: it is
   * the source of truth, and the index is a derived projection of it (see
   * `boot/audit-index.ts`).
   */
  readonly audit?: M3LConsoleAuditRepository;
  /**
   * The ADR-0070 human-action audit port. Defaults to a JSONL stream rooted
   * at `M3L_CONSOLE_AUDIT_ROOT` (or the data dir's `console/audit`), wrapped
   * by `boot/audit-index.ts`'s dual-write port when {@link audit} is
   * supplied.
   *
   * Injectable purely as a test seam, mirroring the existing
   * `store`/`runs`/`sessions` convention — auditing itself is not optional,
   * and there is no configuration that turns it off. Supplying this REPLACES
   * the default entirely, index half included: a caller handing in its own
   * port owns what that port writes.
   */
  readonly auditPort?: M3LHumanActionAuditPort;
  /**
   * The X8 telemetry rollup port (mirrors {@link audit}). When absent,
   * {@link M3LConsoleRuntime.telemetry} falls back to the no-op recorder.
   */
  readonly telemetry?: M3LConsoleTelemetryRepository;
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
   * The ADR-0071 deferred readiness grace period, threaded verbatim from
   * {@link M3LConsoleConfig.readinessGraceMs} into `lifecycle/shutdown.ts`'s
   * `M3LShutdownRuntime`, which this interface structurally satisfies.
   */
  readonly readinessGraceMs: number;
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
  /**
   * The wired X6 session subsystem, present only when
   * {@link M3LConsoleRuntimeOptions.sessions} was supplied AND {@link runs}
   * built successfully (a session step launches a run through
   * `runs.orchestrator`). Mirrors {@link runs}'s own "present only when its
   * own preconditions were met" semantics.
   */
  readonly sessions?: M3LSessionSubsystem;
  /**
   * The X8 telemetry recorder — ALWAYS present, so callers never need an
   * `undefined` check. Store-backed when
   * {@link M3LConsoleRuntimeOptions.telemetry} was supplied, else no-op.
   */
  readonly telemetry: M3LTelemetryRecorder;
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
 *   {@link loadConsoleConfig}), and, when `options.sessions` is supplied, when
 *   {@link buildConsoleSubsystems}'s session-config resolution fails
 *   (`ERR_CONSOLE_CONFIG_INVALID`) — all propagated, never swallowed.
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

/** Resolves the telemetry recorder: store-backed when `options.telemetry` was supplied, else the no-op. */
function resolveTelemetry(
  options: M3LConsoleRuntimeOptions,
  logger: Core.M3LLogger,
): M3LTelemetryRecorder {
  return options.telemetry !== undefined
    ? createStoreTelemetryRecorder({ telemetry: options.telemetry, logger })
    : createNoOpTelemetryRecorder();
}

export function createConsoleRuntime(
  options: M3LConsoleRuntimeOptions = {},
): M3LConsoleRuntime {
  const config = resolveConfig(options);
  const logger = createRuntimeLogger(config, options.handlers);

  logPosture(logger, config);
  const { runs, sessions } = buildConsoleSubsystems(options, logger);

  const operator: M3LOperatorProfile = {
    name: config.operatorName,
    email: config.operatorEmail,
  };
  const operatorProvider = createSingleOperatorProvider(operator);
  const telemetry = resolveTelemetry(options, logger);
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
    router: buildDispatchRouter(
      drain,
      routes,
      options.store,
      toRunsRouteOptions(options.runs, runs),
      toSessionsRouteOptions(
        sessions !== undefined
          ? { service: adaptSessionService(sessions.service) }
          : undefined,
      ),
      options.auditPort ??
        indexHumanActionAuditPort(
          buildHumanActionAuditPort(options.env ?? process.env),
          options.audit,
          logger,
        ),
    ),
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
    readinessGraceMs: config.readinessGraceMs,
    telemetry,
    ...(options.store !== undefined && { store: options.store }),
    ...(runs !== undefined && { runs }),
    ...(sessions !== undefined && { sessions }),
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
      sessions: store.sessions,
      audit: store.audit,
      telemetry: store.telemetry,
    });
    // A database write (reconciling SIGKILL-orphaned rows), so it belongs
    // here — not in createConsoleRuntime, a pure composition step — and
    // strictly before the bind below.
    runtime.runs?.orchestrator.reconcileOnBoot();
    // The same slot, for the same reason, for the ADR-0070 audit index: a
    // database write that must land before the listener accepts a request
    // that would query it. Skipped when the caller injected its own
    // `auditPort`, because the console then does not know where that port's
    // trail lives and must not rebuild from an unrelated directory.
    if (options.auditPort === undefined) {
      // Resolved on its own line, not at the argument position: the rebuild
      // itself never throws, but resolving the root CAN
      // (`ERR_CONSOLE_CONFIG_INVALID`) — it just cannot here, because
      // `createConsoleRuntime` above already resolved the same root through
      // `buildHumanActionAuditPort` and would have thrown first. Either way it
      // sits inside this region's guard, so the store is still closed.
      const auditRoot = resolveHumanActionAuditRoot(options.env ?? process.env);
      await rebuildHumanActionIndexOnBoot({
        directory: auditRoot,
        store,
        logger: runtime.logger,
      });
    }
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
