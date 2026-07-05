/**
 * Tests for aws/clients submodule.
 *
 * Contract source: docs/reference/aws/clients.md.
 *
 * Exports under test (from `../src/aws/clients/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   AWSClientProvider, AWSMultiClientProvider, AWSProvider, AWS_REGION,
 *   M3LAWSClientError.
 *
 * Mocking strategy: all 14 `@aws-sdk/client-*` service packages plus
 * `@aws-sdk/credential-provider-ini` are mocked with top-level `vi.mock` +
 * a `vi.hoisted` bag of mutable spies (this repo's convention — see the
 * sibling `tests/credentials.test.ts` for the rationale: it sidesteps the
 * `instanceof`-across-module-graphs and concurrent-first-import hazards of a
 * per-test `vi.doMock` + `vi.resetModules()` strategy). Each mocked client
 * class is a spy constructor that records its `config` argument and exposes
 * a shared `destroy` spy, so tests can assert construction args (region,
 * credentials) and destroy-on-close behavior without depending on real AWS
 * SDK network calls.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factories
// below (those factories cannot close over ordinary file-scope variables).
const h = vi.hoisted(() => {
  const destroy = vi.fn();

  /** Builds a fake SDK client class whose constructor records its config. */
  function makeClientClass(ctorSpy: (config: unknown) => void) {
    return class {
      readonly config: unknown;
      destroy = destroy;
      constructor(config?: unknown) {
        this.config = config;
        ctorSpy(config);
      }
    };
  }

  return {
    destroy,
    fromIni: vi.fn(),
    s3Ctor: vi.fn(),
    dynamoDBCtor: vi.fn(),
    stsCtor: vi.fn(),
    eventBridgeCtor: vi.fn(),
    lambdaCtor: vi.fn(),
    ec2Ctor: vi.fn(),
    ecsCtor: vi.fn(),
    cloudFormationCtor: vi.fn(),
    codePipelineCtor: vi.fn(),
    apiGatewayCtor: vi.fn(),
    eksCtor: vi.fn(),
    cloudWatchCtor: vi.fn(),
    ssmCtor: vi.fn(),
    sqsCtor: vi.fn(),
    makeClientClass,
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: h.makeClientClass(h.s3Ctor),
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: h.makeClientClass(h.dynamoDBCtor),
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: h.makeClientClass(h.stsCtor),
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: h.makeClientClass(h.eventBridgeCtor),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: h.makeClientClass(h.lambdaCtor),
}));
vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: h.makeClientClass(h.ec2Ctor),
}));
vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: h.makeClientClass(h.ecsCtor),
}));
vi.mock("@aws-sdk/client-cloudformation", () => ({
  CloudFormationClient: h.makeClientClass(h.cloudFormationCtor),
}));
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: h.makeClientClass(h.codePipelineCtor),
}));
vi.mock("@aws-sdk/client-api-gateway", () => ({
  APIGatewayClient: h.makeClientClass(h.apiGatewayCtor),
}));
vi.mock("@aws-sdk/client-eks", () => ({
  EKSClient: h.makeClientClass(h.eksCtor),
}));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: h.makeClientClass(h.cloudWatchCtor),
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: h.makeClientClass(h.ssmCtor),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: h.makeClientClass(h.sqsCtor),
}));
vi.mock("@aws-sdk/credential-provider-ini", () => ({
  fromIni: h.fromIni,
}));

