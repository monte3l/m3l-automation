/**
 * Tests for aws/credentials submodule — AWS SDK package load failure (C7).
 *
 * Contract source: docs/reference/aws/credentials.md ("the AWS SDK packages
 * are loaded lazily; if that load fails, the manager throws
 * M3LAWSCredentialsError with an actionable message and the import failure
 * chained via `cause`").
 *
 * Split out from `tests/credentials.test.ts`: that file uses a top-level
 * `vi.mock` (hoisted above every import) to make `@aws-sdk/client-sts` /
 * `@aws-sdk/credential-providers` appear PRESENT for the whole file — which
 * is exactly what these tests must NOT do, since they simulate the lazily
 * loaded AWS SDK package failing to load by making the dynamic `import()`
 * reject. This file instead uses `vi.doMock` (registered at call time, not
 * hoisted) + `vi.resetModules()` + a dynamic re-import of the module under
 * test, mirroring the lazy-loading section of `tests/text.test.ts`. This is
 * safe here specifically because each test below triggers at most one
 * dynamic import of the mocked specifier (no concurrent first-time imports
 * of the same specifier), which is the scenario that made `vi.doMock`
 * unreliable in the sibling file.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@aws-sdk/client-sts");
  vi.doUnmock("@aws-sdk/credential-providers");
  vi.resetModules();
});

describe("AWS SDK package load failure", () => {
  test("absent @aws-sdk/client-sts surfaces as M3LAWSCredentialsError naming the package, cause chained, context.type UNKNOWN", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package '@aws-sdk/client-sts'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    vi.doMock("@aws-sdk/client-sts", () => {
      throw moduleNotFound;
    });
    vi.doMock("@aws-sdk/credential-providers", () => ({ fromSSO: vi.fn() }));

    const mod = await import("../src/aws/credentials/index.js");
    // Under vi.resetModules() the dynamic graph owns its own copy of the
    // errors module, so instanceof must use M3LError from that SAME graph.
    const { M3LError: GraphM3LError } =
      await import("../src/core/errors/index.js");
    // Likewise `parseAWSProfile` must come from the SAME dynamic graph so the
    // branded `M3LAWSProfile` it returns is structurally compatible with what
    // this graph's `M3LAWSCredentialsManager` expects.
    const { parseAWSProfile: graphParseAWSProfile } =
      await import("../src/aws/models/index.js");
    const manager = new mod.M3LAWSCredentialsManager({
      profile: graphParseAWSProfile("default"),
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LAWSCredentialsError);
    expect(thrown).toBeInstanceOf(GraphM3LError);
    expect(
      (thrown as InstanceType<typeof mod.M3LAWSCredentialsError>).message,
    ).toContain("@aws-sdk/client-sts");
    const err = thrown as InstanceType<typeof mod.M3LAWSCredentialsError>;
    expect(err.cause).toBeDefined();
    expect(err.cause).not.toBe(thrown);
    expect(err.context.type).toBe("UNKNOWN");
  });

  test("absent @aws-sdk/credential-providers surfaces as M3LAWSCredentialsError naming the package, cause chained", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package '@aws-sdk/credential-providers'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const send = vi.fn().mockResolvedValue({ Account: "123456789012" });
    vi.doMock("@aws-sdk/client-sts", () => ({
      STSClient: vi.fn(function STSClient(this: { send: typeof send }) {
        this.send = send;
      }),
      GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand() {
        // No fields needed; constructibility is all that matters.
      }),
    }));
    vi.doMock("@aws-sdk/credential-providers", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/aws/credentials/index.js");
    const { parseAWSProfile: graphParseAWSProfile } =
      await import("../src/aws/models/index.js");
    const manager = new mod.M3LAWSCredentialsManager({
      profile: graphParseAWSProfile("default"),
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LAWSCredentialsError);
    expect(
      (thrown as InstanceType<typeof mod.M3LAWSCredentialsError>).message,
    ).toContain("@aws-sdk/credential-providers");
    const err = thrown as InstanceType<typeof mod.M3LAWSCredentialsError>;
    expect(err.cause).toBeDefined();
    expect(err.cause).not.toBe(thrown);
  });

  test("constructing the manager with the peer absent does NOT throw (lazy import)", async () => {
    vi.doMock("@aws-sdk/client-sts", () => {
      throw new Error("Cannot find package '@aws-sdk/client-sts'");
    });
    vi.doMock("@aws-sdk/credential-providers", () => {
      throw new Error("Cannot find package '@aws-sdk/credential-providers'");
    });

    const mod = await import("../src/aws/credentials/index.js");
    expect(() => new mod.M3LAWSCredentialsManager()).not.toThrow();
  });
});
