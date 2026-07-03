/**
 * `internal/polling/delay` — a promise-returning delay built on the global
 * `setTimeout`, so it is transparently controllable under test fake timers
 * (unlike `node:timers/promises`, whose promise variant fake-timer runners do
 * not reliably advance).
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

/**
 * Resolve after `ms` milliseconds.
 *
 * @param ms - Delay in milliseconds (non-negative).
 * @returns A promise that resolves once the delay elapses.
 */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
