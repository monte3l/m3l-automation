# AWS Clients

`AWSClientProvider` and `AWSMultiClientProvider` create and lazily cache raw AWS SDK v3 clients, resolving credentials per profile: they expose the underlying SDK clients directly.

## Overview

The client layer hands callers ready-to-use AWS SDK v3 clients with credentials already wired up:

- `AWSClientProvider` manages SDK clients for a **single** profile, caching each client lazily on first access.
- `AWSMultiClientProvider` manages a map of `AWSClientProvider` instances keyed by profile name, with helpers to run an operation across all profiles.
- `AWSProvider` is the facade exposed on `M3LScript` instances as `script.aws`.

Credential resolution is profile-aware: when a profile name is supplied it uses `fromIni()` (SSO-aware) from `@aws-sdk/credential-provider-ini`; otherwise it falls back to the AWS SDK default credential chain.

The AWS SDK v3 service-client packages are **hard runtime dependencies** of `@m3l-automation/m3l-common` (pinned exact, like `undici`), so the client getters are **synchronous** — no `await` is needed to obtain a client.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `AWSClientProvider` — single-profile, lazily-cached SDK client provider.
- `AWSMultiClientProvider` — multi-profile provider with parallel-map helpers.
- `AWSProvider` — facade exposed via `script.aws`.
- `AWS_REGION` — default region constant, a pre-validated [`M3LAWSRegion`](./models.md); `'eu-south-1'` (Milan) when unspecified.
- `M3LAWSClientError` — typed error (`code: "ERR_AWS_CLIENT"`) thrown when SDK client construction or credential resolution fails.

### `AWSClientProvider`

For a single profile, `AWSClientProvider` creates and lazily caches AWS SDK v3 clients, each constructed on first access and reused thereafter.

**Constructor** — `new AWSClientProvider(options?)`, where `options` is:

| Option    | Type                           | Default      | Meaning                                                                                                                              |
| --------- | ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `profile` | [`M3LAWSProfile`](./models.md) | _(none)_     | Named AWS profile; when set, credentials resolve via `fromIni({ profile })`. When omitted, the SDK default credential chain is used. |
| `region`  | [`M3LAWSRegion`](./models.md)  | `AWS_REGION` | Region passed to every client this provider constructs. Overrides the `AWS_REGION` default.                                          |

**Service-client getters** — each is synchronous, constructs its client on first access, and caches it for the provider's lifetime:

| Getter           | SDK client class       | Package                          |
| ---------------- | ---------------------- | -------------------------------- |
| `s3`             | `S3Client`             | `@aws-sdk/client-s3`             |
| `dynamoDB`       | `DynamoDBClient`       | `@aws-sdk/client-dynamodb`       |
| `sts`            | `STSClient`            | `@aws-sdk/client-sts`            |
| `eventBridge`    | `EventBridgeClient`    | `@aws-sdk/client-eventbridge`    |
| `lambda`         | `LambdaClient`         | `@aws-sdk/client-lambda`         |
| `ec2`            | `EC2Client`            | `@aws-sdk/client-ec2`            |
| `ecs`            | `ECSClient`            | `@aws-sdk/client-ecs`            |
| `cloudFormation` | `CloudFormationClient` | `@aws-sdk/client-cloudformation` |
| `codePipeline`   | `CodePipelineClient`   | `@aws-sdk/client-codepipeline`   |
| `apiGateway`     | `APIGatewayClient`     | `@aws-sdk/client-api-gateway`    |
| `eks`            | `EKSClient`            | `@aws-sdk/client-eks`            |
| `cloudWatch`     | `CloudWatchClient`     | `@aws-sdk/client-cloudwatch`     |
| `ssm`            | `SSMClient`            | `@aws-sdk/client-ssm`            |
| `sqs`            | `SQSClient`            | `@aws-sdk/client-sqs`            |

Other members:

- Credential resolution — uses `fromIni({ profile })` for a named profile, otherwise the SDK default credential chain.
- `close()` — calls `.destroy()` on every cached client and clears the cache. It is best-effort: a throwing `.destroy()` does not abort the sweep — the remaining clients are still destroyed and the cache is always cleared. If any `.destroy()` threw, `close()` then throws a single `M3LAWSClientError` (`code: "ERR_AWS_CLIENT"`) whose `cause` collects the per-service failures.

