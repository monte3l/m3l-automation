/**
 * Tests for `core/utils/M3LSingleFlight` (RED phase — module not yet
 * implemented).
 *
 * Contract source: hub-locked spec for the "zero-dep-primitives" change set
 * (PR 3.2), no `docs/reference/core/utils.md` entry exists yet for this
 * addition.
 *
 * Exports under test: `M3LSingleFlight`.
 *
 * Key behavioral contracts:
 *  - `run(key, fn)` keys coalescing by an arbitrary string key. Concurrent
 *    callers passing the same `key` while a call for that key is already
 *    in-flight receive the SAME promise — `fn` is invoked exactly once, not
 *    once per caller.
 *  - Concurrent calls for DIFFERENT keys never coalesce; each invokes its
 *    own `fn`.
 *  - Once the in-flight call settles (resolve OR reject), the key's entry is
 *    cleared: a subsequent `run()` call for the same key starts a fresh
 *    invocation of `fn`, not a join onto the already-settled prior call.
 *  - A rejection from the in-flight call propagates, with the same error
 *    instance, to every coalesced caller — not just the first.
 *
 * Judgment call (flagged for the implementer): `M3LSingleFlight` is modeled
 * as a class with a no-argument constructor and a generic `run<T>(key,
 * fn): Promise<T>` method (mirrors `M3LConcurrencyPool`'s plain-class,
 * no-options-bag shape — there is no configuration knob analogous to
 * `concurrency` here). If the implementer prefers a factory function
 * instead of a class, only the `new M3LSingleFlight()` construction lines
 * below need to change.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LSingleFlight } from "../src/core/utils/M3LSingleFlight.js";

/** A promise plus external resolve/reject handles, for controlling settlement timing deterministically. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("M3LSingleFlight", () => {
  test("concurrent calls for the same key share one underlying invocation and resolve to the same value", async () => {
    const single = new M3LSingleFlight();
    const deferred = createDeferred<string>();
    const worker = vi.fn(() => deferred.promise);

    const first = single.run("key-a", worker);
    const second = single.run("key-a", worker);

    expect(worker).toHaveBeenCalledTimes(1);

    deferred.resolve("shared-value");

    await expect(first).resolves.toBe("shared-value");
    await expect(second).resolves.toBe("shared-value");
  });

  test("concurrent calls for different keys each invoke their own underlying function", async () => {
    const single = new M3LSingleFlight();
    const workerA = vi.fn(() => Promise.resolve("value-a"));
    const workerB = vi.fn(() => Promise.resolve("value-b"));

    const first = single.run("key-a", workerA);
    const second = single.run("key-b", workerB);

    await expect(first).resolves.toBe("value-a");
    await expect(second).resolves.toBe("value-b");
    expect(workerA).toHaveBeenCalledTimes(1);
    expect(workerB).toHaveBeenCalledTimes(1);
  });

  test("a new call for the same key after settlement starts a fresh invocation", async () => {
    const single = new M3LSingleFlight();
    const worker = vi.fn(() => Promise.resolve("value"));

    await expect(single.run("key-a", worker)).resolves.toBe("value");
    await expect(single.run("key-a", worker)).resolves.toBe("value");

    expect(worker).toHaveBeenCalledTimes(2);
  });

  test("a rejection from the in-flight call propagates to every coalesced caller", async () => {
    const single = new M3LSingleFlight();
    const deferred = createDeferred<string>();
    const worker = vi.fn(() => deferred.promise);
    const failure = new Error("underlying call failed");

    const first = single.run("key-a", worker);
    const second = single.run("key-a", worker);
    const third = single.run("key-a", worker);

    deferred.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(third).rejects.toBe(failure);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  test("a subsequent call for the same key after a rejection starts a fresh invocation", async () => {
    const single = new M3LSingleFlight();
    const failure = new Error("first call failed");
    const worker = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("recovered");

    await expect(single.run("key-a", worker)).rejects.toBe(failure);
    await expect(single.run("key-a", worker)).resolves.toBe("recovered");

    expect(worker).toHaveBeenCalledTimes(2);
  });

  test("run() does not throw synchronously when fn throws synchronously — only the returned promise rejects", async () => {
    const single = new M3LSingleFlight();
    const failure = new Error("sync boom");

    let resultPromise: Promise<string> | undefined;

    expect(() => {
      resultPromise = single.run<string>("key-a", () => {
        throw failure;
      });
    }).not.toThrow();

    if (resultPromise === undefined) {
      throw new Error(
        "run() did not return a promise for a synchronously-throwing fn",
      );
    }

    await expect(resultPromise).rejects.toThrow("sync boom");
  });

  test("run() resolves to the type returned by the underlying function", () => {
    const single = new M3LSingleFlight();
    expectTypeOf(
      single.run<number>("k", () => Promise.resolve(1)),
    ).resolves.toBeNumber();
  });
});
