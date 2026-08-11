/**
 * `aws/secrets-manager/types` — plain, library-owned types at the Secrets
 * Manager operations boundary. None of these carry an
 * `@aws-sdk/client-secrets-manager` type; every
 * {@link M3LSecretsManagerOperations} method translates SDK request/response
 * shapes into these before returning. See
 * `docs/reference/aws/secrets-manager.md` for the full contract.
 *
 * @packageDocumentation
 */

/** A single Secrets Manager resource tag: a key/value pair. */
export interface M3LSecretsManagerTag {
  /** The tag's key. */
  readonly key: string;
  /** The tag's value. */
  readonly value: string;
}

/** Options for {@link M3LSecretsManagerOperations.getSecretValue}. */
export interface M3LGetSecretValueOptions {
  /**
   * The unique identifier of the secret version to retrieve. If both this
   * and `versionStage` are omitted, Secrets Manager returns the
   * `AWSCURRENT` version.
   */
  readonly versionId?: string;
  /** The staging label of the secret version to retrieve. */
  readonly versionStage?: string;
}

/**
 * A secret's value, as returned by
 * {@link M3LSecretsManagerOperations.getSecretValue}. `arn`/`name`/`versionId`
 * default to `""` and `versionStages` to `[]` if the SDK response omits them
 * (a real Secrets Manager response always populates all four). At most one of
 * `secretString`/`secretBinary` is present on a real Secrets Manager response
 * (mirroring `GetSecretValueResponse`'s own equally-loose optionality — this
 * module does not independently enforce or re-validate which); each field is
 * omitted entirely (not `undefined`) when the SDK response does not carry it.
 */
export interface M3LSecretValue {
  /** The secret's Amazon Resource Name (ARN). */
  readonly arn: string;
  /** The secret's friendly name. */
  readonly name: string;
  /** The unique identifier of this version of the secret. */
  readonly versionId: string;
  /** The staging labels currently attached to this version of the secret. */
  readonly versionStages: readonly string[];
  /** The decrypted secret value, when the secret was stored as a string. */
  readonly secretString?: string;
  /** The decrypted secret value, when the secret was stored as binary data. */
  readonly secretBinary?: Uint8Array;
}

/**
 * Input for {@link M3LSecretsManagerOperations.createSecret}. Exactly one of
 * `secretString`/`secretBinary` must be supplied — the discriminated union
 * makes supplying both, or neither, a compile-time error.
 */
export type M3LCreateSecretInput = {
  /** The name of the new secret. */
  readonly name: string;
  /** A description of the secret. */
  readonly description?: string;
  /** The KMS key used to encrypt the secret value; defaults to the AWS-managed key when omitted. */
  readonly kmsKeyId?: string;
  /** Tags applied to the new secret. */
  readonly tags?: readonly M3LSecretsManagerTag[];
} & (
  | { readonly secretString: string; readonly secretBinary?: never }
  | { readonly secretBinary: Uint8Array; readonly secretString?: never }
);

/** The result of a successful {@link M3LSecretsManagerOperations.createSecret} call. */
export interface M3LCreateSecretResult {
  /** The Amazon Resource Name (ARN) of the new secret. */
  readonly arn: string;
  /** The name of the new secret. */
  readonly name: string;
  /** The unique identifier of the initial version of the new secret. */
  readonly versionId: string;
}

/**
 * Input for {@link M3LSecretsManagerOperations.putSecretValue}. Exactly one
 * of `secretString`/`secretBinary` must be supplied — the discriminated
 * union makes supplying both, or neither, a compile-time error.
 */
export type M3LPutSecretValueInput = {
  /** The ARN or name of the secret to add a new version to. */
  readonly secretId: string;
} & (
  | { readonly secretString: string; readonly secretBinary?: never }
  | { readonly secretBinary: Uint8Array; readonly secretString?: never }
);

/** The result of a successful {@link M3LSecretsManagerOperations.putSecretValue} call. */
export interface M3LPutSecretValueResult {
  /** The Amazon Resource Name (ARN) of the secret. */
  readonly arn: string;
  /** The name of the secret. */
  readonly name: string;
  /** The unique identifier of the new version of the secret. */
  readonly versionId: string;
  /** The staging labels currently attached to this version of the secret. */
  readonly versionStages: readonly string[];
}

/**
 * A secret's metadata, as returned by
 * {@link M3LSecretsManagerOperations.describeSecret}. `arn`/`name` default to
 * `""` if the SDK response omits them; every other field is omitted entirely
 * (not `undefined`) when the SDK response does not carry it. Never carries
 * the secret's value — `describeSecret` never reads `SecretString`/
 * `SecretBinary`, even defensively, since `DescribeSecretResponse` does not
 * expose them.
 */
export interface M3LSecretMetadata {
  /** The secret's Amazon Resource Name (ARN). */
  readonly arn: string;
  /** The secret's friendly name. */
  readonly name: string;
  /** A description of the secret. */
  readonly description?: string;
  /** The KMS key used to encrypt the secret value. */
  readonly kmsKeyId?: string;
  /** Whether automatic rotation is turned on for this secret. */
  readonly rotationEnabled?: boolean;
  /** The last date and time this secret was modified in any way. */
  readonly lastChangedDate?: Date;
  /** The date this secret was last accessed in the Region. */
  readonly lastAccessedDate?: Date;
  /** The date this secret is scheduled for deletion, when scheduled. */
  readonly deletedDate?: Date;
  /** The date this secret was created. */
  readonly createdDate?: Date;
  /** The Region where this secret was originally created. */
  readonly primaryRegion?: string;
  /** The AWS service that owns this secret, when it is a service-managed secret. */
  readonly owningService?: string;
  /** The tags attached to this secret. */
  readonly tags?: readonly M3LSecretsManagerTag[];
}

/**
 * Options for {@link M3LSecretsManagerOperations.deleteSecret}. `recoveryWindowInDays`
 * and `forceDeleteWithoutRecovery` are mutually exclusive — the discriminated
 * union makes supplying both a compile-time error, while supplying neither
 * (or no options at all) remains legal and lets Secrets Manager apply its
 * default 30-day recovery window.
 */
export type M3LDeleteSecretOptions =
  | {
      /** The number of days (7–30) Secrets Manager waits before permanently deleting the secret. */
      readonly recoveryWindowInDays: number;
      readonly forceDeleteWithoutRecovery?: never;
    }
  | {
      /** Deletes the secret immediately, without any recovery window. */
      readonly forceDeleteWithoutRecovery: true;
      readonly recoveryWindowInDays?: never;
    }
  | {
      readonly recoveryWindowInDays?: never;
      readonly forceDeleteWithoutRecovery?: never;
    };

/** The result of a successful {@link M3LSecretsManagerOperations.deleteSecret} call. */
export interface M3LDeleteSecretResult {
  /** The Amazon Resource Name (ARN) of the deleted secret. */
  readonly arn: string;
  /** The name of the deleted secret. */
  readonly name: string;
  /** The date/time after which Secrets Manager can permanently delete the secret, when scheduled for deletion. */
  readonly deletionDate?: Date;
}