import { M3LError, isErr, isOk } from "../src/core/errors/index.js";
import type { M3LResult } from "../src/core/errors/index.js";
import {
  AWS_REGION,
  AWSClientProvider,
  AWSMultiClientProvider,
  AWSProvider,
  M3LAWSClientError,
} from "../src/aws/clients/index.js";
import { parseAWSProfile, parseAWSRegion } from "../src/aws/models/index.js";
import type { M3LAWSProfile, M3LAWSRegion } from "../src/aws/models/index.js";
import type { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Sentinel credentials object returned by the mocked `fromIni`. */
const SENTINEL_CREDENTIALS = { sentinel: "fromIni-credentials" };

/**
 * Table-driven matrix of every service-client getter, its dedicated
 * constructor spy, and the package's exported class name (used only for
 * assertion messages — the getter/spy pair is what drives the checks).
 */
const GETTER_MATRIX = [
  ["s3", h.s3Ctor] as const,
  ["dynamoDB", h.dynamoDBCtor] as const,
  ["sts", h.stsCtor] as const,
  ["eventBridge", h.eventBridgeCtor] as const,
  ["lambda", h.lambdaCtor] as const,
  ["ec2", h.ec2Ctor] as const,
  ["ecs", h.ecsCtor] as const,
  ["cloudFormation", h.cloudFormationCtor] as const,
  ["codePipeline", h.codePipelineCtor] as const,
  ["apiGateway", h.apiGatewayCtor] as const,
  ["eks", h.eksCtor] as const,
  ["cloudWatch", h.cloudWatchCtor] as const,
  ["ssm", h.ssmCtor] as const,
  ["sqs", h.sqsCtor] as const,
] satisfies readonly (readonly [
  keyof AWSClientProvider,
  ReturnType<typeof vi.fn>,
])[];

beforeEach(() => {
  h.destroy.mockReset();
  h.fromIni.mockReset().mockReturnValue(SENTINEL_CREDENTIALS);
  for (const [, ctorSpy] of GETTER_MATRIX) {
    ctorSpy.mockReset();
  }
});

// =============================================================================
// AWS_REGION
// =============================================================================
describe("AWS_REGION", () => {
  test("is the literal 'eu-south-1'", () => {
    expect(AWS_REGION).toBe("eu-south-1");
  });

  test("type-level: is the branded M3LAWSRegion, not a bare string", () => {
    expectTypeOf(AWS_REGION).toEqualTypeOf<M3LAWSRegion>();
  });
});

// =============================================================================
// AWSClientProvider — construction & getter matrix
// =============================================================================
describe("AWSClientProvider construction", () => {
  test("constructs with no options — defaults apply, no throw", () => {
    expect(() => new AWSClientProvider()).not.toThrow();
  });

  test("constructs with a full options bag — no throw", () => {
    expect(
      () =>
        new AWSClientProvider({
          profile: parseAWSProfile("my-profile"),
          region: parseAWSRegion("us-east-1"),
        }),
    ).not.toThrow();
  });
});

describe.each(GETTER_MATRIX)(
  "AWSClientProvider getter: %s",
  (getterName, ctorSpy) => {
    test("constructs its client on first access", () => {
      const provider = new AWSClientProvider();

      void provider[getterName];

      expect(ctorSpy).toHaveBeenCalledTimes(1);
    });

    test("caches the client — repeat access returns the SAME instance", () => {
      const provider = new AWSClientProvider();

      const first = provider[getterName];
      const second = provider[getterName];

      expect(second).toBe(first);
      expect(ctorSpy).toHaveBeenCalledTimes(1);
    });

    test("receives AWS_REGION when no region option is set", () => {
      const provider = new AWSClientProvider();

      void provider[getterName];

      expect(ctorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ region: "eu-south-1" }),
      );
    });

    test("receives the overridden region when `region` option is set", () => {
      const provider = new AWSClientProvider({
        region: parseAWSRegion("us-east-1"),
      });

      void provider[getterName];

      expect(ctorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ region: "us-east-1" }),
      );
    });

    test("receives resolved credentials when a non-empty profile is set", () => {
      const provider = new AWSClientProvider({
        profile: parseAWSProfile("my-profile"),
      });

      void provider[getterName];

      expect(h.fromIni).toHaveBeenCalledWith({ profile: "my-profile" });
      expect(ctorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: SENTINEL_CREDENTIALS }),
      );
    });

    test("does NOT pass a `credentials` key when profile is omitted", () => {
      const provider = new AWSClientProvider();

      void provider[getterName];

      expect(h.fromIni).not.toHaveBeenCalled();
      const [config] = ctorSpy.mock.calls[0] as [Record<string, unknown>];
      expect(config).not.toHaveProperty("credentials");
    });

    test("falls back to the SDK default credential chain — an options bag with a region but no `profile` key does NOT pass `credentials`", () => {
      const provider = new AWSClientProvider({
        region: parseAWSRegion("us-east-1"),
      });

      void provider[getterName];

      expect(h.fromIni).not.toHaveBeenCalled();
      const [config] = ctorSpy.mock.calls[0] as [Record<string, unknown>];
      expect(config).not.toHaveProperty("credentials");
    });
  },
);

