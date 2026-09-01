/**
 * Tests for `internal/errors/chain-secondary-failure` (X7b): attaching a
 * cleanup-path failure onto an error that is already in flight.
 *
 * The append-only read path exercises the happy arm end-to-end (see
 * `storage-append-only-read-lifecycle.test.ts`), but every DEFENSIVE arm
 * here — a hostile `.cause` accessor, a frozen error, a chain longer than
 * the walk bound — is unreachable from a real filesystem read. They are the
 * arms that matter most: this helper runs while an error is already being
 * thrown, so a defect in it does not merely lose the cleanup detail, it can
 * REPLACE the error the caller needed to see. Hence direct unit tests.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "vitest";

import { chainSecondaryFailure } from "../src/internal/errors/chain-secondary-failure.js";

describe("attaching to an open slot", () => {
  test("sets an unset .cause and reports success", () => {
    const primary = new Error("primary");
    const secondary = new Error("cleanup");

    expect(chainSecondaryFailure(primary, secondary)).toBe(true);
    expect(primary.cause).toBe(secondary);
  });

  test("walks past a taken slot to the first open one, deeper in the chain", () => {
    const deepest = new Error("deepest");
    const middle = new Error("middle", { cause: deepest });
    const primary = new Error("primary", { cause: middle });
    const secondary = new Error("cleanup");

    expect(chainSecondaryFailure(primary, secondary)).toBe(true);
    // The primary's own diagnostic chain outranks the cleanup one, so
    // neither existing link was overwritten.
    expect(primary.cause).toBe(middle);
    expect(middle.cause).toBe(deepest);
    expect(deepest.cause).toBe(secondary);
  });

  test("stops at a non-Error cause rather than walking into it", () => {
    const primary = new Error("primary", { cause: "a string cause" });

    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
    expect(primary.cause).toBe("a string cause");
  });
});

describe("refusing to attach, without ever throwing", () => {
  test.each([
    ["a non-Error primary", "not an error"],
    ["null", null],
    ["undefined", undefined],
  ] as [string, unknown][])("returns false for %s", (_label, primary) => {
    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
  });

  test("returns false when every slot within the walk bound is taken", () => {
    // Eleven links: the only open slot sits one step BEYOND the bounded
    // walk, so the helper gives up rather than searching without limit.
    const links = Array.from(
      { length: 11 },
      (_, i) => new Error(`link-${String(i)}`),
    );
    for (let i = 0; i < links.length - 1; i += 1) {
      (links[i] as Error).cause = links[i + 1];
    }

    expect(chainSecondaryFailure(links[0], new Error("cleanup"))).toBe(false);
    expect((links[10] as Error).cause).toBeUndefined();
  });

  test("returns false when the error is frozen", () => {
    const primary = Object.freeze(new Error("frozen"));

    // A frozen error rejects the assignment in strict mode; the helper must
    // absorb that TypeError rather than let it escape and mask the primary.
    expect(() =>
      chainSecondaryFailure(primary, new Error("cleanup")),
    ).not.toThrow();
    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
  });

  test("returns false when a .cause getter throws", () => {
    const primary = new Error("hostile getter");
    Object.defineProperty(primary, "cause", {
      get: () => {
        throw new Error("getter exploded");
      },
      configurable: true,
    });

    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
  });

  test("returns false when a .cause setter throws", () => {
    const primary = new Error("hostile setter");
    Object.defineProperty(primary, "cause", {
      get: () => undefined,
      set: () => {
        throw new Error("setter exploded");
      },
      configurable: true,
    });

    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
  });

  test("returns false when a .cause setter silently no-ops", () => {
    // The read-back check is what catches this: the assignment "succeeds"
    // but stores nothing, so reporting `true` would claim a chain link that
    // does not exist.
    const primary = new Error("no-op setter");
    Object.defineProperty(primary, "cause", {
      get: () => undefined,
      set: () => {
        /* accepts and discards */
      },
      configurable: true,
    });

    expect(chainSecondaryFailure(primary, new Error("cleanup"))).toBe(false);
  });
});
