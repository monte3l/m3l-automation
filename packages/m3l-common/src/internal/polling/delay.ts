/**
 * `internal/polling/delay` — a promise-returning delay built on the global
 * `setTimeout`, so it is transparently controllable under test fake timers
 * (unlike `node:timers/promises`, whose promise variant fake-timer runners do
 * not reliably advance).
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

import { M3LOperationAbortedError } from "../../core/errors/index.js";

/**
 * Resolve after `ms` milliseconds, or reject with
 * {@link M3LOperationAbortedError} when `signal` is aborted.
 *
 * When `signal` is already aborted on entry, the promise rejects immediately
 * without arming a timer. When `signal` aborts while the timer is pending, the
 * timer is cancelled and the promise rejects promptly — the remaining delay is
 * not slept out.
 *
 * Abort listeners are cleaned up on **both** settle paths (timer-fired and
 * aborted) to prevent accumulation across many attempts against a shared signal.
 *
 * When `signal` is omitted the behaviour is identical to before this parameter
 * existed: resolve after `ms` milliseconds with no event-listener overhead.
 *
 * @param ms - Delay in milliseconds (non-negative).
 * @param signal - Optional `AbortSignal`. When present the delay is
 *   interruptible; when absent behaviour is unchanged.
 * @returns A promise that resolves once the delay elapses.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Fast path: no signal — identical to pre-signal behaviour.
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }

    // Already aborted — reject immediately without arming a timer.
    if (signal.aborted) {
      reject(new M3LOperationAbortedError());
      return;
    }

    // Both paths below must call removeEventListener so the listener count
    // stays balanced. { once: true } is intentionally NOT used — it removes
    // the listener internally via the EventTarget machinery, which does NOT
    // call the method on the signal object, so the spy counts in tests would
    // diverge.

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new M3LOperationAbortedError());
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort);
  });
}