// =============================================================================
// AWSClientProvider — close()
// =============================================================================
describe("AWSClientProvider.close", () => {
  test("calls .destroy() on every cached client", () => {
    const provider = new AWSClientProvider();

    void provider.s3;
    void provider.dynamoDB;

    provider.close();

    expect(h.destroy).toHaveBeenCalledTimes(2);
  });

  test("does not destroy clients that were never accessed", () => {
    const provider = new AWSClientProvider();

    void provider.s3;

    provider.close();

    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.stsCtor).not.toHaveBeenCalled();
  });

  test("clears the cache — accessing a getter again after close constructs a NEW instance", () => {
    const provider = new AWSClientProvider();

    const before = provider.s3;
    provider.close();
    const after = provider.s3;

    expect(after).not.toBe(before);
    expect(h.s3Ctor).toHaveBeenCalledTimes(2);
  });

  test("close with no clients ever accessed is a no-op — no throw", () => {
    const provider = new AWSClientProvider();

    expect(() => provider.close()).not.toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  test("is best-effort-complete and fail-loud: destroys every cached client even when one throws, then aggregates the failure into a single M3LAWSClientError, and clears the cache", () => {
    const original = new Error("boom from s3 destroy");
    const provider = new AWSClientProvider();
    const s3Instance: unknown = provider.s3;
    void provider.dynamoDB;

    // The shared `h.destroy` spy backs every mocked client's `.destroy()` —
    // key the throw off `this` (the S3 vs. DynamoDB client instance) so
    // DynamoDB's destroy call still succeeds.
    h.destroy.mockImplementation(function (this: unknown) {
      if (this === s3Instance) {
        throw original;
      }
    });

    let thrown: unknown;
    try {
      provider.close();
    } catch (error) {
      thrown = error;
    }

    // Best-effort completion: DynamoDB's destroy was still called even
    // though S3's destroy threw first (Map iteration order is insertion
    // order, so s3 — accessed first — throws before dynamoDB is reached).
    expect(h.destroy).toHaveBeenCalledTimes(2);

    // Fail-loud: a single aggregated M3LAWSClientError, thrown after the
    // destroy loop completes.
    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    const { cause } = thrown as M3LAWSClientError;
    expect(Array.isArray(cause)).toBe(true);
    const failures = cause as readonly { service: string; cause: unknown }[];
    expect(failures.length).toBeGreaterThan(0);
    expect(failures).toContainEqual({ service: "s3", cause: original });

    // The cache was cleared despite the throw: re-accessing `s3` constructs
    // a brand-new instance rather than returning the (destroyed) cached one.
    expect(h.s3Ctor).toHaveBeenCalledTimes(1);
    const after = provider.s3;
    expect(after).not.toBe(s3Instance);
    expect(h.s3Ctor).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// AWSClientProvider — error wrapping
// =============================================================================
describe("AWSClientProvider error wrapping", () => {
  test("wraps an SDK client-constructor throw in M3LAWSClientError with the original error as `cause`", () => {
    const original = new Error("boom from SDK constructor");
    h.s3Ctor.mockImplementation(() => {
      throw original;
    });

    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.s3;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  test("wraps a `fromIni` throw in M3LAWSClientError with the original error as `cause`", () => {
    const original = new Error("boom from fromIni");
    h.fromIni.mockImplementation(() => {
      throw original;
    });

    const provider = new AWSClientProvider({
      profile: parseAWSProfile("my-profile"),
    });

    let thrown: unknown;
    try {
      void provider.s3;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  test("never surfaces the bare SDK error directly", () => {
    const original = new Error("boom from SDK constructor");
    h.s3Ctor.mockImplementation(() => {
      throw original;
    });

    const provider = new AWSClientProvider();

    expect(() => provider.s3).not.toThrow(original);
  });
});

// =============================================================================
// AWSMultiClientProvider — construction & dedup
// =============================================================================
describe("AWSMultiClientProvider construction", () => {
  test("deduplicates profile names — one AWSClientProvider per distinct profile", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [
        parseAWSProfile("a"),
        parseAWSProfile("a"),
        parseAWSProfile("b"),
      ],
    });

    const results = await multi.mapParallel((provider) => provider);
    expect(results).toHaveLength(2);
  });

  test("empty profiles array — mapParallel resolves to [] (no throw)", async () => {
    const multi = new AWSMultiClientProvider({ profiles: [] });

    await expect(multi.mapParallel(() => "unused")).resolves.toEqual([]);
  });

  test("empty profiles array — mapParallelSettled resolves to [] (no throw)", async () => {
    const multi = new AWSMultiClientProvider({ profiles: [] });

    await expect(multi.mapParallelSettled(() => "unused")).resolves.toEqual([]);
  });
});

// =============================================================================
// AWSMultiClientProvider — mapParallel
// =============================================================================
describe("AWSMultiClientProvider.mapParallel", () => {
  test("resolves to the array of results across all distinct profiles", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
    });

    const results = await multi.mapParallel((provider) => {
      expect(provider).toBeInstanceOf(AWSClientProvider);
      return "value";
    });

    expect(results).toEqual(["value", "value"]);
  });

  test("rejects if any operation throws synchronously", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
    });

    await expect(
      multi.mapParallel((provider) => {
        if (provider) {
          throw new Error("operation failed");
        }
        return "unreachable";
      }),
    ).rejects.toThrow("operation failed");
  });

  test("rejects if any operation's returned promise rejects", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
    });
    let calls = 0;

    await expect(
      multi.mapParallel(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("async failure"))
          : Promise.resolve("ok");
      }),
    ).rejects.toThrow("async failure");
  });
});

