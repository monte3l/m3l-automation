/**
 * Tests for aws/secrets-manager submodule.
 *
 * Contract source: docs/reference/aws/secrets-manager.md (per the RED-phase
 * hub message; the submodule does not exist yet under
 * `packages/m3l-common/src/aws/secrets-manager/`).
 *
 * Exports under test (from `../src/aws/secrets-manager/index.js`, following
 * the package's `../src/aws/index.js` barrel and the sibling
 * `tests/cloudwatch-alarms.test.ts` / `tests/eventbridge.test.ts` import
 * convention — those import from the submodule's own `index.js`, not the
 * `aws` namespace barrel):
 *   M3LSecretsManagerOperations, M3LSecretsManagerOperationError, and the
 *   plain M3LSecret-, M3LCreateSecret-, M3LPutSecretValue-, and
 *   M3LDeleteSecret-prefixed types.
 *
 * Mocking strategy: `@aws-sdk/client-secrets-manager` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/eventbridge.test.ts`), with a `.send()` spy dispatching by command
 * class. Every command class is a plain recorder (`constructor(input)`), so
 * a test asserting on the command shape reads
 * `h.send.mock.calls[0][0].input`.
 *
 * Retry coverage: kept deliberately minimal per this repo's convention (see
 * `tests/eventbridge.test.ts`'s header) — core/polling owns retry mechanics.
 * Every failure-path test below uses a non-retriable error name
 * (`AccessDenied`) so `send` is called exactly once.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class GetSecretValueCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateSecretCommand {
    constructor(readonly input: unknown) {}
  }
  class PutSecretValueCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeSecretCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteSecretCommand {
    constructor(readonly input: unknown) {}
  }
  class SecretsManagerClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    SecretsManagerClient,
    GetSecretValueCommand,
    CreateSecretCommand,
    PutSecretValueCommand,
    DescribeSecretCommand,
    DeleteSecretCommand,
  };
});

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: h.SecretsManagerClient,
  GetSecretValueCommand: h.GetSecretValueCommand,
  CreateSecretCommand: h.CreateSecretCommand,
  PutSecretValueCommand: h.PutSecretValueCommand,
  DescribeSecretCommand: h.DescribeSecretCommand,
  DeleteSecretCommand: h.DeleteSecretCommand,
}));

import type {
  M3LCreateSecretInput,
  M3LCreateSecretResult,
  M3LDeleteSecretOptions,
  M3LDeleteSecretResult,
  M3LGetSecretValueOptions,
  M3LPutSecretValueInput,
  M3LPutSecretValueResult,
  M3LSecretMetadata,
  M3LSecretValue,
} from "../src/aws/secrets-manager/index.js";
import {
  M3LSecretsManagerOperationError,
  M3LSecretsManagerOperations,
} from "../src/aws/secrets-manager/index.js";
import { M3LError } from "../src/core/errors/index.js";

import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** Casts the hoisted fake `SecretsManagerClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): SecretsManagerClient {
  return new h.SecretsManagerClient() as unknown as SecretsManagerClient;
}

/** Reads the `input` bag from the Nth recorded `send()` call (0-indexed). */
function commandInput(callIndex = 0): Record<string, unknown> {
  const [command] = h.send.mock.calls[callIndex] as [
    { input: Record<string, unknown> },
  ];
  return command.input;
}

/** A non-retriable, fatal SDK-style error — keeps failure-path tests to exactly one `send()` call. */
function fatalError(message = "denied"): Error {
  return Object.assign(new Error(message), { name: "AccessDenied" });
}

const FULL_CREATE_SECRET_INPUT_STRING: M3LCreateSecretInput = {
  name: "db-password",
  description: "prod db password",
  kmsKeyId: "arn:aws:kms:eu-south-1:123456789012:key/abcd-1234",
  tags: [{ key: "env", value: "prod" }],
  secretString: "hunter2",
};

const FULL_CREATE_SECRET_INPUT_BINARY: M3LCreateSecretInput = {
  name: "db-cert",
  secretBinary: new Uint8Array([1, 2, 3]),
};

