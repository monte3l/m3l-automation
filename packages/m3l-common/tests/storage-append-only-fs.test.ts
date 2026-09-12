/**
 * Tests for `internal/storage/append-only-fs`'s platform-optional open-flag
 * helper, `flagOrZero`.
 *
 * `node:fs`'s `constants.O_NOFOLLOW` and `constants.O_NONBLOCK` are POSIX-only:
 * Node genuinely reports them as `undefined` on Windows, even though
 * `@types/node` declares both as unconditional `number`. Every site that folds
 * one of those flags into an open mask therefore has to answer the same
 * question — contribute the flag where the platform defines it, contribute
 * NOTHING where it does not — and `flagOrZero` is the single place that answer
 * lives.
 *
 * Why a dedicated suite rather than coverage through the stream: the
 * platform-absent arm is unreachable on Linux (and on macOS, and in CI), so the
 * fallback branch of every `?? 0` site had never executed on any platform this
 * project runs on. That is not a cosmetic coverage gap — the module's own TSDoc
 * records that without `O_NOFOLLOW` the symlink-redirection defence does not
 * apply, which makes the fallback a documented, security-relevant behaviour
 * that has to be pinned by hand. Calling the helper directly with `undefined`
 * is the only way to reach it without a Windows runner.
 *
 * This suite is pure arithmetic over numbers: no filesystem, no mocks, no
 * teardown.
 *
 * @packageDocumentation
 */

import { constants } from "node:fs";

import { describe, expect, expectTypeOf, test } from "vitest";

import { flagOrZero } from "../src/internal/storage/append-only-fs.js";

describe("flagOrZero", () => {
  test.each([
    ["O_RDONLY-sized bit", 0o1],
    ["a typical O_NOFOLLOW value", 0o400000],
    ["a typical O_NONBLOCK value", 0o4000],
  ])("returns a defined non-zero flag unchanged (%s)", (_label, flag) => {
    expect(flagOrZero(flag)).toBe(flag);
  });

  test("returns 0 for a flag the platform does not define", () => {
    // The Windows arm: `constants.O_NOFOLLOW` / `constants.O_NONBLOCK` are
    // genuinely `undefined` there, and this is the only way to reach that arm
    // on a POSIX runner.
    expect(flagOrZero(undefined)).toBe(0);
  });

  test("returns 0 for a flag that is defined as 0", () => {
    // NOT filler, and NOT a duplicate of the `undefined` case above: `??` and
    // `||` agree for `undefined` but disagree for `0`. This assertion is the
    // only thing standing between the helper and a future "simplification"
    // from `flag ?? 0` to `flag || 0` — which would still pass both cases
    // above while quietly changing the contract from "nullish" to "falsy".
    // Do not delete it as redundant.
    expect(flagOrZero(0)).toBe(0);
  });

  test("contributes nothing to an open mask when the platform lacks the flag", () => {
    // The real call shape at every `?? 0` site: the flag is OR-ed into a base
    // mask, so "contributes nothing" means the mask is byte-identical to the
    // base.
    const base = constants.O_RDONLY | constants.O_CREAT;

    expect(base | flagOrZero(undefined)).toBe(base);
  });

  test("contributes the flag itself to an open mask when the platform has it", () => {
    const base = constants.O_RDONLY | constants.O_CREAT;
    const flag = 0o400000;

    const mask = base | flagOrZero(flag);

    expect(mask & flag).toBe(flag);
    expect(mask & base).toBe(base);
  });

  test("accepts an optional flag and always yields a number", () => {
    // The `number | undefined` parameter type IS the contract: it is the
    // correction to `@types/node`'s unconditional `number` declaration, and
    // the entire reason this helper exists rather than a bare `?? 0`. A
    // parameter widened back to `number` would make every call site compile
    // while re-introducing the `NaN` mask on Windows.
    expectTypeOf(flagOrZero).parameters.toEqualTypeOf<[number | undefined]>();
    expectTypeOf(flagOrZero).returns.toEqualTypeOf<number>();
  });
});
