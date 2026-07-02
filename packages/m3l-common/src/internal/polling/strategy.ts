/**
 * `internal/polling/strategy` — the opaque backoff-strategy contract shared by
 * {@link M3LBackoff}, {@link M3LPoller}, and {@link M3LRetryRunner}. The concrete
 * shape is deliberately private: consumers construct strategies through the
 * {@link M3LBackoff} factory and pass them opaquely, never depending on this
 * interface directly.
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

/**
 * A delay schedule. `nextDelay` is pure and deterministic except for jittered
 * strategies, which may draw randomness. Both the poller and the retry runner
 * call it once per waiting step.
 */
export interface M3LBackoffStrategy {
  /**
   * Compute the delay before the next attempt.
   *
   * @param attempt - Zero-based index of the wait about to occur (0 for the
   *   first delay after the initial attempt).
   * @param prevMs - The previous computed delay in milliseconds, or `undefined`
   *   on the first call. Used by decorrelated-jitter strategies.
   * @returns The delay in milliseconds before the next attempt.
   */
  nextDelay(attempt: number, prevMs: number | undefined): number;
}
