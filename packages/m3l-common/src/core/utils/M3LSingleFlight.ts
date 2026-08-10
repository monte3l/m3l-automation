/**
 * `core/utils/M3LSingleFlight` — single-flight async call coalescing.
 *
 * Deduplicates concurrent calls that share a key: only the first caller's
 * function actually runs, and every concurrent caller for that key shares
 * its outcome (resolve or reject).
 *
 * @packageDocumentation
 */

/**
 * Coalesces concurrent async calls by key: while a call for a given `key` is
 * in flight, every additional `run()` for the same key returns the SAME
 * promise instead of invoking `fn` again. Once the in-flight call settles
 * (resolve or reject), the key's entry clears — a later `run()` for that key
 * starts a fresh invocation.
 *
 * Calls for different keys never coalesce; each runs its own `fn`
 * independently.
 *
 * @example
 * ```typescript
 * import { M3LSingleFlight } from "@m3l-automation/m3l-common/core";
 *
 * const single = new M3LSingleFlight();
 *
 * // Two concurrent callers for the same key share one underlying fetch.
 * const [a, b] = await Promise.all([
 *   single.run("user:42", () => fetchUser("42")),
 *   single.run("user:42", () => fetchUser("42")),
 * ]);
 * // a === b, and fetchUser was invoked exactly once
 * ```
 */
export class M3LSingleFlight {
  /** In-flight promises keyed by their coalescing key. */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn`, coalescing concurrent callers that share `key`.
   *
   * @param key - The coalescing key. Concurrent calls sharing the same key
   *   while one is in flight share its single underlying invocation.
   * @param fn - The async function to invoke. Not invoked again for a
   *   coalesced caller — only the first caller for an in-flight key runs it.
   * @returns A promise resolving (or rejecting) with `fn`'s outcome, shared
   *   by every caller coalesced onto the same in-flight `key`. Never throws
   *   synchronously — even a `fn` that throws synchronously (rather than
   *   returning a rejected promise) surfaces as a rejection on the returned
   *   promise, not as a synchronous throw from `run()` itself.
   *
   * @example
   * ```typescript
   * import { M3LSingleFlight } from "@m3l-automation/m3l-common/core";
   *
   * const single = new M3LSingleFlight();
   * const value = await single.run("k", async () => 42);
   * ```
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      return existing as unknown as Promise<T>;
    }

    // `run` is declared `async` (rather than calling `fn()` directly in a
    // non-async method) so that a synchronous throw from `fn` is guaranteed
    // by the language spec to reject the returned promise instead of
    // escaping `run()` itself as a synchronous exception — while still
    // invoking `fn` synchronously (no `await` runs before this line), so
    // coalescing a second concurrent `run()` call for the same key still
    // observes `fn` having been called exactly once.
    const promise = fn().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }
}
