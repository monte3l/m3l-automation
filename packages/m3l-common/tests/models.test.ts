/**
 * Tests for aws/models submodule.
 *
 * Contract source: docs/reference/aws/models.md.
 *
 * Exports under test: M3LAWSRegion, M3LAWSProfile, parseAWSRegion,
 *   parseAWSProfile, isAWSRegion, isAWSProfile, M3LAWSIdentityError,
 *   M3LAWSIdentityErrorCode, M3LAWSCredentialsErrorType,
 *   M3LAWSCredentialsErrorAnalysis, M3LAWSRetryContext, M3LAWSLoginResult,
 *   M3LAWSCredentialsManagerOptions (13 symbols).
 *
 * `aws/models` is a dependency-free, types-only shared-vocabulary layer, plus
 * the small runtime identity brands (`parseAWSRegion`/`parseAWSProfile`, the
 * `is*` guards, and `M3LAWSIdentityError`). `M3LAWSCredentialsErrorType` is a
 * runtime `const` object (the project's enum-replacement convention); the
 * credential-analysis/retry/login/options symbols are compile-time-only
 * interface shapes, verified entirely with `expectTypeOf`. The "failure path"
 * for the pure-type symbols is the negative type assertion: an out-of-union
 * string or a malformed shape must be rejected at the type level. The
 * identity brands additionally have a real runtime failure path
 * (`M3LAWSIdentityError`) exercised below.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  isAWSProfile,
  isAWSRegion,
  M3LAWSCredentialsErrorType,
  M3LAWSIdentityError,
  parseAWSProfile,
  parseAWSRegion,
} from "../src/aws/models/index.js";
import type {
  M3LAWSCredentialsErrorAnalysis,
  M3LAWSCredentialsManagerOptions,
  M3LAWSIdentityErrorCode,
  M3LAWSLoginResult,
  M3LAWSProfile,
  M3LAWSRegion,
  M3LAWSRetryContext,
} from "../src/aws/models/index.js";
import type { M3LPrompt } from "../src/core/prompt/index.js";

// =============================================================================
// AWS identity brands — M3LAWSRegion / M3LAWSProfile
// =============================================================================

/** Documented-valid AWS region strings. */
const VALID_REGIONS = ["eu-south-1", "us-east-1", "us-gov-east-1"] as const;

/** Documented-invalid AWS region strings. */
const INVALID_REGIONS = [
  "",
  " eu-south-1 ",
  "EU-SOUTH-1",
  "eu-south",
  "-south-1",
  "my-profile",
] as const;

/** Documented-valid AWS profile strings. */
const VALID_PROFILES = ["my-profile", "profile-a", "default"] as const;

/** Documented-invalid AWS profile strings. */
const INVALID_PROFILES = [
  "",
  " my-profile ",
  "my-profile\t",
  "my profile",
  "a\nb",
] as const;

