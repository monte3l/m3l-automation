/**
 * `internal/script/signalHandlers` — graceful-shutdown signal registration
 * for non-AWS execution environments.
 *
 * Not re-exported publicly; consumed only by `core/script/M3LScript`.
 *
 * @packageDocumentation
 */

import { serializeError } from "../../core/script/process-guards.js";

import { logBestEffortDiagnostic } from "./diagnostics.js";

/** The process signals `M3LScript` reacts to outside AWS-managed environments. */
const HANDLED_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;

/** One of the signals registered by {@link registerShutdownSignals}. */
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/**
 * Registers `SIGTERM`/`SIGINT`/`SIGQUIT` handlers that invoke
 * `onShutdown` (best-effort, fire-and-forget) on the first receipt of any of
 * them, and force `process.exit(1)` on any subsequent receipt of a second
 * signal — the standard "first signal asks nicely, second signal is
 * final" shutdown pattern.
 *
 * Each call to this function installs a fresh, independent set of handlers
 * and its own "already signaled" flag; callers are responsible for calling
 * it at most once per {@link M3LScript} instance (construction time, gated
 * on non-AWS environments).
 *
 * @param onShutdown - Invoked once, on the first signal received. Its
 *   returned promise (if any) is not awaited by this function — shutdown is
 *   best-effort and must not block signal delivery.
 */
export function registerShutdownSignals(
  onShutdown: () => void | Promise<void>,
): void {
  let signaled = false;

  const handleSignal = (): void => {
    if (signaled) {
      process.exit(1);
      return;
    }
    signaled = true;
    // Fire-and-forget: a hanging or rejecting shutdown must not prevent the
    // process from otherwise exiting naturally, and a synchronous throw from
    // a misbehaving onShutdown must not crash the signal handler itself.
    void Promise.resolve()
      .then(() => onShutdown())
      .catch((cause: unknown) => {
        // Best-effort shutdown — a failure here is not actionable from
        // inside a signal handler, but it must not vanish silently either.
        logBestEffortDiagnostic("onShutdown", serializeError(cause));
      });
  };

  for (const signal of HANDLED_SIGNALS as readonly HandledSignal[]) {
    process.on(signal, handleSignal);
  }
}
