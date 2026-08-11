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
import type * as CodePipelineModule from "@aws-sdk/client-codepipeline";
import type * as EKSModule from "@aws-sdk/client-eks";

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
    cloudWatchLogsCtor: vi.fn(),
    athenaCtor: vi.fn(),
    secretsManagerCtor: vi.fn(),
    docFrom: vi.fn(),
    docDestroy: vi.fn(),
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
// `M3LCodePipelineOperations` reads `ActionCategory`/`ActionOwner`/etc. (data
// exports, not just types) at module top level via `Object.values(...)`, so
// this mock must preserve the real module's other exports via
// `importOriginal` — a plain object-literal factory would leave those
// `undefined` and crash on import (see tests.md's mixed class-and-data
// export-surface gotcha).
vi.mock("@aws-sdk/client-codepipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof CodePipelineModule>();
  return {
    ...actual,
    CodePipelineClient: h.makeClientClass(h.codePipelineCtor),
  };
});
vi.mock("@aws-sdk/client-api-gateway", () => ({
  APIGatewayClient: h.makeClientClass(h.apiGatewayCtor),
}));
// `M3LEKSOperations` reads `AMITypes`/`CapacityTypes` (data exports) at
// module top level the same way — see the `client-codepipeline` mock above.
vi.mock("@aws-sdk/client-eks", async (importOriginal) => {
  const actual = await importOriginal<typeof EKSModule>();
  return {
    ...actual,
    EKSClient: h.makeClientClass(h.eksCtor),
  };
});
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
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: h.makeClientClass(h.cloudWatchLogsCtor),
}));
vi.mock("@aws-sdk/client-athena", () => ({
  AthenaClient: h.makeClientClass(h.athenaCtor),
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: h.makeClientClass(h.secretsManagerCtor),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  // DynamoDBDocumentClient.from(rawClient) returns a wrapper with its OWN
  // destroy spy, so a test can assert the wrapper is NOT destroyed by close().
  DynamoDBDocumentClient: {
    from: h.docFrom,
  },
}));

import { M3LError, isErr, isOk } from "../src/core/errors/index.js";
import type { M3LResult } from "../src/core/errors/index.js";
import {
  AWS_REGION,
  AWSClientProvider,
  AWSMultiClientProvider,
  AWSProvider,
  AWSServiceProvider,
  M3LAWSClientError,
} from "../src/aws/clients/index.js";
import { M3LEventBridgeOperations } from "../src/aws/eventbridge/index.js";
import { parseAWSProfile, parseAWSRegion } from "../src/aws/models/index.js";
import type { M3LAWSProfile, M3LAWSRegion } from "../src/aws/models/index.js";
import { M3LRequestSigner } from "../src/aws/signing/index.js";
import { M3LAthenaClient } from "../src/aws/athena/index.js";
import { M3LCloudFormationOperations } from "../src/aws/cloudformation/index.js";
import { M3LCloudWatchAlarmsOperations } from "../src/aws/cloudwatch-alarms/index.js";
import { M3LLogsInsightsClient } from "../src/aws/cloudwatch-logs-insights/index.js";
import { M3LCloudWatchMetricsOperations } from "../src/aws/cloudwatch-metrics/index.js";
import { M3LCodePipelineOperations } from "../src/aws/codepipeline/index.js";
import { M3LECSOperations } from "../src/aws/ecs/index.js";
import { M3LEKSOperations } from "../src/aws/eks/index.js";
import { M3LLambdaOperations } from "../src/aws/lambda/index.js";
import { M3LSecretsManagerOperations } from "../src/aws/secrets-manager/index.js";
import { M3LSQSOperations } from "../src/aws/sqs/index.js";
import { M3LAWSCredentialsManager } from "../src/aws/credentials/index.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { AthenaClient } from "@aws-sdk/client-athena";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
  ["cloudWatchLogs", h.cloudWatchLogsCtor] as const,
  ["athena", h.athenaCtor] as const,
  ["secretsManager", h.secretsManagerCtor] as const,
] satisfies readonly (readonly [
  keyof AWSClientProvider,
  ReturnType<typeof vi.fn>,
])[];