describe("parseAWSRegion", () => {
  test.each(VALID_REGIONS)(
    "accepts and brands the valid region %j",
    (value) => {
      expect(parseAWSRegion(value)).toBe(value);
    },
  );

  test.each(INVALID_REGIONS)(
    "throws M3LAWSIdentityError with code ERR_AWS_INVALID_REGION for %j",
    (value) => {
      let thrown: unknown;
      try {
        parseAWSRegion(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect(thrown).toBeInstanceOf(M3LAWSIdentityError);
      expect((thrown as M3LAWSIdentityError).code).toBe(
        "ERR_AWS_INVALID_REGION",
      );
    },
  );

  test("does not carry a `cause` — an invalid region string has no underlying failure to chain", () => {
    let thrown: unknown;
    try {
      parseAWSRegion("not-a-region!!!");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAWSIdentityError).cause).toBeUndefined();
  });
});

describe("isAWSRegion", () => {
  test.each(VALID_REGIONS)("returns true for the valid region %j", (value) => {
    expect(isAWSRegion(value)).toBe(true);
  });

  test.each(INVALID_REGIONS)(
    "returns false for the invalid region %j",
    (value) => {
      expect(isAWSRegion(value)).toBe(false);
    },
  );
});

describe("parseAWSRegion / isAWSRegion equivalence", () => {
  test.each(VALID_REGIONS)(
    "a valid region BOTH passes the guard and parses without throwing: %j",
    (value) => {
      expect(isAWSRegion(value)).toBe(true);
      expect(() => parseAWSRegion(value)).not.toThrow();
    },
  );

  test.each(INVALID_REGIONS)(
    "an invalid region BOTH fails the guard and throws on parse: %j",
    (value) => {
      expect(isAWSRegion(value)).toBe(false);
      expect(() => parseAWSRegion(value)).toThrow(M3LAWSIdentityError);
    },
  );
});

describe("parseAWSProfile", () => {
  test.each(VALID_PROFILES)(
    "accepts and brands the valid profile %j",
    (value) => {
      expect(parseAWSProfile(value)).toBe(value);
    },
  );

  test.each(INVALID_PROFILES)(
    "throws M3LAWSIdentityError with code ERR_AWS_INVALID_PROFILE for %j",
    (value) => {
      let thrown: unknown;
      try {
        parseAWSProfile(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect(thrown).toBeInstanceOf(M3LAWSIdentityError);
      expect((thrown as M3LAWSIdentityError).code).toBe(
        "ERR_AWS_INVALID_PROFILE",
      );
    },
  );

  test("does not carry a `cause` — an invalid profile string has no underlying failure to chain", () => {
    let thrown: unknown;
    try {
      parseAWSProfile("");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAWSIdentityError).cause).toBeUndefined();
  });
});

describe("isAWSProfile", () => {
  test.each(VALID_PROFILES)(
    "returns true for the valid profile %j",
    (value) => {
      expect(isAWSProfile(value)).toBe(true);
    },
  );

  test.each(INVALID_PROFILES)(
    "returns false for the invalid profile %j",
    (value) => {
      expect(isAWSProfile(value)).toBe(false);
    },
  );
});

describe("parseAWSProfile / isAWSProfile equivalence", () => {
  test.each(VALID_PROFILES)(
    "a valid profile BOTH passes the guard and parses without throwing: %j",
    (value) => {
      expect(isAWSProfile(value)).toBe(true);
      expect(() => parseAWSProfile(value)).not.toThrow();
    },
  );

  test.each(INVALID_PROFILES)(
    "an invalid profile BOTH fails the guard and throws on parse: %j",
    (value) => {
      expect(isAWSProfile(value)).toBe(false);
      expect(() => parseAWSProfile(value)).toThrow(M3LAWSIdentityError);
    },
  );
});

describe("M3LAWSIdentityError", () => {
  test("is an instance of both M3LError and Error", () => {
    let thrown: unknown;
    try {
      parseAWSRegion("");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(Error);
  });

  describe("type-level contract", () => {
    test("M3LAWSIdentityErrorCode is exactly the two documented literals", () => {
      expectTypeOf<M3LAWSIdentityErrorCode>().toEqualTypeOf<
        "ERR_AWS_INVALID_REGION" | "ERR_AWS_INVALID_PROFILE"
      >();
    });

    test("code narrows to M3LAWSIdentityErrorCode, not a plain string", () => {
      expectTypeOf<
        M3LAWSIdentityError["code"]
      >().toEqualTypeOf<M3LAWSIdentityErrorCode>();
      expectTypeOf<string>().not.toMatchTypeOf<M3LAWSIdentityErrorCode>();
    });
  });
});

describe("M3LAWSRegion / M3LAWSProfile — type-level contract", () => {
  test("parseAWSRegion returns M3LAWSRegion, not a bare string", () => {
    expectTypeOf(parseAWSRegion).returns.toEqualTypeOf<M3LAWSRegion>();
    expectTypeOf(parseAWSRegion).returns.not.toEqualTypeOf<string>();
  });

  test("parseAWSProfile returns M3LAWSProfile, not a bare string", () => {
    expectTypeOf(parseAWSProfile).returns.toEqualTypeOf<M3LAWSProfile>();
    expectTypeOf(parseAWSProfile).returns.not.toEqualTypeOf<string>();
  });

  test("M3LAWSRegion is NOT assignable from a bare string", () => {
    expectTypeOf<string>().not.toMatchTypeOf<M3LAWSRegion>();
  });

  test("M3LAWSProfile is NOT assignable from a bare string", () => {
    expectTypeOf<string>().not.toMatchTypeOf<M3LAWSProfile>();
  });

  test("M3LAWSRegion is NOT assignable to M3LAWSProfile", () => {
    expectTypeOf<M3LAWSRegion>().not.toMatchTypeOf<M3LAWSProfile>();
  });

  test("M3LAWSProfile is NOT assignable to M3LAWSRegion", () => {
    expectTypeOf<M3LAWSProfile>().not.toMatchTypeOf<M3LAWSRegion>();
  });

  test("both brands ARE assignable to string", () => {
    expectTypeOf<M3LAWSRegion>().toMatchTypeOf<string>();
    expectTypeOf<M3LAWSProfile>().toMatchTypeOf<string>();
  });

  test("isAWSRegion narrows a string parameter to M3LAWSRegion", () => {
    function useRegion(value: string): M3LAWSRegion | undefined {
      if (isAWSRegion(value)) {
        expectTypeOf(value).toEqualTypeOf<M3LAWSRegion>();
        return value;
      }
      return undefined;
    }
    expect(useRegion("eu-south-1")).toBe("eu-south-1");
  });

  test("isAWSProfile narrows a string parameter to M3LAWSProfile", () => {
    function useProfile(value: string): M3LAWSProfile | undefined {
      if (isAWSProfile(value)) {
        expectTypeOf(value).toEqualTypeOf<M3LAWSProfile>();
        return value;
      }
      return undefined;
    }
    expect(useProfile("my-profile")).toBe("my-profile");
  });
});

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
// M3LAWSCredentialsErrorAnalysis — discriminated union on `recoverable`
// =============================================================================
describe("M3LAWSCredentialsErrorAnalysis", () => {
  test("a recoverable=true value literal with a recoverable-arm type satisfies the union", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      recoverable: true,
      type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
    };
    expect(analysis.type).toBe("SSO_SESSION_EXPIRED");
    expect(analysis.recoverable).toBe(true);
  });

  test("a recoverable=false value literal with an unrecoverable-arm type satisfies the union", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      recoverable: false,
      type: M3LAWSCredentialsErrorType.PROFILE_NOT_FOUND,
    };
    expect(analysis.type).toBe("PROFILE_NOT_FOUND");
    expect(analysis.recoverable).toBe(false);
  });

  test("cause accepts a non-Error value (string) — the channel is not over-constrained to Error", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      recoverable: false,
      type: M3LAWSCredentialsErrorType.UNKNOWN,
      cause: "raw string cause",
    };
    expect(analysis.cause).toBe("raw string cause");
  });

  test("cause accepts a plain object value", () => {
    const causeObject = { code: "ETIMEDOUT" };
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      recoverable: true,
      type: M3LAWSCredentialsErrorType.CREDENTIALS_PROVIDER_FAILED,
      cause: causeObject,
    };
    expect(analysis.cause).toBe(causeObject);
  });

  test("narrows `type` to the unrecoverable arm inside a `recoverable === false` guard", () => {
    const analysis: M3LAWSCredentialsErrorAnalysis = {
      recoverable: false,
      type: M3LAWSCredentialsErrorType.UNKNOWN,
    };
    if (analysis.recoverable === false) {
      expectTypeOf(analysis.type).toEqualTypeOf<
        "PROFILE_NOT_FOUND" | "UNKNOWN"
      >();
    } else {
      expect.unreachable("recoverable literal false must narrow this branch");
    }
  });

  describe("type-level contract", () => {
    test("a recoverable=true arm with a recoverable category is assignable", () => {
      expectTypeOf<{
        readonly recoverable: true;
        readonly type: "SSO_SESSION_EXPIRED";
      }>().toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("a recoverable=false arm with an unrecoverable category is assignable", () => {
      expectTypeOf<{
        readonly recoverable: false;
        readonly type: "PROFILE_NOT_FOUND";
      }>().toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("rejects recoverable=true paired with an unrecoverable-only category", () => {
      // @ts-expect-error -- "PROFILE_NOT_FOUND" only belongs to the recoverable:false arm
      const impossible: M3LAWSCredentialsErrorAnalysis = {
        recoverable: true,
        type: "PROFILE_NOT_FOUND",
      };
      expect(impossible).toBeDefined();
    });

    test("rejects recoverable=false paired with a recoverable-only category", () => {
      // @ts-expect-error -- "SSO_SESSION_EXPIRED" only belongs to the recoverable:true arm
      const impossible: M3LAWSCredentialsErrorAnalysis = {
        recoverable: false,
        type: "SSO_SESSION_EXPIRED",
      };
      expect(impossible).toBeDefined();
    });

    test("type field rejects an arbitrary out-of-union string in either arm", () => {
      expectTypeOf<{
        readonly recoverable: true;
        readonly type: "totally-made-up";
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
      expectTypeOf<{
        readonly recoverable: false;
        readonly type: "totally-made-up";
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("cause is optional unknown in both arms — omitting it still satisfies the union", () => {
      expectTypeOf<{
        readonly recoverable: true;
        readonly type: "SSO_SESSION_EXPIRED";
      }>().toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
      expectTypeOf<{
        readonly recoverable: false;
        readonly type: "UNKNOWN";
      }>().toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
    });

    test("recoverable and type are both required — omitting either is rejected", () => {
      expectTypeOf<{
        readonly recoverable: true;
      }>().not.toMatchTypeOf<M3LAWSCredentialsErrorAnalysis>();
      expectTypeOf<{
        readonly type: "SSO_SESSION_EXPIRED";
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
// M3LAWSLoginResult — discriminated union on `outcome`
// =============================================================================
describe("M3LAWSLoginResult", () => {
  test("a success-arm value literal satisfies the union", () => {
    const result: M3LAWSLoginResult = {
      outcome: "success",
      exitCode: 0,
      profile: parseAWSProfile("default"),
      durationMs: 1500,
    };
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.profile).toBe("default");
    expect(result.durationMs).toBe(1500);
  });

  test("a failed-arm value literal with a non-zero exit code satisfies the union", () => {
    const result: M3LAWSLoginResult = {
      outcome: "failed",
      exitCode: 1,
      profile: parseAWSProfile("default"),
      durationMs: 2000,
    };
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  test("a timedOut-arm value literal with a null exit code satisfies the union", () => {
    const result: M3LAWSLoginResult = {
      outcome: "timedOut",
      exitCode: null,
      profile: parseAWSProfile("default"),
      durationMs: 120_000,
    };
    expect(result.outcome).toBe("timedOut");
    expect(result.exitCode).toBeNull();
  });

  test("a `switch` over `outcome` is exhaustive — every arm handled, no fallthrough default", () => {
    function describeOutcome(result: M3LAWSLoginResult): string {
      switch (result.outcome) {
        case "success":
          return `success in ${String(result.durationMs)}ms`;
        case "failed":
          return `failed with exit code ${String(result.exitCode)}`;
        case "timedOut":
          return `timed out after ${String(result.durationMs)}ms`;
        default: {
          const unreachable: never = result;
          throw new Error(`unhandled outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    expect(
      describeOutcome({
        outcome: "success",
        exitCode: 0,
        profile: parseAWSProfile("p"),
        durationMs: 1,
      }),
    ).toContain("success");
    expect(
      describeOutcome({
        outcome: "failed",
        exitCode: 1,
        profile: parseAWSProfile("p"),
        durationMs: 1,
      }),
    ).toContain("failed");
    expect(
      describeOutcome({
        outcome: "timedOut",
        exitCode: null,
        profile: parseAWSProfile("p"),
        durationMs: 1,
      }),
    ).toContain("timed out");
  });

  describe("type-level contract", () => {
    test("profile and durationMs are shared across every arm", () => {
      expectTypeOf<M3LAWSLoginResult>().toHaveProperty("profile");
      expectTypeOf<M3LAWSLoginResult>().toHaveProperty("durationMs");
    });

    test("outcome, exitCode, profile, durationMs are required — omitting any one is rejected", () => {
      expectTypeOf<{
        readonly exitCode: 0;
        readonly profile: string;
        readonly durationMs: number;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
      expectTypeOf<{
        readonly outcome: "success";
        readonly profile: string;
        readonly durationMs: number;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
      expectTypeOf<{
        readonly outcome: "success";
        readonly exitCode: 0;
        readonly durationMs: number;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
      expectTypeOf<{
        readonly outcome: "success";
        readonly exitCode: 0;
        readonly profile: string;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
    });

    test("rejects outcome:'success' paired with a non-zero exitCode", () => {
      // @ts-expect-error -- only exitCode: 0 belongs to the "success" arm
      const impossible: M3LAWSLoginResult = {
        outcome: "success",
        exitCode: 1,
        profile: parseAWSProfile("default"),
        durationMs: 1500,
      };
      expect(impossible).toBeDefined();
    });

    test("rejects outcome:'timedOut' paired with a non-null exitCode", () => {
      // @ts-expect-error -- only exitCode: null belongs to the "timedOut" arm
      const impossible: M3LAWSLoginResult = {
        outcome: "timedOut",
        exitCode: 0,
        profile: parseAWSProfile("default"),
        durationMs: 120_000,
      };
      expect(impossible).toBeDefined();
    });

    test("a failed-arm value literal with a non-zero exitCode satisfies the union", () => {
      const result: M3LAWSLoginResult = {
        outcome: "failed",
        exitCode: 3,
        profile: parseAWSProfile("default"),
        durationMs: 2000,
      };
      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBe(3);
    });

    test("a failed-arm value literal with a null exitCode (external signal kill) satisfies the union", () => {
      const result: M3LAWSLoginResult = {
        outcome: "failed",
        exitCode: null,
        profile: parseAWSProfile("default"),
        durationMs: 2000,
      };
      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBeNull();
    });

    test("rejects an object still carrying the old flat `success`/`timedOut` booleans", () => {
      expectTypeOf<{
        readonly profile: string;
        readonly success: boolean;
        readonly durationMs: number;
        readonly exitCode: number | null;
        readonly timedOut: boolean;
      }>().not.toMatchTypeOf<M3LAWSLoginResult>();
    });

    test("rejects an out-of-union `outcome` string literal", () => {
      expectTypeOf<{
        readonly outcome: "cancelled";
        readonly exitCode: 0;
        readonly profile: string;
        readonly durationMs: number;
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
      profile: parseAWSProfile("default"),
      loginTimeoutMs: 60000,
      interactive: false,
    };
    expect(options.profile).toBe("default");
    expect(options.loginTimeoutMs).toBe(60000);
    expect(options.interactive).toBe(false);
  });

  test("a partial object literal (only one field) satisfies the interface", () => {
    const options: M3LAWSCredentialsManagerOptions = {
      profile: parseAWSProfile("sandbox"),
    };
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

    test("profile is optional M3LAWSProfile, loginTimeoutMs is optional number, interactive is optional boolean", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("profile")
        .toEqualTypeOf<M3LAWSProfile | undefined>();
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("loginTimeoutMs")
        .toEqualTypeOf<number | undefined>();
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("interactive")
        .toEqualTypeOf<boolean | undefined>();
    });

    test("region is optional M3LAWSRegion", () => {
      expectTypeOf<M3LAWSCredentialsManagerOptions>()
        .toHaveProperty("region")
        .toEqualTypeOf<M3LAWSRegion | undefined>();

      // Optional: omitting `region` entirely must still satisfy the interface.
      expectTypeOf<{
        profile?: M3LAWSProfile;
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
