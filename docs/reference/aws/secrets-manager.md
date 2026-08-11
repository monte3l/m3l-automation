# Secrets Manager

`M3LSecretsManagerOperations` is a typed wrapper over a raw
`SecretsManagerClient`, so callers never import `@aws-sdk/client-secrets-manager`
command classes directly. Covers retrieving, creating, updating, describing,
and deleting a secret — the gap an internal capability audit of the library's
AWS surface found: automation scripts routinely need to pull a credential or
config value out of Secrets Manager at runtime, but no consumable operation
surface existed for it (the same shape of gap ADR-0027 closed for
`aws/eventbridge`/`aws/sqs`/`aws/cloudwatch-alarms`).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LSecretsManagerOperations` wraps
the `secretsManager` client, translating SDK request/response shapes into
plain, library-owned types so a caller never touches an
`@aws-sdk/client-secrets-manager` type.

- `M3LSecretsManagerOperations` — the wrapper class, constructed from a raw `SecretsManagerClient`.
- `M3LSecretsManagerOperationError` — thrown on a request-level secrets-operation failure.
- Plain types: `M3LSecretValue`, `M3LGetSecretValueOptions`,
  `M3LCreateSecretInput`, `M3LCreateSecretResult`, `M3LPutSecretValueInput`,
  `M3LPutSecretValueResult`, `M3LSecretMetadata`, `M3LDeleteSecretOptions`,
  `M3LDeleteSecretResult`, `M3LSecretsManagerTag`.

## Scope

**In scope:** the five operations a consumer script needs to read and
manage a secret's lifecycle — `GetSecretValue`, `CreateSecret`,
`PutSecretValue`, `DescribeSecret`, `DeleteSecret`.

**Out of scope for this iteration:**

- **Rotation** (`RotateSecret`, `CancelRotateSecret`, `UpdateSecretVersionStage`,
  rotation Lambda wiring) — `describeSecret`'s result surfaces
  `rotationEnabled` for read visibility, but configuring or triggering
  rotation is not modeled. Add the corresponding method when a consumer
  needs one (ADR-0027's per-consumer-need pattern).
- **Restore** (`RestoreSecret`, undoing a scheduled deletion) — not modeled;
  `deleteSecret`'s recovery window is the only lifecycle lever exposed.
- **Batch retrieval** (`BatchGetSecretValue`) — `getSecretValue` is one
  secret per call, mirroring every other wrapper's one-shot-call convention
  (`M3LEventBridgeOperations.listRules`, `M3LCloudWatchAlarmsOperations.describeAlarms`).
- **Listing** (`ListSecrets`) and **tag mutation** (`TagResource`,
  `UntagResource`) — `createSecret` accepts `tags` at creation time and
  `describeSecret` surfaces existing tags for read visibility, but there is
  no standalone list or tag-mutation method yet.
- **Replication** (`AddReplicaRegions`, `ForceOverwriteReplicaSecret`,
  `ReplicaRegionType`) and **managed external secrets** (`Type`,
  `ExternalSecretRotationMetadata`) — cross-account/cross-region and
  partner-managed-secret fields are not modeled.
- **Creating a secret with no initial value** — `CreateSecret`'s
  `SecretString`/`SecretBinary` are technically optional on the SDK (a
  metadata-only secret populated later by a rotation Lambda), but
  `createSecret` requires exactly one, matching `putSecretValue`'s existing
  requirement and the common automation-script case of "create with a
  value." Add the no-initial-value path when a consumer needs it.
- **`GetSecretValue`'s `CreatedDate`** is not surfaced on `M3LSecretValue`.
- **The `ClientRequestToken` idempotency token** (`CreateSecret`/
  `PutSecretValue`) is not exposed — the SDK auto-generates one.
- **`PutSecretValue`'s `VersionStages`/`RotationToken` request fields** are
  not exposed.

## Public API

### `M3LSecretsManagerOperations`

**Constructor** — `new M3LSecretsManagerOperations(client)`, where `client`
is a raw `SecretsManagerClient` (e.g. `script.aws.clients.secretsManager`).

| Method                               | Retried? | Returns                            | Throws                            |
| ------------------------------------ | -------- | ---------------------------------- | --------------------------------- |
| `getSecretValue(secretId, options?)` | Yes      | `Promise<M3LSecretValue>`          | `M3LSecretsManagerOperationError` |
| `createSecret(input)`                | Yes      | `Promise<M3LCreateSecretResult>`   | `M3LSecretsManagerOperationError` |
| `putSecretValue(input)`              | Yes      | `Promise<M3LPutSecretValueResult>` | `M3LSecretsManagerOperationError` |
| `describeSecret(secretId)`           | Yes      | `Promise<M3LSecretMetadata>`       | `M3LSecretsManagerOperationError` |
| `deleteSecret(secretId, options?)`   | Yes      | `Promise<M3LDeleteSecretResult>`   | `M3LSecretsManagerOperationError` |

**Retry:** every method wraps its SDK `.send()` call in `M3LRetryRunner`
configured by `M3LPollingPolicies.awsThrottling()` (throttling/network
classifiers, exponential-jittered backoff 200ms→5s), mirroring every other
`aws/*` operations wrapper's uniform retry of both read and mutating calls.

### `M3LSecretsManagerOperationError`

Subclass of `M3LError` with `code: "ERR_SECRETS_MANAGER_OPERATION"`. Thrown
when the underlying `GetSecretValue`/`CreateSecret`/`PutSecretValue`/
`DescribeSecret`/`DeleteSecret` call rejects after retries. The originating
SDK error is chained via `cause`.

### Plain types

- **`M3LGetSecretValueOptions`** — `{ versionId?, versionStage? }`. When
  both are omitted, Secrets Manager returns the `AWSCURRENT` version.
- **`M3LSecretValue`** — `{ arn, name, versionId, versionStages,
secretString?, secretBinary? }` — the `getSecretValue` result. `arn`/`name`/
  `versionId` default to `""` and `versionStages` defaults to `[]` if the SDK
  response omits them (a real response always populates all four);
  `secretString`/`secretBinary` are omitted rather than defaulted when the
  SDK leaves them `undefined` (a secret always has exactly one populated on a
  real response, never both).
- **`M3LSecretsManagerTag`** — `{ key, value }`, a plain tag pair. Both
  fields default to `""` if the SDK response omits them (the SDK's own `Tag`
  type declares both optional).
- **`M3LCreateSecretInput`** — `{ name, description?, kmsKeyId?, tags? }`
  plus **exactly one** of `secretString`/`secretBinary` (a discriminated
  union — providing both, or neither, is a compile-time error).
- **`M3LCreateSecretResult`** — `{ arn, name, versionId }` — `arn`/`name`/
  `versionId` default to `""` if the SDK response omits them.
- **`M3LPutSecretValueInput`** — `{ secretId }` plus **exactly one** of
  `secretString`/`secretBinary` (same discriminated-union shape as
  `M3LCreateSecretInput`).
- **`M3LPutSecretValueResult`** — `{ arn, name, versionId, versionStages }`
  — `arn`/`name`/`versionId` default to `""` and `versionStages` defaults to
  `[]` if the SDK response omits them.
- **`M3LSecretMetadata`** — `{ arn, name, description?, kmsKeyId?,
rotationEnabled?, lastChangedDate?, lastAccessedDate?, deletedDate?,
createdDate?, primaryRegion?, owningService?, tags? }` — the
  `describeSecret` result. `arn`/`name` default to `""` if the SDK response
  omits them; every other field is omitted rather than defaulted. **Never**
  includes the secret's value — `DescribeSecret` is a metadata-only
  operation on the AWS side.
- **`M3LDeleteSecretOptions`** — **at most one** of `recoveryWindowInDays`/
  `forceDeleteWithoutRecovery` (a discriminated union — providing both is a
  compile-time error; providing neither is legal and defaults to a 30-day
  recovery window on the AWS side).
- **`M3LDeleteSecretResult`** — `{ arn, name, deletionDate? }` — `arn`/`name`
  default to `""` if the SDK response omits them; `deletionDate` is present
  whenever the SDK response carries it (both the recovery-window and the
  `forceDeleteWithoutRecovery` path can populate it) and omitted otherwise.

## Usage

### From within a script

```typescript
const secretsManagerOperations = new AWS.M3LSecretsManagerOperations(
  script.aws.clients.secretsManager,
);

const { secretString } = await secretsManagerOperations.getSecretValue(
  "prod/nightly-job/api-key",
);

await secretsManagerOperations.putSecretValue({
  secretId: "prod/nightly-job/api-key",
  secretString: rotatedKey,
});
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});
const secretsManagerOperations = new AWS.M3LSecretsManagerOperations(
  provider.secretsManager,
);
```

## Notes and behavior

- No `@aws-sdk/client-secrets-manager` type ever appears in this module's
  public surface — every request/response shape is translated to a plain
  type in `aws/secrets-manager/types.ts` at the boundary.
- **The library never writes a secret value into a message it constructs.**
  No method interpolates `secretString`/`secretBinary` into an
  `M3LSecretsManagerOperationError`'s message — only an identifier
  (`secretId`, or `name` for `createSecret`, since it has no `secretId`
  field) ever appears there. This guarantee covers only the library's own
  message text: every method chains the raw SDK rejection via `cause`
  unmodified, and a real AWS error does not echo request parameters, but the
  `cause` chain is not independently sanitized by this module — a caller
  that logs `error.cause` or `error.toJSON()` verbatim inherits whatever the
  underlying rejection actually contained. The library does not log by
  default and this module carries no logging call of its own; a consumer
  script that chooses to log a retrieved `M3LSecretValue` itself can route it
  through [`redactSensitiveLogValue`](../core/logging.md) — the field names
  `secretString`/`secretBinary` are recognized by that helper's sensitive-key
  matching (note: this applies to the _value_ form; redacting a
  pre-`JSON.stringify`'d string does not catch a `secretBinary` byte array,
  since only quoted string values are matched there).
- `M3LSecretsManagerOperations` holds no destroyable resource of its own; it
  shares its injected client's connection lifecycle. When constructed from
  `AWSClientProvider.secretsManager`, that underlying raw client is destroyed
  by `provider.close()` — there is no separate `secretsManagerOperations`
  wrapper instance for `close()` to track (unlike `sqsOperations`/
  `eventBridgeOperations` on `AWSClientProvider`).
- `core/polling` is used here under the same Zone A exception ADR-0026
  recorded for `aws/sqs` (`aws/**` may otherwise import only
  `core/errors`/`core/prompt`); this module does not widen that exception
  further, it just uses the edge already opened.

## See also

- [AWS Clients](./clients.md) — the raw `secretsManager` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on; also reachable as
  `AWSServiceProvider.secretsManager` (`script.aws.services.secretsManager`).
- [EventBridge Operations](./eventbridge.md) and
  [CloudWatch Alarms](./cloudwatch-alarms.md) — sibling wrappers this
  module's shape mirrors, and [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md)
  for the typed-wrapper-per-consumer-need decision this module implements.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
- [Logging](../core/logging.md) — `redactSensitiveLogValue`, for a consumer
  script that logs a retrieved secret value itself.