describe("M3LSecretsManagerOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  // ===========================================================================
  // getSecretValue()
  // ===========================================================================
  describe("getSecretValue()", () => {
    test("resolves with a plain M3LSecretValue on a successful GetSecretValue call", async () => {
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
        VersionId: "v1",
        VersionStages: ["AWSCURRENT"],
        SecretString: "hunter2",
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.getSecretValue("db-password");

      expect(result).toEqual({
        arn: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        name: "db-password",
        versionId: "v1",
        versionStages: ["AWSCURRENT"],
        secretString: "hunter2",
      });
    });

    test("defaults arn/name/versionId to '' and versionStages to [] when the SDK response omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.getSecretValue("db-password");

      expect(result).toEqual({
        arn: "",
        name: "",
        versionId: "",
        versionStages: [],
      });
    });

    test("omits secretString and secretBinary from the result when the SDK response omits both", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.getSecretValue("db-password");

      expect(Object.hasOwn(result, "secretString")).toBe(false);
      expect(Object.hasOwn(result, "secretBinary")).toBe(false);
    });

    test("resolves secretBinary when the SDK response carries binary content instead of a string", async () => {
      const binary = new Uint8Array([9, 8, 7]);
      h.send.mockResolvedValueOnce({ SecretBinary: binary });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.getSecretValue("db-password");

      expect(result.secretBinary).toBe(binary);
      expect(Object.hasOwn(result, "secretString")).toBe(false);
    });

    test("sends only SecretId on the command input when no options are supplied", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.getSecretValue("db-password");

      expect(commandInput()).toEqual({ SecretId: "db-password" });
    });

    test("maps versionId/versionStage onto VersionId/VersionStage command input", async () => {
      h.send.mockResolvedValueOnce({});
      const options: M3LGetSecretValueOptions = {
        versionId: "v1",
        versionStage: "AWSCURRENT",
      };

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.getSecretValue("db-password", options);

      expect(commandInput()).toEqual({
        SecretId: "db-password",
        VersionId: "v1",
        VersionStage: "AWSCURRENT",
      });
    });

    test("omits VersionId/VersionStage keys from the command input when not passed (not undefined-valued keys)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.getSecretValue("db-password");

      const input = commandInput();
      expect(Object.hasOwn(input, "VersionId")).toBe(false);
      expect(Object.hasOwn(input, "VersionStage")).toBe(false);
    });

    test("rejects M3LSecretsManagerOperationError with cause chained on a GetSecretValue failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.getSecretValue("db-password");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(sdkError);
      expect((thrown as M3LSecretsManagerOperationError).code).toBe(
        "ERR_SECRETS_MANAGER_OPERATION",
      );
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // createSecret()
  // ===========================================================================
  describe("createSecret()", () => {
    test("resolves with a plain M3LCreateSecretResult on a successful CreateSecret call", async () => {
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
        VersionId: "v1",
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result: M3LCreateSecretResult = await operations.createSecret(
        FULL_CREATE_SECRET_INPUT_STRING,
      );

      expect(result).toEqual({
        arn: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        name: "db-password",
        versionId: "v1",
      });
    });

    test("defaults arn/name/versionId to '' when the SDK response omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.createSecret(
        FULL_CREATE_SECRET_INPUT_STRING,
      );

      expect(result).toEqual({ arn: "", name: "", versionId: "" });
    });

    test("maps the full string-variant input onto Name/Description/KmsKeyId/Tags/SecretString", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.createSecret(FULL_CREATE_SECRET_INPUT_STRING);

      expect(commandInput()).toEqual({
        Name: "db-password",
        Description: "prod db password",
        KmsKeyId: "arn:aws:kms:eu-south-1:123456789012:key/abcd-1234",
        Tags: [{ Key: "env", Value: "prod" }],
        SecretString: "hunter2",
      });
    });

    test("maps the binary-variant input onto Name/SecretBinary (no SecretString key)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.createSecret(FULL_CREATE_SECRET_INPUT_BINARY);

      expect(commandInput()).toEqual({
        Name: "db-cert",
        SecretBinary: FULL_CREATE_SECRET_INPUT_BINARY.secretBinary,
      });
    });

    test("omits Description/KmsKeyId/Tags keys when every optional field is omitted", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.createSecret({
        name: "db-password",
        secretString: "hunter2",
      });

      expect(commandInput()).toEqual({
        Name: "db-password",
        SecretString: "hunter2",
      });
    });

    test("rejects M3LSecretsManagerOperationError with cause chained on a CreateSecret failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.createSecret(FULL_CREATE_SECRET_INPUT_STRING);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(sdkError);
    });

    test("a CreateSecret failure's error message names the secret but never contains the secret string", async () => {
      h.send.mockRejectedValueOnce(fatalError());

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.createSecret(FULL_CREATE_SECRET_INPUT_STRING);
      } catch (error) {
        thrown = error;
      }

      const message = (thrown as M3LSecretsManagerOperationError).message;
      expect(message).toContain("db-password");
      expect(message).not.toContain("hunter2");
    });
  });

  // ===========================================================================
  // putSecretValue()
  // ===========================================================================
  describe("putSecretValue()", () => {
    test("resolves with a plain M3LPutSecretValueResult on a successful PutSecretValue call", async () => {
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
        VersionId: "v2",
        VersionStages: ["AWSCURRENT"],
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result: M3LPutSecretValueResult = await operations.putSecretValue({
        secretId: "db-password",
        secretString: "hunter3",
      });

      expect(result).toEqual({
        arn: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        name: "db-password",
        versionId: "v2",
        versionStages: ["AWSCURRENT"],
      });
    });

    test("defaults arn/name/versionId to '' and versionStages to [] when the SDK response omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.putSecretValue({
        secretId: "db-password",
        secretString: "hunter3",
      });

      expect(result).toEqual({
        arn: "",
        name: "",
        versionId: "",
        versionStages: [],
      });
    });

    test("maps the string-variant input onto SecretId/SecretString", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const input: M3LPutSecretValueInput = {
        secretId: "db-password",
        secretString: "hunter3",
      };
      await operations.putSecretValue(input);

      expect(commandInput()).toEqual({
        SecretId: "db-password",
        SecretString: "hunter3",
      });
    });

    test("maps the binary-variant input onto SecretId/SecretBinary (no SecretString key)", async () => {
      h.send.mockResolvedValueOnce({});
      const binary = new Uint8Array([4, 5, 6]);

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const input: M3LPutSecretValueInput = {
        secretId: "db-password",
        secretBinary: binary,
      };
      await operations.putSecretValue(input);

      expect(commandInput()).toEqual({
        SecretId: "db-password",
        SecretBinary: binary,
      });
    });

    test("rejects M3LSecretsManagerOperationError with cause chained on a PutSecretValue failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putSecretValue({
          secretId: "db-password",
          secretString: "hunter3",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(sdkError);
    });

    test("a PutSecretValue failure's error message names the secretId but never contains the secret string", async () => {
      h.send.mockRejectedValueOnce(fatalError());

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.putSecretValue({
          secretId: "db-password",
          secretString: "hunter3",
        });
      } catch (error) {
        thrown = error;
      }

      const message = (thrown as M3LSecretsManagerOperationError).message;
      expect(message).toContain("db-password");
      expect(message).not.toContain("hunter3");
    });
  });

  // ===========================================================================
  // describeSecret()
  // ===========================================================================
  describe("describeSecret()", () => {
    test("resolves with a fully-mapped M3LSecretMetadata on a successful DescribeSecret call", async () => {
      const lastChangedDate = new Date("2026-01-01T00:00:00.000Z");
      const lastAccessedDate = new Date("2026-01-02T00:00:00.000Z");
      const createdDate = new Date("2025-12-01T00:00:00.000Z");
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
        Description: "prod db password",
        KmsKeyId: "arn:aws:kms:eu-south-1:123456789012:key/abcd-1234",
        RotationEnabled: true,
        LastChangedDate: lastChangedDate,
        LastAccessedDate: lastAccessedDate,
        CreatedDate: createdDate,
        PrimaryRegion: "eu-south-1",
        OwningService: "secretsmanager",
        Tags: [{ Key: "env", Value: "prod" }],
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result: M3LSecretMetadata =
        await operations.describeSecret("db-password");

      expect(result).toEqual({
        arn: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        name: "db-password",
        description: "prod db password",
        kmsKeyId: "arn:aws:kms:eu-south-1:123456789012:key/abcd-1234",
        rotationEnabled: true,
        lastChangedDate,
        lastAccessedDate,
        createdDate,
        primaryRegion: "eu-south-1",
        owningService: "secretsmanager",
        tags: [{ key: "env", value: "prod" }],
      });
    });

    test("defaults arn/name to '' and omits every other optional field when the SDK response omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.describeSecret("db-password");

      expect(result).toEqual({ arn: "", name: "" });
      for (const field of [
        "description",
        "kmsKeyId",
        "rotationEnabled",
        "lastChangedDate",
        "lastAccessedDate",
        "deletedDate",
        "createdDate",
        "primaryRegion",
        "owningService",
        "tags",
      ]) {
        expect(Object.hasOwn(result, field)).toBe(false);
      }
    });

    test("maps a Tags entry missing both Key and Value to { key: '', value: '' }", async () => {
      h.send.mockResolvedValueOnce({ Tags: [{}] });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.describeSecret("db-password");

      expect(result.tags).toEqual([{ key: "", value: "" }]);
    });

    test("sends only SecretId on the command input — no options parameter exists for this method", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.describeSecret("db-password");

      expect(commandInput()).toEqual({ SecretId: "db-password" });
    });

    test("never returns secret material even if the SDK response defensively includes SecretString/SecretBinary", async () => {
      h.send.mockResolvedValueOnce({
        Name: "db-password",
        SecretString: "hunter2",
        SecretBinary: new Uint8Array([1, 2, 3]),
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.describeSecret("db-password");

      expect(Object.hasOwn(result, "secretString")).toBe(false);
      expect(Object.hasOwn(result, "secretBinary")).toBe(false);
    });

    test("rejects M3LSecretsManagerOperationError with cause chained on a DescribeSecret failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeSecret("db-password");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // deleteSecret()
  // ===========================================================================
  describe("deleteSecret()", () => {
    test("resolves with a plain M3LDeleteSecretResult on a successful DeleteSecret call", async () => {
      const deletionDate = new Date("2026-02-01T00:00:00.000Z");
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
        DeletionDate: deletionDate,
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result: M3LDeleteSecretResult =
        await operations.deleteSecret("db-password");

      expect(result).toEqual({
        arn: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        name: "db-password",
        deletionDate,
      });
    });

    test("omits deletionDate from the result when the SDK response omits DeletionDate (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({
        ARN: "arn:aws:secretsmanager:eu-south-1:123456789012:secret:db-password-AbCdEf",
        Name: "db-password",
      });

      const operations = new M3LSecretsManagerOperations(fakeClient());
      const result = await operations.deleteSecret("db-password");

      expect(Object.hasOwn(result, "deletionDate")).toBe(false);
    });

    test("sends only SecretId on the command input when no options are supplied", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.deleteSecret("db-password");

      expect(commandInput()).toEqual({ SecretId: "db-password" });
    });

    test("maps recoveryWindowInDays onto RecoveryWindowInDays command input", async () => {
      h.send.mockResolvedValueOnce({});
      const options: M3LDeleteSecretOptions = { recoveryWindowInDays: 7 };

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.deleteSecret("db-password", options);

      expect(commandInput()).toEqual({
        SecretId: "db-password",
        RecoveryWindowInDays: 7,
      });
    });

    test("maps forceDeleteWithoutRecovery onto ForceDeleteWithoutRecovery command input", async () => {
      h.send.mockResolvedValueOnce({});
      const options: M3LDeleteSecretOptions = {
        forceDeleteWithoutRecovery: true,
      };

      const operations = new M3LSecretsManagerOperations(fakeClient());
      await operations.deleteSecret("db-password", options);

      expect(commandInput()).toEqual({
        SecretId: "db-password",
        ForceDeleteWithoutRecovery: true,
      });
    });

    test("rejects M3LSecretsManagerOperationError with cause chained on a DeleteSecret failure", async () => {
      const sdkError = fatalError();
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.deleteSecret("db-password");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // Cross-cutting retry behavior — deliberately minimal (core/polling owns
  // retry mechanics); one success-after-retry case and one exhausted-retries
  // case is enough per this repo's convention (see the file header comment).
  // ===========================================================================
  describe("retry behavior (awsThrottling policy)", () => {
    test("getSecretValue() retries once on a ThrottlingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            Object.assign(new Error("throttled"), {
              name: "ThrottlingException",
            }),
          )
          .mockResolvedValueOnce({});

        const operations = new M3LSecretsManagerOperations(fakeClient());

        let result: M3LSecretValue | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.getSecretValue("db-password");
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result).toEqual({
          arn: "",
          name: "",
          versionId: "",
          versionStages: [],
        });
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("createSecret() exhausts retries and rejects M3LSecretsManagerOperationError with cause=throttle error after 10 attempts", async () => {
      vi.useFakeTimers();
      try {
        const throttleError = Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        });
        h.send.mockRejectedValue(throttleError);

        const operations = new M3LSecretsManagerOperations(fakeClient());

        let thrown: unknown;
        const run = (async () => {
          try {
            await operations.createSecret(FULL_CREATE_SECRET_INPUT_STRING);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(60_000);
        await run;

        expect(thrown).toBeInstanceOf(M3LSecretsManagerOperationError);
        expect((thrown as M3LSecretsManagerOperationError).cause).toBe(
          throttleError,
        );
        expect(h.send).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // M3LSecretsManagerOperationError — identity/shape
  // ===========================================================================
  describe("M3LSecretsManagerOperationError", () => {
    test("is an instance of both M3LError and Error", async () => {
      h.send.mockRejectedValueOnce(fatalError());
      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeSecret("db-password");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect(thrown).toBeInstanceOf(Error);
    });

    test("`cause` is preserved verbatim (no normalization) for a non-Error rejection", async () => {
      const original = { weird: "non-error rejection" };
      h.send.mockRejectedValueOnce(original);
      const operations = new M3LSecretsManagerOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.describeSecret("db-password");
      } catch (error) {
        thrown = error;
      }

      expect((thrown as M3LSecretsManagerOperationError).cause).toBe(original);
    });
  });

  // ===========================================================================
  // Type-level contracts
  // ===========================================================================
  describe("type-level contracts", () => {
    test("M3LSecretsManagerOperationError extends M3LError", () => {
      expectTypeOf<M3LSecretsManagerOperationError>().toExtend<M3LError>();
    });

    test("M3LSecretsManagerOperationError.code narrows to the literal 'ERR_SECRETS_MANAGER_OPERATION'", () => {
      expectTypeOf<
        M3LSecretsManagerOperationError["code"]
      >().toEqualTypeOf<"ERR_SECRETS_MANAGER_OPERATION">();
    });

    test("M3LDeleteSecretOptions as {} is legal — neither field is required", () => {
      const options: M3LDeleteSecretOptions = {};
      expect(options).toEqual({});
    });

    test("M3LCreateSecretInput rejects both secretString and secretBinary", () => {
      // @ts-expect-error -- exactly one of secretString/secretBinary is required, not both
      const input: M3LCreateSecretInput = {
        name: "x",
        secretString: "a",
        secretBinary: new Uint8Array(),
      };
      void input;
    });

    test("M3LCreateSecretInput rejects neither secretString nor secretBinary", () => {
      // @ts-expect-error -- exactly one of secretString/secretBinary is required
      const input: M3LCreateSecretInput = { name: "x" };
      void input;
    });

    test("M3LPutSecretValueInput rejects both secretString and secretBinary", () => {
      // @ts-expect-error -- exactly one of secretString/secretBinary is required, not both
      const input: M3LPutSecretValueInput = {
        secretId: "x",
        secretString: "a",
        secretBinary: new Uint8Array(),
      };
      void input;
    });

    test("M3LPutSecretValueInput rejects neither secretString nor secretBinary", () => {
      // @ts-expect-error -- exactly one of secretString/secretBinary is required
      const input: M3LPutSecretValueInput = { secretId: "x" };
      void input;
    });

    test("M3LDeleteSecretOptions rejects both recoveryWindowInDays and forceDeleteWithoutRecovery", () => {
      const options: M3LDeleteSecretOptions = {
        recoveryWindowInDays: 14,
        // @ts-expect-error -- at most one of recoveryWindowInDays/forceDeleteWithoutRecovery is allowed
        forceDeleteWithoutRecovery: true,
      };
      void options;
    });
  });
});