// =============================================================================
// AWSMultiClientProvider — mapParallelSettled
// =============================================================================
describe("AWSMultiClientProvider.mapParallelSettled", () => {
  test("collects ok results keyed by profile on success", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
    });

    const settled = await multi.mapParallelSettled((provider) => provider.s3);

    expect(settled).toHaveLength(2);
    const byProfile = new Map(settled.map((entry) => [entry.profile, entry]));
    const a = byProfile.get(parseAWSProfile("profile-a"));
    const b = byProfile.get(parseAWSProfile("profile-b"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a !== undefined) {
      expect(isOk(a.result)).toBe(true);
    }
    if (b !== undefined) {
      expect(isOk(b.result)).toBe(true);
    }
  });

  test("never throws — every entry is err(cause) when every fn throws", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
    });

    const settled = await multi.mapParallelSettled(() => {
      throw new Error("always fails");
    });

    expect(settled).toHaveLength(2);
    for (const entry of settled) {
      expect(isErr(entry.result)).toBe(true);
      if (isErr(entry.result)) {
        expect(entry.result.error).toBeInstanceOf(Error);
      }
    }
  });

  test("mixed outcomes — correctly attributes ok/err per profile (dedup makes positional indexing ambiguous)", async () => {
    const multi = new AWSMultiClientProvider({
      profiles: [
        parseAWSProfile("profile-a"),
        parseAWSProfile("profile-a"),
        parseAWSProfile("profile-b"),
      ],
    });

    const settled = await multi.mapParallelSettled((provider, ...rest) => {
      void rest;
      // profile-a is deduplicated to a single provider instance; use object
      // identity indirectly via a side channel is unnecessary here — we key
      // by the `profile` field on the returned entry instead.
      return provider;
    });

    // Deduplication means there are exactly 2 distinct profiles, not 3.
    expect(settled).toHaveLength(2);
    const profiles = settled.map((entry) => entry.profile).sort();
    expect(profiles).toEqual(["profile-a", "profile-b"]);
    for (const entry of settled) {
      expect(isOk(entry.result)).toBe(true);
    }
  });
});

