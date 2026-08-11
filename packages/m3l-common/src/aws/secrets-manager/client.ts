/**
 * `aws/secrets-manager/client` — {@link M3LSecretsManagerOperations}, a typed
 * wrapper over a raw `SecretsManagerClient` so callers never import
 * `@aws-sdk/client-secrets-manager` command classes directly. See
 * `docs/reference/aws/secrets-manager.md` for the full contract, and
 * ADR-0026 (referenced by `aws/eventbridge`) for why this module is
 * permitted to import `core/polling` (Zone A).
 *
 * @packageDocumentation
 */

import type {
  DescribeSecretResponse,
  GetSecretValueCommandInput,
  GetSecretValueResponse,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

import { M3LSecretsManagerOperationError } from "./error.js";
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
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/**
 * Builds a `GetSecretValueCommand`'s input from a secret id and
 * {@link M3LGetSecretValueOptions} — split out of
 * {@link M3LSecretsManagerOperations.getSecretValue} to keep both functions'
 * cyclomatic complexity low.
 *
 * @param secretId - The ARN or name of the secret to retrieve.
 * @param options - Optionally pins a specific version by id or staging label.
 * @returns The SDK `GetSecretValueCommand` input shape.
 */
function buildGetSecretValueInput(
  secretId: string,
  options: M3LGetSecretValueOptions | undefined,
): GetSecretValueCommandInput {
  return {
    SecretId: secretId,
    ...(options?.versionId !== undefined && { VersionId: options.versionId }),
    ...(options?.versionStage !== undefined && {
      VersionStage: options.versionStage,
    }),
  };
}

/**
 * Translates a `GetSecretValueResponse` into a plain {@link M3LSecretValue}
 * — split out of {@link M3LSecretsManagerOperations.getSecretValue} to keep
 * both functions' cyclomatic complexity low.
 *
 * @param response - The raw `GetSecretValueResponse`.
 * @returns The plain, library-owned secret value shape.
 */
function mapSecretValueResponse(
  response: GetSecretValueResponse,
): M3LSecretValue {
  return {
    arn: response.ARN ?? "",
    name: response.Name ?? "",
    versionId: response.VersionId ?? "",
    versionStages: response.VersionStages ?? [],
    ...(response.SecretString !== undefined && {
      secretString: response.SecretString,
    }),
    ...(response.SecretBinary !== undefined && {
      secretBinary: response.SecretBinary,
    }),
  };
}

/**
 * Translates a `DescribeSecretResponse`'s descriptor fields (everything but
 * the ARN/name and the four timestamps) — split out of
 * {@link M3LSecretsManagerOperations.describeSecret} to keep both functions'
 * cyclomatic complexity low.
 *
 * @param response - The raw `DescribeSecretResponse`.
 * @returns The subset of {@link M3LSecretMetadata}'s descriptor fields the SDK populated.
 */
function mapSecretDescriptorFields(
  response: DescribeSecretResponse,
): Partial<
  Pick<
    M3LSecretMetadata,
    | "description"
    | "kmsKeyId"
    | "rotationEnabled"
    | "primaryRegion"
    | "owningService"
    | "tags"
  >
> {
  return {
    ...(response.Description !== undefined && {
      description: response.Description,
    }),
    ...(response.KmsKeyId !== undefined && { kmsKeyId: response.KmsKeyId }),
    ...(response.RotationEnabled !== undefined && {
      rotationEnabled: response.RotationEnabled,
    }),
    ...(response.PrimaryRegion !== undefined && {
      primaryRegion: response.PrimaryRegion,
    }),
    ...(response.OwningService !== undefined && {
      owningService: response.OwningService,
    }),
    ...(response.Tags !== undefined && {
      tags: response.Tags.map((tag) => ({
        key: tag.Key ?? "",
        value: tag.Value ?? "",
      })),
    }),
  };
}

/**
 * Translates a `DescribeSecretResponse`'s four optional timestamp fields —
 * split out of {@link M3LSecretsManagerOperations.describeSecret} to keep
 * both functions' cyclomatic complexity low.
 *
 * @param response - The raw `DescribeSecretResponse`.
 * @returns The subset of {@link M3LSecretMetadata}'s timestamp fields the SDK populated.
 */
function mapSecretTimestampFields(
  response: DescribeSecretResponse,
): Partial<
  Pick<
    M3LSecretMetadata,
    "lastChangedDate" | "lastAccessedDate" | "deletedDate" | "createdDate"
  >
> {
  return {
    ...(response.LastChangedDate !== undefined && {
      lastChangedDate: response.LastChangedDate,
    }),
    ...(response.LastAccessedDate !== undefined && {
      lastAccessedDate: response.LastAccessedDate,
    }),
    ...(response.DeletedDate !== undefined && {
      deletedDate: response.DeletedDate,
    }),
    ...(response.CreatedDate !== undefined && {
      createdDate: response.CreatedDate,
    }),
  };
}

/**
 * Typed operations over a raw Secrets Manager `SecretsManagerClient`: read,
 * create, update, describe, and delete secrets — translating SDK
 * request/response shapes into the plain types in
 * `aws/secrets-manager/types`. Every method retries throttling/network
 * failures internally via `M3LPollingPolicies.awsThrottling()`.
 *
 * @example
 * ```ts
 * import { M3LSecretsManagerOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const secretsManagerOperations = new M3LSecretsManagerOperations(script.aws.clients.secretsManager);
 * const { secretString } = await secretsManagerOperations.getSecretValue("db-password");
 * ```
 */
export class M3LSecretsManagerOperations {
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LSecretsManagerOperations` wrapping the given raw SDK
   * client.
   *
   * @param client - A constructed `SecretsManagerClient` (e.g. `script.aws.clients.secretsManager`).
   */
  constructor(private readonly client: SecretsManagerClient) {
    this.#runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
  }

  /**
   * Retrieves a secret's current (or a specific) value.
   *
   * @param secretId - The ARN or name of the secret to retrieve.
   * @param options - Optionally pins a specific version by id or staging label.
   * @throws {@link M3LSecretsManagerOperationError} if the underlying `GetSecretValue` call fails.
   */
  async getSecretValue(
    secretId: string,
    options?: M3LGetSecretValueOptions,
  ): Promise<M3LSecretValue> {
    const commandInput = buildGetSecretValueInput(secretId, options);
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new GetSecretValueCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LSecretsManagerOperationError(
        `getSecretValue: GetSecretValue failed for secretId=${secretId}`,
        { cause },
      );
    }

    return mapSecretValueResponse(response);
  }

  /**
   * Creates a new secret.
   *
   * @param input - The secret's name and initial value; see {@link M3LCreateSecretInput}.
   * @throws {@link M3LSecretsManagerOperationError} if the underlying `CreateSecret` call fails. The error message never contains the secret's value.
   */
  async createSecret(
    input: M3LCreateSecretInput,
  ): Promise<M3LCreateSecretResult> {
    const commandInput = {
      Name: input.name,
      ...(input.description !== undefined && {
        Description: input.description,
      }),
      ...(input.kmsKeyId !== undefined && { KmsKeyId: input.kmsKeyId }),
      ...(input.secretString !== undefined && {
        SecretString: input.secretString,
      }),
      ...(input.secretBinary !== undefined && {
        SecretBinary: input.secretBinary,
      }),
      ...(input.tags !== undefined && {
        Tags: input.tags.map((tag) => ({ Key: tag.key, Value: tag.value })),
      }),
    };
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new CreateSecretCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LSecretsManagerOperationError(
        `createSecret: CreateSecret failed for name=${input.name}`,
        { cause },
      );
    }

    return {
      arn: response.ARN ?? "",
      name: response.Name ?? "",
      versionId: response.VersionId ?? "",
    };
  }

  /**
   * Adds a new version to an existing secret.
   *
   * @param input - The secret's id and new value; see {@link M3LPutSecretValueInput}.
   * @throws {@link M3LSecretsManagerOperationError} if the underlying `PutSecretValue` call fails. The error message never contains the secret's value.
   */
  async putSecretValue(
    input: M3LPutSecretValueInput,
  ): Promise<M3LPutSecretValueResult> {
    const commandInput = {
      SecretId: input.secretId,
      ...(input.secretString !== undefined && {
        SecretString: input.secretString,
      }),
      ...(input.secretBinary !== undefined && {
        SecretBinary: input.secretBinary,
      }),
    };
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new PutSecretValueCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LSecretsManagerOperationError(
        `putSecretValue: PutSecretValue failed for secretId=${input.secretId}`,
        { cause },
      );
    }

    return {
      arn: response.ARN ?? "",
      name: response.Name ?? "",
      versionId: response.VersionId ?? "",
      versionStages: response.VersionStages ?? [],
    };
  }

  /**
   * Describes a secret's metadata — never its value; `SecretString`/
   * `SecretBinary` are never read from the response, even defensively.
   *
   * @param secretId - The ARN or name of the secret to describe.
   * @throws {@link M3LSecretsManagerOperationError} if the underlying `DescribeSecret` call fails.
   */
  async describeSecret(secretId: string): Promise<M3LSecretMetadata> {
    const commandInput = { SecretId: secretId };
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new DescribeSecretCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LSecretsManagerOperationError(
        `describeSecret: DescribeSecret failed for secretId=${secretId}`,
        { cause },
      );
    }

    return {
      arn: response.ARN ?? "",
      name: response.Name ?? "",
      ...mapSecretDescriptorFields(response),
      ...mapSecretTimestampFields(response),
    };
  }

  /**
   * Deletes a secret, either scheduling it for permanent deletion after a
   * recovery window or deleting it immediately.
   *
   * @param secretId - The ARN or name of the secret to delete.
   * @param options - Optionally overrides the default 30-day recovery window; see {@link M3LDeleteSecretOptions}.
   * @throws {@link M3LSecretsManagerOperationError} if the underlying `DeleteSecret` call fails.
   */
  async deleteSecret(
    secretId: string,
    options?: M3LDeleteSecretOptions,
  ): Promise<M3LDeleteSecretResult> {
    const commandInput = {
      SecretId: secretId,
      ...(options?.recoveryWindowInDays !== undefined && {
        RecoveryWindowInDays: options.recoveryWindowInDays,
      }),
      ...(options?.forceDeleteWithoutRecovery !== undefined && {
        ForceDeleteWithoutRecovery: options.forceDeleteWithoutRecovery,
      }),
    };
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(new DeleteSecretCommand(commandInput)),
      );
    } catch (cause) {
      throw new M3LSecretsManagerOperationError(
        `deleteSecret: DeleteSecret failed for secretId=${secretId}`,
        { cause },
      );
    }

    return {
      arn: response.ARN ?? "",
      name: response.Name ?? "",
      ...(response.DeletionDate !== undefined && {
        deletionDate: response.DeletionDate,
      }),
    };
  }
}
