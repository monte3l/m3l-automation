/**
 * Generalized `Object.prototype`-pollution test harness, extracted from
 * `tests/lib/cli-surface.test.ts`'s "createAgentCliSurface — reads its
 * optional deps as OWN properties (M4c)" describe block so any module facing
 * the same "own property or treat as absent" contract can reuse it instead
 * of hand-rolling a fresh copy of the same four helpers.
 *
 * The defect class this proves against: a bag that HONESTLY omits a key
 * (never assigns it as an own property) must never silently inherit a value
 * an attacker installed on `Object.prototype` — a plain `bag.key` dot read
 * walks the prototype chain, so `Object.prototype.key = value` makes every
 * caller who never wrote `key` read `value` anyway. `Object.hasOwn(bag,
 * key)` gating the read is the fix this harness exists to prove; this file
 * only builds the pollution fixture, never the fix itself.
 *
 * @packageDocumentation
 */
import { expect } from "vitest";

/** A single-key, in-memory harness bound to one closed set of key names. */
export interface PrototypePollutionHarness<K extends string> {
  /**
   * Fails loudly, at the source, if a prior row leaked its pollution. Call
   * this as an `afterEach` backstop, and it is also called internally by
   * {@link PrototypePollutionHarness.withInherited} both before installing
   * the pollution and after removing it, so a leak is attributed to the row
   * that caused it rather than an unrelated later one.
   */
  expectUnpolluted(): void;
  /**
   * Installs `Object.prototype[key]` for the duration of `body` and removes
   * it unconditionally afterwards.
   *
   * Non-enumerable on purpose: an enumerable `Object.prototype` property
   * would also change every `for…in` and `JSON.stringify` in the process
   * during the window, which would make a failure inside `body` ambiguous
   * between the finding under test and the fixture itself.
   * `configurable: true` is what makes the removal in the `finally`
   * guaranteed to succeed, and `Reflect.deleteProperty` keeps that removal a
   * static call rather than a dynamic `delete`.
   *
   * The inherited read is asserted INSIDE the `try`, BEFORE `body` runs: a
   * fixture whose `defineProperty` silently failed to take would otherwise
   * let a row pass for the wrong reason (an assertion that a clean prototype
   * already satisfies).
   *
   * @param key - The key to install on `Object.prototype`.
   * @param value - The value an inheriting read must observe.
   * @param body - The scenario to run while the pollution is installed.
   */
  withInherited(
    key: K,
    value: unknown,
    body: () => Promise<void>,
  ): Promise<void>;
}

/**
 * Reads the value an own-property-less bag would INHERIT for `key`, without
 * asserting anything about how it got there. `undefined` is the only clean
 * state: `Object.prototype` carries none of the harness's keys in a healthy
 * run.
 */
function readInherited<K extends string>(key: K): unknown {
  const bag: Record<string, unknown> = {};
  return bag[key];
}

/**
 * Creates a {@link PrototypePollutionHarness} bound to `keys`. Every key in
 * the set is asserted absent from `Object.prototype` by
 * {@link PrototypePollutionHarness.expectUnpolluted}, so the caller supplies
 * every key its own scenario cares about, not just the one a given
 * `withInherited` call installs.
 *
 * @param keys - The closed set of key names this harness ever pollutes or
 *   checks.
 */
export function createPrototypePollutionHarness<K extends string>(
  keys: readonly K[],
): PrototypePollutionHarness<K> {
  function expectUnpolluted(): void {
    for (const key of keys) {
      expect(Object.hasOwn(Object.prototype, key)).toBe(false);
      expect(readInherited(key)).toBeUndefined();
    }
  }

  async function withInherited(
    key: K,
    value: unknown,
    body: () => Promise<void>,
  ): Promise<void> {
    expectUnpolluted();
    Object.defineProperty(Object.prototype, key, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    try {
      expect(readInherited(key)).toBe(value);
      await body();
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
    expectUnpolluted();
  }

  return { expectUnpolluted, withInherited };
}