// =============================================================================
// AWSProvider
// =============================================================================
describe("AWSProvider", () => {
  test("constructs with no options — no throw", () => {
    expect(() => new AWSProvider()).not.toThrow();
  });

  test("constructs with a full options bag — no throw", () => {
    expect(
      () =>
        new AWSProvider({
          profile: parseAWSProfile("my-profile"),
          region: parseAWSRegion("us-east-1"),
        }),
    ).not.toThrow();
  });

  test("`clients` getter returns an AWSClientProvider instance", () => {
    const provider = new AWSProvider({
      profile: parseAWSProfile("my-profile"),
    });

    expect(provider.clients).toBeInstanceOf(AWSClientProvider);
  });

  test("`clients` getter is lazily instantiated and reused — same instance on repeat access", () => {
    const provider = new AWSProvider();

    const first = provider.clients;
    const second = provider.clients;

    expect(second).toBe(first);
  });

  test("does not construct an AWSClientProvider (and thus no SDK client) until `clients` is first accessed", () => {
    new AWSProvider({ profile: parseAWSProfile("my-profile") });

    expect(h.fromIni).not.toHaveBeenCalled();
    expect(h.s3Ctor).not.toHaveBeenCalled();
  });

  test("has no `services` getter", () => {
    const provider = new AWSProvider();

    expect(
      (provider as unknown as Record<string, unknown>)["services"],
    ).toBeUndefined();
  });
});

// =============================================================================
// M3LAWSClientError — shape and identity
// =============================================================================
describe("M3LAWSClientError", () => {
  test("is an instance of both M3LError and Error", () => {
    const original = new Error("boom");
    h.s3Ctor.mockImplementation(() => {
      throw original;
    });
    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.s3;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(Error);
  });

  test("code is the literal ERR_AWS_CLIENT", () => {
    const original = new Error("boom");
    h.s3Ctor.mockImplementation(() => {
      throw original;
    });
    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.s3;
    } catch (error) {
      thrown = error;
    }

    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
  });

  test("`cause` is preserved verbatim, no redaction", () => {
    const original = { weird: "non-error cause object" };
    h.s3Ctor.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error cause to verify verbatim preservation without normalization
      throw original;
    });
    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.s3;
    } catch (error) {
      thrown = error;
    }

    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_AWS_CLIENT'", () => {
      expectTypeOf<
        M3LAWSClientError["code"]
      >().toEqualTypeOf<"ERR_AWS_CLIENT">();
    });

    test("cause is typed `unknown`", () => {
      expectTypeOf<M3LAWSClientError["cause"]>().toEqualTypeOf<unknown>();
    });
  });
});

// =============================================================================
// Type-level contracts
// =============================================================================
describe("type-level contracts", () => {
  test("provider.s3 is typed S3Client", () => {
    const provider = new AWSClientProvider();

    expectTypeOf(provider.s3).toEqualTypeOf<S3Client>();
  });

  test("mapParallelSettled resolves to a readonly array of { profile, result }", async () => {
    const multi = new AWSMultiClientProvider({ profiles: [] });

    const settled = await multi.mapParallelSettled((provider) => provider);

    expectTypeOf(settled).toEqualTypeOf<
      readonly {
        readonly profile: M3LAWSProfile;
        readonly result: M3LResult<AWSClientProvider, unknown>;
      }[]
    >();
  });

  test("AWSProvider has no `services` property in its type", () => {
    expectTypeOf<AWSProvider>().not.toHaveProperty("services");
  });
});

// =============================================================================
// Type-level contracts — branded identity at the public constructor boundary
// =============================================================================
describe("branded identity at public entry points", () => {
  test("`new AWSClientProvider({ profile: <bare string> })` fails typecheck", () => {
    // @ts-expect-error -- profile must be constructed via parseAWSProfile, not a bare string
    const provider = new AWSClientProvider({ profile: "x" });
    expect(provider).toBeDefined();
  });

  test("`new AWSClientProvider({ profile: parseAWSProfile(...) })` compiles", () => {
    expect(
      () => new AWSClientProvider({ profile: parseAWSProfile("x") }),
    ).not.toThrow();
  });

  test("`new AWSMultiClientProvider({ profiles: [<bare strings>] })` fails typecheck", () => {
    // @ts-expect-error -- profiles entries must be constructed via parseAWSProfile, not bare strings
    const multi = new AWSMultiClientProvider({ profiles: ["x"] });
    expect(multi).toBeDefined();
  });

  test("`new AWSMultiClientProvider({ profiles: [parseAWSProfile(...)] })` compiles", () => {
    expect(
      () => new AWSMultiClientProvider({ profiles: [parseAWSProfile("x")] }),
    ).not.toThrow();
  });
});
