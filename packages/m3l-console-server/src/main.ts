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
 */
const runtimeSecrets: Core.M3LSecretNamesPort = {
  isSecret: (name) =>
    name === "operatorEmail" ||
    name === "email" ||
    name === "headers" ||
    name === "cookie",
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
 */
function buildDispatchRouter(
  drain: M3LDrainController,
  routes: readonly M3LRoute[],
): M3LRouter {
  const healthRoutes = createHealthRoutes({ drain, startedAt: Date.now() });
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
  const drain = createDrainController({ timeoutMs: config.drainTimeoutMs });
  const routes = options.routes ?? [];
  const router = createRouter(routes);
  const requestListener = createConsoleRequestListener({
    router: buildDispatchRouter(drain, routes),
    middlewares: [createAuthMiddleware(operatorProvider)],
    preRouting: [createOriginGuard(), createDrainMiddleware(drain)],
    logger,
    signal: drain.signal,
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

/** The exit code forced on a second shutdown signal. */
const FORCED_SECOND_SIGNAL_EXIT_CODE = 1;

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
 * Runs the shutdown sequence: starts the drain BEFORE closing the listener.
 *
 * `M3LDrainController.drain()` aborts its signal SYNCHRONOUSLY before
 * returning, so calling it first (and only then calling `server.close()`)
 * guarantees `runtime.signal` is already aborted by the instant the
 * listener stops accepting connections — measured on Node v26.7.0,
 * `close()` refuses new connections with `ECONNREFUSED` the instant it is
 * *called*, not once its callback settles, so closing first would leave a
 * window where the server is unreachable yet nothing (a readiness probe,
 * `runtime.signal`) has observed a drain in progress. Both layers still
 * stop accepting new work before any in-flight work is awaited: the drain
 * controller refuses new `track()`s and flips `/ready` to 503 at the
 * application layer, with the socket layer following immediately after.
 * `server.close()` already runs its own idle-connection sweep internally
 * (`lifecycle/http-server.ts`'s `createCloseOnce`) — not duplicated here.
 */
async function runShutdownSequence(
  runtime: M3LConsoleRuntime,
  server: M3LListeningServer,
): Promise<M3LDrainOutcome> {
  const drainPromise = runtime.drain.drain();
  const closePromise = server.close();
  const [outcome] = await Promise.all([drainPromise, closePromise]);
  return outcome;
}

/**
 * Builds the idempotent {@link M3LRunningConsole.shutdown}, memoizing its
 * outcome promise. `onSettled`/`onFailed` fan the sequence's single outcome
 * out to `closed`'s resolver/rejecter (see {@link startConsole}) while
 * `shutdown()`'s own returned promise keeps propagating a rejection
 * unchanged — `onFailed`'s handler re-throws `cause` rather than swallowing
 * it, so both channels observe the same failure (a rejecting
 * `runShutdownSequence` must never leave `closed` pending forever, but must
 * also never make `shutdown()` itself resolve).
 */
function createShutdown(
  runtime: M3LConsoleRuntime,
  server: M3LListeningServer,
  onSettled: (outcome: M3LDrainOutcome) => void,
  onFailed: (cause: unknown) => void,
): () => Promise<M3LDrainOutcome> {
  let shutdownPromise: Promise<M3LDrainOutcome> | undefined;

  return function shutdown(): Promise<M3LDrainOutcome> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = runShutdownSequence(runtime, server).then(
      (outcome) => {
        onSettled(outcome);
        return outcome;
      },
      (cause: unknown) => {
        onFailed(cause);
        throw cause;
      },
    );
    return shutdownPromise;
  };
}

/**
 * Registers `signals` to trigger `shutdown` on first receipt and force
 * `process.exit` on a second — mirroring
 * `internal/script/signalHandlers.ts`'s `registerShutdownSignals`, with one
 * deliberate difference: handlers here are removed once `closed` settles
 * (`internal/script/signalHandlers.ts` never removes its own — a bare
 * script process exits shortly after anyway, but a long-lived console
 * server calling this more than once per process lifetime would otherwise
 * leak three listeners per call and eventually trip
 * `MaxListenersExceededWarning`).
 *
 * Uses a persistent listener with a `signaled` flag rather than
 * `{ once: true }`: `once` would hand a second signal to Node's default
 * disposition (an uncontrolled exit) instead of the deliberate forced exit
 * this function performs.
 */
function registerConsoleShutdownSignals(
  signals: readonly NodeJS.Signals[],
  shutdown: () => Promise<M3LDrainOutcome>,
  closed: Promise<M3LDrainOutcome>,
  logger: Core.M3LLogger,
): void {
  let signaled = false;

  const handleSignal = (): void => {
    if (signaled) {
      process.exit(FORCED_SECOND_SIGNAL_EXIT_CODE);
    }
    signaled = true;
    // Fire-and-forget: a hanging shutdown must not block signal delivery,
    // and a rejecting one must not surface as an unhandled rejection.
    void Promise.resolve()
      .then(() => shutdown())
      .catch((cause: unknown) => {
        logger.error("console server shutdown failed", {
          cause: Core.getErrorMessage(cause),
        });
      });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  // Removed once `closed` settles — on EITHER the resolve or the reject
  // path, regardless of whether it was a trapped signal or an explicit
  // `shutdown()` call that triggered it. `.finally()`'s own returned promise
  // re-rejects with `closed`'s cause when `closed` rejects (it never
  // swallows), so the trailing `.catch()` is required here: this listener
  // cleanup is the only consumer of this particular chain, and the
  // rejection itself is already observable through `closed`/`shutdown()`
  // directly — an unhandled one here would just be a duplicate warning, not
  // a lost failure.
  void closed
    .finally(() => {
      for (const signal of signals) {
        process.removeListener(signal, handleSignal);
      }
    })
    .catch(() => {
      // Deliberately swallowed — see comment above.
    });
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
  const runtime = createConsoleRuntime(options);
  const server = await startConsoleServer({
    host: runtime.config.host,
    port: runtime.config.port,
    listener: runtime.requestListener,
    closeTimeoutMs: runtime.config.drainTimeoutMs,
    ...(options.createServer !== undefined && {
      createServer: options.createServer,
    }),
  });

  logListening(runtime.logger, server);

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

  const shutdown = createShutdown(runtime, server, resolveClosed, rejectClosed);
  const signals = options.signals ?? DEFAULT_SIGNALS;
  registerConsoleShutdownSignals(signals, shutdown, closed, runtime.logger);

  return { runtime, server, closed, shutdown };
}