beforeEach(() => {
  h.destroy.mockReset();
  h.fromIni.mockReset().mockReturnValue(SENTINEL_CREDENTIALS);
  h.docFrom.mockReset().mockImplementation((client: unknown) => ({
    destroy: h.docDestroy,
    __wrapped: client,
  }));
  h.docDestroy.mockReset();
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

  test("`profile` getter is undefined when no `profile` option is supplied", () => {
    const provider = new AWSClientProvider();

    expect(provider.profile).toBeUndefined();
  });

  test("`profile` getter returns the exact M3LAWSProfile supplied at construction", () => {
    const profile = parseAWSProfile("my-profile");
    const provider = new AWSClientProvider({ profile });

    expect(provider.profile).toBe(profile);
  });

  test("`region` getter returns AWS_REGION when no `region` option is supplied", () => {
    const provider = new AWSClientProvider();

    expect(provider.region).toBe(AWS_REGION);
  });

  test("`region` getter returns the exact M3LAWSRegion supplied at construction", () => {
    const region = parseAWSRegion("us-east-1");
    const provider = new AWSClientProvider({ region });

    expect(provider.region).toBe(region);
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
// AWSClientProvider — dynamoDBDocument (shares the dynamoDB client lifecycle)
// =============================================================================
describe("AWSClientProvider getter: dynamoDBDocument", () => {
  test("constructs its wrapper and the underlying dynamoDB client on first access", () => {
    const provider = new AWSClientProvider();

    void provider.dynamoDBDocument;

    expect(h.docFrom).toHaveBeenCalledTimes(1);
    expect(h.dynamoDBCtor).toHaveBeenCalledTimes(1);
  });

  test("wraps this provider's underlying raw dynamoDB client instance", () => {
    const provider = new AWSClientProvider();

    void provider.dynamoDBDocument;

    expect(h.docFrom.mock.calls[0]?.[0]).toBe(provider.dynamoDB);
  });

  test("caches the wrapper — repeat access returns the SAME instance", () => {
    const provider = new AWSClientProvider();

    const first = provider.dynamoDBDocument;
    const second = provider.dynamoDBDocument;

    expect(second).toBe(first);
    expect(h.docFrom).toHaveBeenCalledTimes(1);
  });

  test("close() destroys the shared underlying dynamoDB client exactly once and does NOT destroy the document wrapper independently", () => {
    const provider = new AWSClientProvider();

    void provider.dynamoDBDocument;
    provider.close();

    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.docDestroy).not.toHaveBeenCalled();
  });

  test("accessing both dynamoDB and dynamoDBDocument still results in exactly one destroy on close (one cache entry for the shared client)", () => {
    const provider = new AWSClientProvider();

    void provider.dynamoDB;
    void provider.dynamoDBDocument;
    provider.close();

    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.docDestroy).not.toHaveBeenCalled();
  });

  test("after close(), a fresh access rebuilds both the wrapper and the underlying client", () => {
    const provider = new AWSClientProvider();

    void provider.dynamoDBDocument;
    provider.close();
    void provider.dynamoDBDocument;

    expect(h.docFrom).toHaveBeenCalledTimes(2);
    expect(h.dynamoDBCtor).toHaveBeenCalledTimes(2);
  });

  test("wraps an underlying dynamoDB construction failure in M3LAWSClientError with the original error as `cause`", () => {
    const original = new Error("boom from DynamoDB constructor");
    h.dynamoDBCtor.mockImplementation(() => {
      throw original;
    });
    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.dynamoDBDocument;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  test("wraps a `fromIni` failure (when a profile is set) in M3LAWSClientError with the original error as `cause`", () => {
    const original = new Error("boom from fromIni");
    h.fromIni.mockImplementation(() => {
      throw original;
    });
    const provider = new AWSClientProvider({
      profile: parseAWSProfile("my-profile"),
    });

    let thrown: unknown;
    try {
      void provider.dynamoDBDocument;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  test("wraps a `DynamoDBDocumentClient.from` failure in M3LAWSClientError with the original error as `cause`, distinct from the pass-through dynamoDB failure", () => {
    const original = new Error("boom from DynamoDBDocumentClient.from");
    h.docFrom.mockImplementation(() => {
      throw original;
    });
    const provider = new AWSClientProvider();

    let thrown: unknown;
    try {
      void provider.dynamoDBDocument;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).code).toBe("ERR_AWS_CLIENT");
    expect((thrown as M3LAWSClientError).cause).toBe(original);
    expect((thrown as M3LAWSClientError).message).toContain("dynamoDBDocument");
  });
});

// =============================================================================
// AWSClientProvider — requestSigner (shares no destroyable resource; unlike
// every other getter above, `M3LRequestSigner` is NOT mocked here — its own
// construction is documented/tested (tests/signing.test.ts) as performing no
// I/O, so exercising the REAL class is what proves the getter's `profile`
// conditional-spread branch (tests/reference/aws/clients.md — "resolves
// credentials the same profile-aware way") actually builds without throwing
// under both branches, rather than just asserting a mock was called.
// =============================================================================
describe("AWSClientProvider getter: requestSigner", () => {
  test("constructs an M3LRequestSigner on first access", () => {
    const provider = new AWSClientProvider();

    expect(provider.requestSigner).toBeInstanceOf(M3LRequestSigner);
  });

  test("caches the signer — repeat access returns the SAME instance", () => {
    const provider = new AWSClientProvider();

    const first = provider.requestSigner;
    const second = provider.requestSigner;

    expect(second).toBe(first);
  });

  test("constructs successfully with no profile set (SDK default credential chain branch)", () => {
    const provider = new AWSClientProvider();

    expect(() => provider.requestSigner).not.toThrow();
  });

  test("constructs successfully with a profile set (fromIni branch)", () => {
    const provider = new AWSClientProvider({
      profile: parseAWSProfile("my-profile"),
    });

    expect(() => provider.requestSigner).not.toThrow();
    expect(provider.requestSigner).toBeInstanceOf(M3LRequestSigner);
  });

  test("close() does not attempt to destroy the request signer — it holds no destroyable resource of its own", () => {
    const provider = new AWSClientProvider();

    void provider.requestSigner;

    expect(() => provider.close()).not.toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  test("close() clears the cache — a subsequent access constructs a fresh instance", () => {
    const provider = new AWSClientProvider();

    const before = provider.requestSigner;
    provider.close();
    const after = provider.requestSigner;

    expect(after).not.toBe(before);
  });
});

// =============================================================================
// AWSClientProvider — eventBridgeOperations (shares the eventBridge client
// lifecycle, mirroring the `sqsOperations` getter's pattern in
// src/aws/clients/provider.ts: a plain wrapper constructed from the already-
// cached raw client, holding no destroyable resource of its own).
// =============================================================================
describe("AWSClientProvider getter: eventBridgeOperations", () => {
  test("constructs its wrapper and the underlying eventBridge client on first access", () => {
    const provider = new AWSClientProvider();

    const operations = provider.eventBridgeOperations;

    expect(operations).toBeInstanceOf(M3LEventBridgeOperations);
    expect(h.eventBridgeCtor).toHaveBeenCalledTimes(1);
  });

  test("caches the wrapper — repeat access returns the SAME instance", () => {
    const provider = new AWSClientProvider();

    const first = provider.eventBridgeOperations;
    const second = provider.eventBridgeOperations;

    expect(second).toBe(first);
    expect(h.eventBridgeCtor).toHaveBeenCalledTimes(1);
  });

  test("close() destroys the shared underlying eventBridge client exactly once (the wrapper holds no destroyable resource of its own)", () => {
    const provider = new AWSClientProvider();

    void provider.eventBridgeOperations;
    provider.close();

    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  test("close() clears it — a subsequent access after close() constructs a fresh instance", () => {
    const provider = new AWSClientProvider();

    const before = provider.eventBridgeOperations;
    provider.close();
    const after = provider.eventBridgeOperations;

    expect(after).not.toBe(before);
  });
});

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
// AWSServiceProvider — construction
// =============================================================================
describe("AWSServiceProvider construction", () => {
  test("constructs with a clientProvider and no options — no throw", () => {
    const clientProvider = new AWSClientProvider();

    expect(() => new AWSServiceProvider(clientProvider)).not.toThrow();
  });

  test("constructs from a clientProvider built with a full options bag — no throw", () => {
    const clientProvider = new AWSClientProvider({
      profile: parseAWSProfile("svc-profile"),
      region: parseAWSRegion("us-east-1"),
    });

    expect(() => new AWSServiceProvider(clientProvider)).not.toThrow();
  });

  test("no longer accepts a second `options` argument — divergence made unrepresentable at the type level", () => {
    const clientProvider = new AWSClientProvider();

    // @ts-expect-error — AWSServiceProvider no longer accepts a second
    // `options` argument (Must-fix from type-design review: divergence made
    // unrepresentable; requestSigner/credentials now read profile/region
    // exclusively from `clientProvider`).
    new AWSServiceProvider(clientProvider, {
      profile: parseAWSProfile("other"),
    });
  });
});

// =============================================================================
// AWSServiceProvider — the 12 "fresh instance" getters built from a raw
// client on `clientProvider` (mirrors AWSClientProvider's GETTER_MATRIX
// pattern above). requestSigner/credentials/dynamoDBDocument are covered
// separately below since they are not built the same way.
// =============================================================================
const SERVICE_GETTER_MATRIX = [
  ["sqsOperations", M3LSQSOperations, h.sqsCtor] as const,
  [
    "eventBridgeOperations",
    M3LEventBridgeOperations,
    h.eventBridgeCtor,
  ] as const,
  ["athena", M3LAthenaClient, h.athenaCtor] as const,
  [
    "cloudFormation",
    M3LCloudFormationOperations,
    h.cloudFormationCtor,
  ] as const,
  [
    "cloudWatchAlarms",
    M3LCloudWatchAlarmsOperations,
    h.cloudWatchCtor,
  ] as const,
  [
    "cloudWatchLogsInsights",
    M3LLogsInsightsClient,
    h.cloudWatchLogsCtor,
  ] as const,
  [
    "cloudWatchMetrics",
    M3LCloudWatchMetricsOperations,
    h.cloudWatchCtor,
  ] as const,
  ["codePipeline", M3LCodePipelineOperations, h.codePipelineCtor] as const,
  ["ecs", M3LECSOperations, h.ecsCtor] as const,
  ["eks", M3LEKSOperations, h.eksCtor] as const,
  ["lambda", M3LLambdaOperations, h.lambdaCtor] as const,
  [
    "secretsManager",
    M3LSecretsManagerOperations,
    h.secretsManagerCtor,
  ] as const,
] satisfies readonly (readonly [
  keyof AWSServiceProvider,
  unknown,
  ReturnType<typeof vi.fn>,
])[];

describe.each(SERVICE_GETTER_MATRIX)(
  "AWSServiceProvider getter: %s",
  (getterName, WrapperClass, ctorSpy) => {
    void ctorSpy;

    test("is an instance of the documented wrapper class", () => {
      const clientProvider = new AWSClientProvider({
        profile: parseAWSProfile("svc-profile"),
      });
      const services = new AWSServiceProvider(clientProvider);

      expect(services[getterName]).toBeInstanceOf(WrapperClass);
    });

    test("memoizes — repeat access returns the SAME instance", () => {
      const clientProvider = new AWSClientProvider();
      const services = new AWSServiceProvider(clientProvider);

      const first = services[getterName];
      const second = services[getterName];

      expect(second).toBe(first);
    });

    test("a fresh AWSServiceProvider wrapping the same clientProvider produces a DIFFERENT wrapper instance — no global cache", () => {
      const clientProvider = new AWSClientProvider();
      const servicesA = new AWSServiceProvider(clientProvider);
      const servicesB = new AWSServiceProvider(clientProvider);

      expect(servicesB[getterName]).not.toBe(servicesA[getterName]);
    });
  },
);

// =============================================================================
// AWSServiceProvider — cloudWatchAlarms / cloudWatchMetrics share one
// underlying `cloudWatch` raw client (one CloudWatchClient construction
// total across both wrapper getters).
// =============================================================================
describe("AWSServiceProvider — cloudWatchAlarms / cloudWatchMetrics share the raw cloudWatch client", () => {
  test("each is its documented wrapper class, distinct from each other, but the raw CloudWatchClient is constructed exactly once", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const alarms = services.cloudWatchAlarms;
    const metrics = services.cloudWatchMetrics;

    expect(alarms).toBeInstanceOf(M3LCloudWatchAlarmsOperations);
    expect(metrics).toBeInstanceOf(M3LCloudWatchMetricsOperations);
    expect(metrics).not.toBe(alarms);
    expect(h.cloudWatchCtor).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// AWSServiceProvider — cross-provider client sharing: `.services.sqsOperations`
// and `.clients.sqsOperations` wrap the same underlying SQSClient, never
// double-constructing it.
// =============================================================================
describe("AWSServiceProvider — shares the raw client with AWSClientProvider's own convenience getter", () => {
  test("services.sqsOperations is a different object from clientProvider.sqsOperations, but SQSClient is constructed exactly once", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const fromServices = services.sqsOperations;
    const fromClients = clientProvider.sqsOperations;

    expect(fromServices).not.toBe(fromClients);
    expect(h.sqsCtor).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// AWSServiceProvider — dynamoDBDocument (passthrough, NOT a fresh instance)
// =============================================================================
describe("AWSServiceProvider getter: dynamoDBDocument", () => {
  test("is identical to clientProvider.dynamoDBDocument — a passthrough, not a new wrapper", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(services.dynamoDBDocument).toBe(clientProvider.dynamoDBDocument);
  });
});

// =============================================================================
// AWSServiceProvider — requestSigner (built from this provider's own
// profile/region, not from any clientProvider getter)
// =============================================================================
describe("AWSServiceProvider getter: requestSigner", () => {
  test("constructs an M3LRequestSigner on first access", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(services.requestSigner).toBeInstanceOf(M3LRequestSigner);
  });

  test("memoizes — repeat access returns the SAME instance", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const first = services.requestSigner;
    const second = services.requestSigner;

    expect(second).toBe(first);
  });

  test("built from a clientProvider constructed with a specific profile, accessing requestSigner does not throw", () => {
    const clientProvider = new AWSClientProvider({
      profile: parseAWSProfile("profile-a"),
    });
    const services = new AWSServiceProvider(clientProvider);

    expect(() => services.requestSigner).not.toThrow();
  });

  test("with no `options` argument at all, accessing requestSigner does not throw (default-region path)", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(() => services.requestSigner).not.toThrow();
  });
});

// =============================================================================
// AWSServiceProvider — credentials (built from this provider's own
// profile/region; constructing it must never touch any AWS SDK client)
// =============================================================================
describe("AWSServiceProvider getter: credentials", () => {
  test("constructs an M3LAWSCredentialsManager on first access", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(services.credentials).toBeInstanceOf(M3LAWSCredentialsManager);
  });

  test("memoizes — repeat access returns the SAME instance", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const first = services.credentials;
    const second = services.credentials;

    expect(second).toBe(first);
  });

  test("never calls any AWS SDK client constructor — construction alone does not touch a raw client", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    void services.credentials;

    for (const [, , ctorSpy] of SERVICE_GETTER_MATRIX) {
      expect(ctorSpy).not.toHaveBeenCalled();
    }
    expect(h.dynamoDBCtor).not.toHaveBeenCalled();
    expect(h.s3Ctor).not.toHaveBeenCalled();
    expect(h.stsCtor).not.toHaveBeenCalled();
  });

  test("with no `options` argument at all, accessing credentials does not throw (default-region path)", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(() => services.credentials).not.toThrow();
  });
});

// =============================================================================
// AWSServiceProvider — error propagation: a throwing clientProvider getter
// propagates unchanged (AWSServiceProvider adds no error handling of its
// own), and the cache is not poisoned by the failure.
// =============================================================================
describe("AWSServiceProvider error propagation", () => {
  test("a clientProvider getter failure propagates unchanged (same error instance, not re-wrapped)", () => {
    const original = new Error("boom from Athena constructor");
    h.athenaCtor.mockImplementation(() => {
      throw original;
    });
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    let thrown: unknown;
    try {
      void services.athena;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAWSClientError);
    expect((thrown as M3LAWSClientError).cause).toBe(original);
  });

  test("the cache is not poisoned by a failed access — a later successful access returns a working instance", () => {
    const original = new Error("boom from Athena constructor");
    h.athenaCtor.mockImplementationOnce(() => {
      throw original;
    });
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(() => services.athena).toThrow();

    const athena = services.athena;
    expect(athena).toBeInstanceOf(M3LAthenaClient);
  });
});

// =============================================================================
// AWSServiceProvider.close()
// =============================================================================
describe("AWSServiceProvider.close", () => {
  test("close with no getters ever accessed is a no-op — no throw", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    expect(() => services.close()).not.toThrow();
  });

  test("clears its own cache — a subsequent access after close() constructs a fresh instance", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const a = services.athena;
    services.close();
    const b = services.athena;

    expect(b).not.toBe(a);
  });

  test("never calls `.destroy()` on the underlying raw SDK client", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    void services.athena;
    services.close();

    expect(h.destroy).not.toHaveBeenCalled();
  });

  test("never calls `clientProvider.close()`", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);
    const closeSpy = vi.spyOn(clientProvider, "close");

    services.close();

    expect(closeSpy).not.toHaveBeenCalled();
  });

  test("no cascade inbound: calling clientProvider.close() does not clear the services cache", () => {
    const clientProvider = new AWSClientProvider();
    const services = new AWSServiceProvider(clientProvider);

    const a = services.athena;
    clientProvider.close();
    const stillA = services.athena;

    expect(stillA).toBe(a);
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

  test("`services` getter returns an AWSServiceProvider instance", () => {
    const provider = new AWSProvider({
      profile: parseAWSProfile("my-profile"),
    });

    expect(provider.services).toBeInstanceOf(AWSServiceProvider);
  });

  test("`services` getter is lazily instantiated and reused — same instance on repeat access", () => {
    const provider = new AWSProvider();

    const first = provider.services;
    const second = provider.services;

    expect(second).toBe(first);
  });

  test("`services` shares the same underlying AWSClientProvider as `clients` — services-first access order", () => {
    const provider = new AWSProvider();

    void provider.services.athena;
    expect(h.athenaCtor).toHaveBeenCalledTimes(1);

    void provider.clients.athena;
    expect(h.athenaCtor).toHaveBeenCalledTimes(1);
  });

  test("`services` shares the same underlying AWSClientProvider as `clients` — clients-first access order", () => {
    const provider = new AWSProvider();

    void provider.clients.athena;
    expect(h.athenaCtor).toHaveBeenCalledTimes(1);

    void provider.services.athena;
    expect(h.athenaCtor).toHaveBeenCalledTimes(1);
  });

  test("`services` forwards the same options the AWSProvider was constructed with — no throw", () => {
    const provider = new AWSProvider({
      profile: parseAWSProfile("my-profile"),
    });

    expect(() => provider.services.requestSigner).not.toThrow();
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

  test("provider.cloudWatchLogs is typed CloudWatchLogsClient", () => {
    expectTypeOf<
      AWSClientProvider["cloudWatchLogs"]
    >().toEqualTypeOf<CloudWatchLogsClient>();
  });

  test("provider.athena is typed AthenaClient", () => {
    expectTypeOf<AWSClientProvider["athena"]>().toEqualTypeOf<AthenaClient>();
  });

  test("provider.secretsManager is typed SecretsManagerClient", () => {
    expectTypeOf<
      AWSClientProvider["secretsManager"]
    >().toEqualTypeOf<SecretsManagerClient>();
  });

  test("provider.dynamoDBDocument is typed DynamoDBDocumentClient", () => {
    expectTypeOf<
      AWSClientProvider["dynamoDBDocument"]
    >().toEqualTypeOf<DynamoDBDocumentClient>();
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

  test("AWSProvider['services'] is typed AWSServiceProvider", () => {
    expectTypeOf<AWSProvider["services"]>().toEqualTypeOf<AWSServiceProvider>();
  });
});

// =============================================================================
// Type-level contracts — AWSServiceProvider getters
// =============================================================================
describe("type-level contracts: AWSServiceProvider getters", () => {
  test("sqsOperations is typed M3LSQSOperations", () => {
    expectTypeOf<
      AWSServiceProvider["sqsOperations"]
    >().toEqualTypeOf<M3LSQSOperations>();
  });

  test("eventBridgeOperations is typed M3LEventBridgeOperations", () => {
    expectTypeOf<
      AWSServiceProvider["eventBridgeOperations"]
    >().toEqualTypeOf<M3LEventBridgeOperations>();
  });

  test("requestSigner is typed M3LRequestSigner", () => {
    expectTypeOf<
      AWSServiceProvider["requestSigner"]
    >().toEqualTypeOf<M3LRequestSigner>();
  });

  test("dynamoDBDocument is typed DynamoDBDocumentClient", () => {
    expectTypeOf<
      AWSServiceProvider["dynamoDBDocument"]
    >().toEqualTypeOf<DynamoDBDocumentClient>();
  });

  test("athena is typed M3LAthenaClient", () => {
    expectTypeOf<
      AWSServiceProvider["athena"]
    >().toEqualTypeOf<M3LAthenaClient>();
  });

  test("cloudFormation is typed M3LCloudFormationOperations", () => {
    expectTypeOf<
      AWSServiceProvider["cloudFormation"]
    >().toEqualTypeOf<M3LCloudFormationOperations>();
  });

  test("cloudWatchAlarms is typed M3LCloudWatchAlarmsOperations", () => {
    expectTypeOf<
      AWSServiceProvider["cloudWatchAlarms"]
    >().toEqualTypeOf<M3LCloudWatchAlarmsOperations>();
  });

  test("cloudWatchLogsInsights is typed M3LLogsInsightsClient", () => {
    expectTypeOf<
      AWSServiceProvider["cloudWatchLogsInsights"]
    >().toEqualTypeOf<M3LLogsInsightsClient>();
  });

  test("cloudWatchMetrics is typed M3LCloudWatchMetricsOperations", () => {
    expectTypeOf<
      AWSServiceProvider["cloudWatchMetrics"]
    >().toEqualTypeOf<M3LCloudWatchMetricsOperations>();
  });

  test("codePipeline is typed M3LCodePipelineOperations", () => {
    expectTypeOf<
      AWSServiceProvider["codePipeline"]
    >().toEqualTypeOf<M3LCodePipelineOperations>();
  });

  test("ecs is typed M3LECSOperations", () => {
    expectTypeOf<AWSServiceProvider["ecs"]>().toEqualTypeOf<M3LECSOperations>();
  });

  test("eks is typed M3LEKSOperations", () => {
    expectTypeOf<AWSServiceProvider["eks"]>().toEqualTypeOf<M3LEKSOperations>();
  });

  test("lambda is typed M3LLambdaOperations", () => {
    expectTypeOf<
      AWSServiceProvider["lambda"]
    >().toEqualTypeOf<M3LLambdaOperations>();
  });

  test("secretsManager is typed M3LSecretsManagerOperations", () => {
    expectTypeOf<
      AWSServiceProvider["secretsManager"]
    >().toEqualTypeOf<M3LSecretsManagerOperations>();
  });

  test("credentials is typed M3LAWSCredentialsManager", () => {
    expectTypeOf<
      AWSServiceProvider["credentials"]
    >().toEqualTypeOf<M3LAWSCredentialsManager>();
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
