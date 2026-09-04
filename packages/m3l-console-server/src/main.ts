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
import { chainSecondaryFailure } from "./errors/chain-secondary-failure.js";
import { createSingleOperatorProvider } from "./auth/identity.js";
import type { M3LOperatorProfile } from "./auth/identity.js";
import { createConsoleRequestListener } from "./http/handler.js";
import { createRouter } from "./http/router.js";
import {
  adaptSessionService,
  toRunsRouteOptions,
  toSessionsRouteOptions,
} from "./http/routes/built-in.js";
import { createOriginGuard } from "./http/origin-guard.js";
import { createDrainMiddleware } from "./http/drain-middleware.js";
import { createAuthMiddleware } from "./http/auth-middleware.js";
import { createDrainController } from "./lifecycle/drain.js";
import type { M3LDrainOutcome } from "./lifecycle/drain.js";
import { startConsoleServer } from "./lifecycle/http-server.js";
import type { M3LListeningServer } from "./lifecycle/http-server.js";
import {
  createShutdown,
  registerConsoleShutdownSignals,
} from "./lifecycle/shutdown.js";
import { buildConsoleSubsystems } from "./subsystems.js";
import { openConsoleStore } from "./store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
  M3LConsoleStoreLifecycle,
  OpenConsoleStoreOptions,
} from "./store/store.js";
import { createNoOpTelemetryRecorder } from "./telemetry/no-op.js";
import type { M3LTelemetryRecorder } from "./telemetry/port.js";
import type {
  M3LConsoleRuntime,
  M3LConsoleRuntimeOptions,
} from "./runtime-types.js";
import { createStoreTelemetryRecorder } from "./telemetry-recorder.js";

// Re-exported so this composition root stays the single import site for the
// runtime's public shape (see `runtime-types.ts` for why it lives elsewhere).
export type {
  M3LConsoleRuntime,
  M3LConsoleRuntimeOptions,
} from "./runtime-types.js";

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

type M3LTelemetryBackend = "store" | "no-op";

/** Resolves the backend label and recorder from `options.telemetry` together, so they can't disagree. */
function resolveTelemetry(
  options: M3LConsoleRuntimeOptions,
  logger: Core.M3LLogger,
): readonly [M3LTelemetryBackend, M3LTelemetryRecorder] {
  const repository = options.telemetry;
  return repository === undefined
    ? ["no-op", createNoOpTelemetryRecorder()]
    : [
        "store",
        createStoreTelemetryRecorder({ telemetry: repository, logger }),
      ];
}

export function createConsoleRuntime(
  options: M3LConsoleRuntimeOptions = {},
): M3LConsoleRuntime {
  const config = resolveConfig(options);
  const logger = createRuntimeLogger(config, options.handlers);

  const [telemetryBackend, telemetry] = resolveTelemetry(options, logger);
  logPosture(logger, config, telemetryBackend);
  const { runs, sessions } = buildConsoleSubsystems(options, logger, telemetry);

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
    telemetry,
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
