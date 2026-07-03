/**
 * Tests for aws/models submodule.
 *
 * Contract source: docs/reference/aws/models.md.
 *
 * Exports under test: M3LAWSCredentialsErrorType,
 *   M3LAWSCredentialsErrorAnalysis, M3LAWSRetryContext, M3LAWSLoginResult,
 *   M3LAWSCredentialsManagerOptions (5 symbols).
 *
 * `aws/models` is a dependency-free, types-only shared-vocabulary layer: no
 * functions, no thrown errors. `M3LAWSCredentialsErrorType` is the only
 * export with a runtime value (a `const` object, the project's
 * enum-replacement convention); the other four are compile-time-only
 * interface shapes, verified entirely with `expectTypeOf`. The "failure
 * path" for this module is the negative type assertion: an out-of-union
 * string or a malformed shape must be rejected at the type level.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LAWSCredentialsErrorType } from "../src/aws/models/index.js";
import type {
  M3LAWSCredentialsErrorAnalysis,
  M3LAWSCredentialsManagerOptions,
  M3LAWSLoginResult,
  M3LAWSRetryContext,
} from "../src/aws/models/index.js";
import type { M3LPrompt } from "../src/core/prompt/index.js";

// =============================================================================
// M3LAWSCredentialsErrorType — const object + derived union
// =============================================================================
describe("M3LAWSCredentialsErrorType", () => {
  test.each([
    ["SSO_SESSION_EXPIRED", "SSO_SESSION_EXPIRED"],
    ["SSO_SESSION_INVALID", "SSO_SESSION_INVALID"],
    ["CREDENTIALS_PROVIDER_FAILED", "CREDENTIALS_PROVIDER_FAILED"],
    ["PROFILE_NOT_FOUND", "PROFILE_NOT_FOUND"],
    ["UNKNOWN", "UNKNOWN"],
  ] as const)("member %s is accessible as the value %j", (member, value) => {
    expect(M3LAWSCredentialsErrorType[member]).toBe(value);
  });

  test("exposes exactly the 5 documented members — no extras, no missing", () => {
    expect(Object.keys(M3LAWSCredentialsErrorType).sort()).toEqual(
      [
        "SSO_SESSION_EXPIRED",
        "SSO_SESSION_INVALID",
        "CREDENTIALS_PROVIDER_FAILED",
        "PROFILE_NOT_FOUND",
        "UNKNOWN",
      ].sort(),
    );
  });

  describe("type-level contract", () => {
    test("is a narrow union of its 5 string literal members — no wider, no narrower", () => {
      expectTypeOf<M3LAWSCredentialsErrorType>().toEqualTypeOf<
        | "SSO_SESSION_EXPIRED"
        | "SSO_SESSION_INVALID"
        | "CREDENTIALS_PROVIDER_FAILED"
        | "PROFILE_NOT_FOUND"
        | "UNKNOWN"
      >();
    });

    test("rejects an out-of-set string literal", () => {
      expectTypeOf<"NOT_A_REAL_MEMBER">().not.toMatchTypeOf<M3LAWSCredentialsErrorType>();
    });

    test("is not the general `string` type (a plain string is rejected)", () => {
      expectTypeOf<string>().not.toMatchTypeOf<M3LAWSCredentialsErrorType>();
    });
  });
});

// =============================================================================
// M3LAWSCredentialsErrorAnalysis — interface
// =============================================================================
describe("M3LAWSCredentialsErrorAnalysis", () => {
  test("a value literal with all fields satisfies the interface", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
      recoverable: true,
    };
    expect(analysis.type).toBe("SSO_SESSION_EXPIRED");
    expect(analysis.recoverable).toBe(true);
  });

  test("cause accepts a non-Error value (string) — the channel is not over-constrained to Error", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      type: M3LAWSCredentialsErrorType.UNKNOWN,
      recoverable: false,
      cause: "raw string cause",
    };
    expect(analysis.cause).toBe("raw string cause");
  });

  test("cause accepts a plain object value", () => {
    const causeObject = { code: "ETIMEDOUT" };
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      type: M3LAWSCredentialsErrorType.CREDENTIALS_PROVIDER_FAILED,
      recoverable: false,
      cause: causeObject,
    };
    expect(analysis.cause).toBe(causeObject);
  });

  describe("type-level contract", () => {
    test("type field is the M3LAWSCredentialsErrorType union, not string", () => {
      expectTypeOf<M3LAWSCredentialsErrorAnalysis>()
        .toHaveProperty("type")
        .toEqualTypeOf<M3LAWSCredentialsErrorType>();
    });

    test("type field rejects an arbitrary out-of-union string", () => {
      expectTypeOf<{
        type: "totally-made-up";
        recoverable: boolean;
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("recoverable field is boolean", () => {
      expectTypeOf<M3LAWSCredentialsErrorAnalysis>()
        .toHaveProperty("recoverable")
        .toEqualTypeOf<boolean>();
    });

    test("cause field is optional unknown, not required Error", () => {
      expectTypeOf<M3LAWSCredentialsErrorAnalysis>()
        .toHaveProperty("cause")
        .toEqualTypeOf<unknown>();

      // Optional: omitting `cause` entirely must still satisfy the interface.
      expectTypeOf<{
        type: M3LAWSCredentialsErrorType;
        recoverable: boolean;
      }>().toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("type and recoverable are required — omitting either is rejected", () => {
      expectTypeOf<{
        recoverable: boolean;
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
      expectTypeOf<{
        type: M3LAWSCredentialsErrorType;
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });
  });
});

// =============================================================================
// M3LAWSRetryContext — interface
// =============================================================================
describe("M3LAWSRetryContext", () => {
  test("a value literal with all required fields satisfies the interface", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      type: M3LAWSCredentialsErrorType.PROFILE_NOT_FOUND,
      recoverable: false,
    };
    const context: M3LAWSRetryContext = {
      attempt: 1,
      maxAttempts: 3,
      analysis,
    };
    expect(context.attempt).toBe(1);
    expect(context.maxAttempts).toBe(3);
    expect(context.analysis).toBe(analysis);
  });

  describe("type-level contract", () => {
    test("attempt and maxAttempts are number", () => {
      expectTypeOf<M3LAWSRetryContext>()
        .toHaveProperty("attempt")
        .toEqualTypeOf<number>();
      expectTypeOf<M3LAWSRetryContext>()
        .toHaveProperty("maxAttempts")
        .toEqualTypeOf<number>();
    });

    test("analysis is M3LAWSCredentialsErrorAnalysis", () => {
      expectTypeOf<M3LAWSRetryContext>()
        .toHaveProperty("analysis")
        .toEqualTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("all three fields are required — omitting any one is rejected", () => {
      expectTypeOf<{
        maxAttempts: number;
        analysis: M3LAWSCredentialsErrorAnalysis;
      }>().not.toMatchTypeOf<M3LAWSRetryContext>();
      expectTypeOf<{
        attempt: number;
        analysis: M3LAWSCredentialsErrorAnalysis;
      }>().not.toMatchTypeOf<M3LAWSRetryContext>();
      expectTypeOf<{
        attempt: number;
        maxAttempts: number;
      }>().not.toMatchTypeOf<M3LAWSRetryContext>();
    });
  });
});

// =============================================================================
// M3LAWSLoginResult — interface
// =============================================================================
describe("M3LAWSLoginResult", () => {
  test("a value literal with all required fields satisfies the interface", () => {
    const result: M3LAWSLoginResult = {
      profile: "default",
      success: true,
      durationMs: 1500,
      exitCode: 0,
      timedOut: false,
    };
    expect(result.profile).toBe("default");
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(1500);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  describe("type-level contract", () => {
    test("profile is string, success is boolean, durationMs is number", () => {
      expectTypeOf<M3LAWSLoginResult>()
        .toHaveProperty("profile")
        .toEqualTypeOf<string>();
      expectTypeOf<M3LAWSLoginResult>()
        .toHaveProperty("success")
        .toEqualTypeOf<boolean>();
      expectTypeOf<M3LAWSLoginResult>()
        .toHaveProperty("durationMs")
        .toEqualTypeOf<number>();
    });

    test("profile, success, durationMs are required — omitting any one is rejected", () => {
      expectTypeOf<{
        success: boolean;
        durationMs: number;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
      expectTypeOf<{
        profile: string;
        durationMs: number;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
      expectTypeOf<{
        profile: string;
        success: boolean;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
    });

    test("exitCode is required number | null (nullable, not optional)", () => {
      expectTypeOf<M3LAWSLoginResult>()
        .toHaveProperty("exitCode")
        .toEqualTypeOf<number | null>();

      // Required: omitting `exitCode` entirely is rejected.
      expectTypeOf<{
        profile: string;
        success: boolean;
        durationMs: number;
        timedOut: boolean;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
    });

    test("timedOut is required boolean", () => {
      expectTypeOf<M3LAWSLoginResult>()
        .toHaveProperty("timedOut")
        .toEqualTypeOf<boolean>();

      // Required: omitting `timedOut` entirely is rejected.
      expectTypeOf<{
        profile: string;
        success: boolean;
        durationMs: number;
        exitCode: number | null;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
    });
  });
});

// =============================================================================
// M3LAWSCredentialsManagerOptions — interface, all fields optional
// =============================================================================
describe("M3LAWSCredentialsManagerOptions", () => {
  test("an empty object literal satisfies the interface (every field optional)", () => {
    const options: M3LAWSCredentialsManagerOptions = {};
    expect(options).toEqual({});
  });

  test("a fully-populated object literal satisfies the interface", () => {
    const options: M3LAWSCredentialsManagerOptions = {
      profile: "default",
      loginTimeoutMs: 60000,
      interactive: false,
    };
    expect(options.profile).toBe("default");
    expect(options.loginTimeoutMs).toBe(60000);
    expect(options.interactive).toBe(false);
  });

  test("a partial object literal (only one field) satisfies the interface", () => {
    const options: M3LAWSCredentialsManagerOptions = { profile: "sandbox" };
    expect(options.profile).toBe("sandbox");
    expect(options.loginTimeoutMs).toBeUndefined();
    expect(options.interactive).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("`{}` is assignable — all three fields are optional, not required", () => {
      expectTypeOf<
        Record<string, never>
      >().toMatchTypeOf<M3LAWSCredentialsManagerOptions>();
    });

    test("profile is optional string, loginTimeoutMs is optional number, interactive is optional boolean", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("profile")
        .toEqualTypeOf<string | undefined>();
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("loginTimeoutMs")
        .toEqualTypeOf<number | undefined>();
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("interactive")
        .toEqualTypeOf<boolean | undefined>();
    });

    test("region is optional string", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("region")
        .toEqualTypeOf<string | undefined>();

      // Optional: omitting `region` entirely must still satisfy the interface.
      expectTypeOf<{
        profile?: string;
        loginTimeoutMs?: number;
        interactive?: boolean;
      }>().toMatchTypeOf<M3LAWSCredentialsManagerOptions>();
    });

    test("maxRetries is optional number", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("maxRetries")
        .toEqualTypeOf<number | undefined>();
    });

    test("prompt is optional M3LPrompt — the type-only cross-module import", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("prompt")
        .toEqualTypeOf<M3LPrompt | undefined>();
    });
  });
});
