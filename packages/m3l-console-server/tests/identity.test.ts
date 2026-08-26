/**
 * Tests for src/auth/identity.ts — the ADR-0071 auth seam
 * (m3l-console-server X2b contract, wave 1). `createSingleOperatorProvider`
 * is a pure leaf: it binds nothing and starts nothing, so every case here
 * exercises plain function behavior with no mocks or teardown.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { createSingleOperatorProvider } from "../src/auth/identity.js";
import type {
  M3LOperatorProfile,
  M3LOperatorProvider,
} from "../src/auth/identity.js";

describe("createSingleOperatorProvider", () => {
  test("returns a provider whose kind is 'single-operator'", () => {
    const profile: M3LOperatorProfile = { name: "ada", email: undefined };

    const provider = createSingleOperatorProvider(profile);

    expect(provider.kind).toBe("single-operator");
  });

  test("resolve returns the bound profile regardless of the headers supplied", () => {
    const profile: M3LOperatorProfile = {
      name: "ada",
      email: "ada@example.com",
    };
    const provider = createSingleOperatorProvider(profile);

    expect(provider.resolve({})).toEqual(profile);
    expect(provider.resolve({ authorization: "Bearer xyz" })).toEqual(profile);
  });

  test("resolve carries an operator profile whose email is undefined", () => {
    const profile: M3LOperatorProfile = { name: "grace", email: undefined };
    const provider = createSingleOperatorProvider(profile);

    const resolved = provider.resolve({});

    expect(resolved?.email).toBeUndefined();
    expect(resolved?.name).toBe("grace");
  });

  test("resolve is deterministic across repeated calls (no per-request state)", () => {
    const profile: M3LOperatorProfile = { name: "grace", email: undefined };
    const provider = createSingleOperatorProvider(profile);

    const first = provider.resolve({});
    const second = provider.resolve({ "x-anything": "value" });

    expect(first).toEqual(second);
  });
});

describe("M3LOperatorProvider", () => {
  test("createSingleOperatorProvider's return value satisfies the M3LOperatorProvider contract", () => {
    expectTypeOf(
      createSingleOperatorProvider,
    ).returns.toMatchTypeOf<M3LOperatorProvider>();
  });
});
