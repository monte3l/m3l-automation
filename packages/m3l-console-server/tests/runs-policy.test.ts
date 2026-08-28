/**
 * Tests for src/runs/policy.ts — `createConfirmationPolicy` (m3l-console-server
 * X4 slice 6 round 1). Pure in-memory contract: `evaluate` is a total
 * function over four boolean combinations and never throws, so every test
 * here calls it directly with no mocking or fake collaborators.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { createConfirmationPolicy } from "../src/runs/policy.js";
import type {
  M3LRunPolicy,
  M3LRunPolicyRequest,
  M3LRunPolicyVerdict,
} from "../src/runs/policy.js";

/** Builds a request, defaulting every field to a launch that requires confirmation. */
function buildRequest(
  overrides: Partial<M3LRunPolicyRequest> = {},
): M3LRunPolicyRequest {
  return {
    scriptName: "sqs-etl",
    dryRun: false,
    confirmed: false,
    operator: "ada",
    ...overrides,
  };
}

describe("createConfirmationPolicy — verdict table", () => {
  test.each<[boolean, boolean, "allow" | "deny"]>([
    [true, false, "allow"],
    [true, true, "allow"],
    [false, true, "allow"],
    [false, false, "deny"],
  ])(
    "dryRun=%s confirmed=%s -> %s",
    (dryRun: boolean, confirmed: boolean, kind: "allow" | "deny") => {
      const policy: M3LRunPolicy = createConfirmationPolicy();

      const verdict = policy.evaluate(buildRequest({ dryRun, confirmed }));

      expect(verdict.kind).toBe(kind);
    },
  );
});

describe("createConfirmationPolicy — deny reason", () => {
  test("names the missing confirmation when dryRun is false and confirmed is false", () => {
    const policy = createConfirmationPolicy();

    const verdict = policy.evaluate(
      buildRequest({ dryRun: false, confirmed: false }),
    );

    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.reason.toLowerCase()).toContain("confirm");
    }
  });
});

describe("createConfirmationPolicy — allow carries no reason", () => {
  test('an allow verdict is exactly { kind: "allow" } with no extra fields', () => {
    const policy = createConfirmationPolicy();

    const verdict = policy.evaluate(
      buildRequest({ dryRun: false, confirmed: true }),
    );

    expect(verdict).toEqual({ kind: "allow" });
  });
});

describe("createConfirmationPolicy — never throws", () => {
  test.each<[boolean, boolean]>([
    [true, false],
    [true, true],
    [false, true],
    [false, false],
  ])(
    "dryRun=%s confirmed=%s never throws",
    (dryRun: boolean, confirmed: boolean) => {
      const policy = createConfirmationPolicy();

      expect(() => {
        policy.evaluate(buildRequest({ dryRun, confirmed }));
      }).not.toThrow();
    },
  );
});

describe("createConfirmationPolicy — evaluate does not accept a mutating flag", () => {
  test("M3LRunPolicyRequest has exactly the documented fields", () => {
    expectTypeOf<M3LRunPolicyRequest>().toEqualTypeOf<{
      readonly scriptName: string;
      readonly dryRun: boolean;
      readonly confirmed: boolean;
      readonly operator: string;
    }>();
  });
});

describe("M3LRunPolicyVerdict", () => {
  test("is a readonly discriminated union of allow and deny", () => {
    expectTypeOf<M3LRunPolicyVerdict>().toEqualTypeOf<
      | { readonly kind: "allow" }
      | { readonly kind: "deny"; readonly reason: string }
    >();
  });
});