When SDK client construction or credential resolution fails, the getter throws `M3LAWSClientError` with the underlying SDK error chained via `cause`.

### `AWSMultiClientProvider`

Manages a map of `AWSClientProvider` instances keyed by profile name.

**Constructor** — `new AWSMultiClientProvider({ profiles })`, where `profiles` is a `readonly M3LAWSProfile[]` (each built via [`parseAWSProfile`](./models.md)). Names are **deduplicated** on construction, and one `AWSClientProvider` is created per distinct profile.

- `mapParallel<T>(fn)` — runs `fn(provider)` across all profiles in parallel and resolves to the array of results, **rejecting if any operation throws**.
- `mapParallelSettled<T>(fn)` — runs `fn(provider)` across all profiles and collects per-profile results and errors **without throwing**.

### `AWSProvider`

The facade exposed by `M3LScript` via `script.aws`. It lazily instantiates its sub-provider from a shared configuration and exposes it through a `clients` getter (a single-profile `AWSClientProvider`).

`AWSProvider` is a standalone facade; `M3LScript` constructs it and assigns it to `script.aws` during the AWS stage of its lifecycle (see [Script](../core/script.md)).

### `M3LAWSClientError`

Subclass of `M3LError` with `code: "ERR_AWS_CLIENT"`. Thrown when an SDK client cannot be constructed or credentials cannot be resolved. The originating SDK error is chained via the standard `cause` option, so callers can narrow on `code === "ERR_AWS_CLIENT"` and inspect `error.cause` for the root failure. Callers _catch_ this error; its constructor-options shape is not part of the public API.

## Usage

### Get a client for a single profile

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});

// Each client is created lazily on first access and cached thereafter.
const s3 = provider.s3;
const dynamo = provider.dynamoDB;

// Release all cached clients when done.
provider.close();
```

### Override the region

```typescript
import { AWS } from "@m3l-automation/m3l-common";

// Without `region`, clients default to AWS_REGION ('eu-south-1').
const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
  region: AWS.parseAWSRegion("us-east-1"),
});
```

### Run an operation across multiple profiles

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const multi = new AWS.AWSMultiClientProvider({
  profiles: [
    AWS.parseAWSProfile("profile-a"),
    AWS.parseAWSProfile("profile-b"),
  ],
});

// Parallel across profiles; rejects if any throws.
await multi.mapParallel((p) => p.s3 /* ...use the client... */);

// Parallel across profiles; never throws — collects results and errors.
const settled = await multi.mapParallelSettled((p) => p.s3 /* ... */);
```

### From within a script

```typescript
// Inside an M3LScript main function, the facade is available as script.aws
// once the config schema declares an `aws.profile` parameter.
const s3 = script.aws.clients.s3;
```

## Notes and behavior

- **Lazy caching:** each SDK client is created on first access and reused on subsequent access within the same `AWSClientProvider`.
- **Synchronous getters:** the SDK packages are hard dependencies, so getters return a client without `await`.
- **Region:** clients default to `AWS_REGION` (`'eu-south-1'`, Milan); a per-provider `region` option overrides it.
- **Credential resolution:** `fromIni({ profile })` is used for a named profile (SSO-aware); without a profile, the SDK default credential chain is used.
- **Error handling:** SDK construction / credential-resolution failures surface as `M3LAWSClientError` with the SDK error chained via `cause`.
- **Lifecycle in Lambda:** the SDK client cache is intentionally persisted across Lambda invocations to reuse connections. Per-invocation state reset does not tear down the client providers.
- **`close()`** destroys all cached clients on an `AWSClientProvider` (best-effort — it destroys the rest even if one `.destroy()` throws, always clears the cache, then throws an aggregated `M3LAWSClientError` if any failed).
- **Deduplication:** `AWSMultiClientProvider` deduplicates profile names on construction.

## See also

- [AWS credentials](./credentials.md) — validating and refreshing the credentials these clients use.
- [AWS models](./models.md) — shared AWS model types.
- [Lambda handlers](../../guides/lambda-handlers.md) — connection reuse across invocations.
- [Script](../core/script.md) — the `script.aws` facade.
