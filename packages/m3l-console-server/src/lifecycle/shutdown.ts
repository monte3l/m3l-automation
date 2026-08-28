/**
 * `lifecycle/shutdown` — the console server's shutdown sequence: drain the
 * ADR-0049 controller, close the listener, then close a disposable resource
 * (the ADR-0069 console store, in `main.ts`'s case) once both settle.
 * Extracted from `main.ts` to keep it under `bin/check-file-budget.mjs`'s
 * ceiling as the store wiring landed.
 *
 * {@link M3LShutdownDisposable} is declared locally, not imported from
 * `store/` — `lifecycle/` may import only `errors/`, `lifecycle/` and `net/`
 * (ADR-0065), and a structural type needs no import at all.
 * `M3LConsoleStoreHandle` satisfies it structurally. Same trick as
 * `http/routes/health.ts`'s `M3LReadinessProbe`.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LDrainController, M3LDrainOutcome } from "./drain.js";
import type { M3LListeningServer } from "./http-server.js";

/**
 * The pieces {@link runShutdownSequence} needs from the composed runtime:
 * the drain controller, the logger a failing disposable close is reported
 * through, and (X4 slice 6) the optional run subsystem drained alongside the
 * HTTP drain.
 *
 * @example
 * ```ts
 * const runtime: M3LShutdownRuntime = { drain: createDrainController({ timeoutMs: 1_000 }), logger };
 * ```
 */
export interface M3LShutdownRuntime {
  readonly drain: M3LDrainController;
  readonly logger: Core.M3LLogger;
  /**
   * The X4 run subsystem's drain seam, when one is wired (see `main.ts`'s
   * `M3LConsoleRuntime.runs`). Absent when run orchestration is disabled —
   * {@link runShutdownSequence} treats that as an already-settled drain.
   */
  readonly runs?: M3LShutdownDrainable;
}

/**
 * A structural seam over a synchronously closeable resource — e.g. the
 * ADR-0069 console store. Declared here (not imported) so `lifecycle/` never
 * gains a `store/` edge.
 *
 * @example
 * ```ts
 * const disposable: M3LShutdownDisposable = { close: () => undefined };
 * ```
 */
export interface M3LShutdownDisposable {
  close(): void;
}

/**
 * A structural seam over an abortable, awaitable run subsystem — e.g. the
 * X4 `runs/composition.ts` `M3LRunSubsystem`. Declared here (not imported),
 * the same trick {@link M3LShutdownDisposable} already uses: `lifecycle/`
 * may import only `lifecycle`, `errors`, `net` (ADR-0065), never `runs/`, so
 * this port lets `M3LRunSubsystem` satisfy it structurally without either
 * module ever importing the other.
 *
 * @example
 * ```ts
 * const drainable: M3LShutdownDrainable = { drain: () => Promise.resolve() };
 * ```
 */
export interface M3LShutdownDrainable {
  drain(): Promise<void>;
}

/** The exit code forced on a second shutdown signal. */
const FORCED_SECOND_SIGNAL_EXIT_CODE = 1;

/**
 * Runs the shutdown sequence: starts the drain BEFORE closing the listener.
 *
 * `M3LDrainController.drain()` aborts its signal SYNCHRONOUSLY before
 * returning, so calling it first (and only then calling `server.close()`)
 * guarantees the drain signal is already aborted by the instant the listener
 * stops accepting connections — measured on Node v26.7.0, `close()` refuses
 * new connections with `ECONNREFUSED` the instant it is *called*, not once
 * its callback settles, so closing first would leave a window where the
 * server is unreachable yet nothing has observed a drain in progress.
 * `server.close()` already runs its own idle-connection sweep internally
 * (`lifecycle/http-server.ts`'s `createCloseOnce`) — not duplicated here.
 *
 * `disposable` closes only after ALL THREE — the HTTP drain, the listener
 * close, and (X4 slice 6) `runtime.runs`'s drain, when one is wired — settle.
 * An in-flight response may still be reading it, and (now) an in-flight run
 * may still be writing to it. `runtime.runs?.drain()` is started ALONGSIDE
 * the HTTP drain, not sequenced after it settles: a run outliving the HTTP
 * drain window is exactly the `ECONNRESET`-for-watchers failure this design
 * exists to prevent — a run's SSE/log watcher would otherwise be torn down
 * by the listener closing while the run it is watching is still in flight.
 * A failing `close()` is logged at error level but never rejects this
 * sequence: the process is about to exit anyway, which releases the handle
 * regardless, and turning a graceful drain into a rejected shutdown for a
 * cosmetic close failure would cost the operator the drain outcome they
 * actually need.
 *
 * @example
 * ```ts
 * const outcome = await runShutdownSequence(runtime, server, store);
 * ```
 */
async function runShutdownSequence(
  runtime: M3LShutdownRuntime,
  server: M3LListeningServer,
  disposable: M3LShutdownDisposable,
): Promise<M3LDrainOutcome> {
  const runsPromise = runtime.runs?.drain() ?? Promise.resolve();
  const drainPromise = runtime.drain.drain();
  const closePromise = server.close();
  const [outcome] = await Promise.all([
    drainPromise,
    closePromise,
    runsPromise,
  ]);
  try {
    disposable.close();
  } catch (cause) {
    runtime.logger.error("console store close failed", {
      cause: Core.getErrorMessage(cause),
    });
  }
  return outcome;
}

/**
 * Builds the idempotent shutdown function, memoizing its outcome promise.
 * `onSettled`/`onFailed` fan the sequence's single outcome out to `closed`'s
 * resolver/rejecter (see `main.ts`'s `startConsole`) while the returned
 * function's own promise keeps propagating a rejection unchanged —
 * `onFailed`'s handler re-throws `cause` rather than swallowing it, so both
 * channels observe the same failure.
 *
 * @example
 * ```ts
 * const shutdown = createShutdown(runtime, server, store, resolve, reject);
 * ```
 */
export function createShutdown(
  runtime: M3LShutdownRuntime,
  server: M3LListeningServer,
  disposable: M3LShutdownDisposable,
  onSettled: (outcome: M3LDrainOutcome) => void,
  onFailed: (cause: unknown) => void,
): () => Promise<M3LDrainOutcome> {
  let shutdownPromise: Promise<M3LDrainOutcome> | undefined;

  return function shutdown(): Promise<M3LDrainOutcome> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = runShutdownSequence(runtime, server, disposable).then(
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
 * (`internal/script/signalHandlers.ts` never removes its own — a bare script
 * process exits shortly after anyway, but a long-lived console server
 * calling this more than once per process lifetime would otherwise leak
 * three listeners per call and eventually trip `MaxListenersExceededWarning`).
 *
 * Uses a persistent listener with a `signaled` flag rather than
 * `{ once: true }`: `once` would hand a second signal to Node's default
 * disposition (an uncontrolled exit) instead of the deliberate forced exit
 * this function performs.
 *
 * @example
 * ```ts
 * registerConsoleShutdownSignals(["SIGTERM"], shutdown, closed, logger);
 * ```
 */
export function registerConsoleShutdownSignals(
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
