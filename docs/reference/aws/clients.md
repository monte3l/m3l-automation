# AWS Clients

`AWSClientProvider` and `AWSMultiClientProvider` create and lazily cache raw AWS SDK v3 clients, resolving credentials per profile: `AWSClientProvider`'s primary getters expose the underlying SDK clients directly, plus four deprecated pre-`.services` convenience wrappers kept for compatibility (see [`AWSServiceProvider`](#awsserviceprovider) below, [ADR-0038](../../adr/0038-sqs-dlq-redrive-and-aws-services-tier.md)).

## Overview

The client layer hands callers ready-to-use AWS SDK v3 clients with credentials already wired up:

- `AWSClientProvider` manages SDK clients for a **single** profile, caching each client lazily on first access.
- `AWSMultiClientProvider` manages a map of `AWSClientProvider` instances keyed by profile name, with helpers to run an operation across all profiles.
- `AWSProvider` is the facade exposed on `M3LScript` instances as `script.aws`, exposing both a `clients` getter (raw SDK clients, `AWSClientProvider`) and a `services` getter (library-owned wrapper objects, `AWSServiceProvider`).

Credential resolution is profile-aware: when a profile name is supplied it uses `fromIni()` (SSO-aware) from `@aws-sdk/credential-provider-ini`; otherwise it falls back to the AWS SDK default credential chain.

The AWS SDK v3 service-client packages are **hard runtime dependencies** of `@m3l-automation/m3l-common` (pinned exact, like `undici`), so the client getters are **synchronous** — no `await` is needed to obtain a client.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `AWSClientProvider` — single-profile, lazily-cached SDK client provider.
- `AWSMultiClientProvider` — multi-profile provider with parallel-map helpers.
- `AWSProvider` — facade exposed via `script.aws`.
- `AWSServiceProvider` — single-profile, lazily-cached library-owned wrapper-object provider; exposed via `AWSProvider.services`.
- `AWS_REGION` — default region constant, a pre-validated [`M3LAWSRegion`](./models.md); `'eu-south-1'` (Milan) when unspecified.
- `M3LAWSClientError` — typed error (`code: "ERR_AWS_CLIENT"`) thrown when SDK client construction or credential resolution fails.

### `AWSClientProvider`

For a single profile, `AWSClientProvider` creates and lazily caches AWS SDK v3 clients, each constructed on first access and reused thereafter.

**Constructor** — `new AWSClientProvider(options?)`, where `options` is:

| Option    | Type                           | Default      | Meaning                                                                                                                              |
| --------- | ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `profile` | [`M3LAWSProfile`](./models.md) | _(none)_     | Named AWS profile; when set, credentials resolve via `fromIni({ profile })`. When omitted, the SDK default credential chain is used. |
| `region`  | [`M3LAWSRegion`](./models.md)  | `AWS_REGION` | Region passed to every client this provider constructs. Overrides the `AWS_REGION` default.                                          |

The constructor's `profile`/`region` are also readable back afterward as
public readonly getters of the same name (`provider.profile`,
`provider.region`) — not just constructor inputs. This makes the provider
itself the single source of truth for its resolved identity: any other class
holding a reference to an `AWSClientProvider` (e.g. `AWSServiceProvider`, see
below) can read `profile`/`region` off it directly instead of needing a
second, independently-supplied copy.

**Service-client getters** — each is synchronous, constructs its client on first access, and caches it for the provider's lifetime:

| Getter             | SDK client class         | Package                           |
| ------------------ | ------------------------ | --------------------------------- |
| `s3`               | `S3Client`               | `@aws-sdk/client-s3`              |
| `dynamoDB`         | `DynamoDBClient`         | `@aws-sdk/client-dynamodb`        |
| `dynamoDBDocument` | `DynamoDBDocumentClient` | `@aws-sdk/lib-dynamodb`           |
| `sts`              | `STSClient`              | `@aws-sdk/client-sts`             |
| `eventBridge`      | `EventBridgeClient`      | `@aws-sdk/client-eventbridge`     |
| `lambda`           | `LambdaClient`           | `@aws-sdk/client-lambda`          |
| `ec2`              | `EC2Client`              | `@aws-sdk/client-ec2`             |
| `ecs`              | `ECSClient`              | `@aws-sdk/client-ecs`             |
| `cloudFormation`   | `CloudFormationClient`   | `@aws-sdk/client-cloudformation`  |
| `codePipeline`     | `CodePipelineClient`     | `@aws-sdk/client-codepipeline`    |
| `apiGateway`       | `APIGatewayClient`       | `@aws-sdk/client-api-gateway`     |
| `eks`              | `EKSClient`              | `@aws-sdk/client-eks`             |
| `cloudWatch`       | `CloudWatchClient`       | `@aws-sdk/client-cloudwatch`      |
| `cloudWatchLogs`   | `CloudWatchLogsClient`   | `@aws-sdk/client-cloudwatch-logs` |
| `athena`           | `AthenaClient`           | `@aws-sdk/client-athena`          |
| `ssm`              | `SSMClient`              | `@aws-sdk/client-ssm`             |
| `sqs`              | `SQSClient`              | `@aws-sdk/client-sqs`             |
| `secretsManager`   | `SecretsManagerClient`   | `@aws-sdk/client-secrets-manager` |

Most getters construct a fresh SDK client from the resolved region and
credentials. Two behave specially:

- **`dynamoDBDocument`** returns a `DynamoDBDocumentClient` (from
  `@aws-sdk/lib-dynamodb`) built via `DynamoDBDocumentClient.from(this.dynamoDB)`
  so callers work with plain JavaScript objects instead of raw `AttributeValue`
  shapes. It is **not** constructed from a fresh config — it wraps this
  provider's underlying `dynamoDB` client and **shares its connection
  lifecycle**. First access lazily constructs and caches the underlying
  `dynamoDB` client too; `close()` destroys that underlying `dynamoDB` client,
  and the document wrapper is **not** destroyed independently (doing so would
  double-destroy the shared connection). Its cached reference is cleared with
  the rest.
- **`cloudWatchLogs`** and **`athena`** provide the clients for the polling
  flows already shipped in `core/polling`: `cloudWatchLogs` drives the Logs
  Insights `StartQuery`/`GetQueryResults` cycle that
  `M3LPollingPolicies.cloudWatchLogsQuery()` polls, and `athena` pairs with
  `M3LPollingPolicies.athenaQuery()` for Athena query execution.

**Convenience getters** — unlike the service-client getters above, these
return a library-owned wrapper object rather than a raw AWS SDK client, but
are cached the same lazy-on-first-access way. **All four are `@deprecated`**
(TSDoc tag only, not a runtime warning) in favor of their
[`AWSServiceProvider`](#awsserviceprovider) equivalent — kept functional
indefinitely, not scheduled for removal (removing them would source-break the
four consumer scripts already built against `.clients.<name>`; see
[ADR-0038](../../adr/0038-sqs-dlq-redrive-and-aws-services-tier.md)):

| Getter                  | Returns                                        | `.services` equivalent           | Notes                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqsOperations`         | [`M3LSQSOperations`](./sqs.md)                 | `services.sqsOperations`         | Constructed from this provider's `sqs` client (`new M3LSQSOperations(this.sqs)`). Shares the underlying `sqs` client's connection lifecycle — see below.                                 |
| `eventBridgeOperations` | [`M3LEventBridgeOperations`](./eventbridge.md) | `services.eventBridgeOperations` | Constructed from this provider's `eventBridge` client (`new M3LEventBridgeOperations(this.eventBridge)`). Shares the underlying `eventBridge` client's connection lifecycle — see below. |
| `requestSigner`         | [`M3LRequestSigner`](./signing.md)             | `services.requestSigner`         | Built from this provider's own resolved `profile`/`region`. Holds no destroyable resource of its own — its cache is cleared, not independently destroyed, by `close()`.                  |
| `dynamoDBDocument`      | `DynamoDBDocumentClient` (see above)           | `services.dynamoDBDocument`      | Documented above with the service-client getters — it is a raw (document-layer) SDK client, not a library-owned wrapper, but is grouped here per ADR-0038's four-getter accounting.      |

Other members:

- Credential resolution — uses `fromIni({ profile })` for a named profile, otherwise the SDK default credential chain.
- `close()` — calls `.destroy()` on every cached client and clears the cache (the `dynamoDBDocument` wrapper shares the `dynamoDB` client's lifecycle and is not destroyed separately). It is best-effort: a throwing `.destroy()` does not abort the sweep — the remaining clients are still destroyed and the cache is always cleared. If any `.destroy()` threw, `close()` then throws a single `M3LAWSClientError` (`code: "ERR_AWS_CLIENT"`) whose `cause` collects the per-service failures.

When SDK client construction or credential resolution fails, the getter throws `M3LAWSClientError` with the underlying SDK error chained via `cause`.

### `AWSMultiClientProvider`

Manages a map of `AWSClientProvider` instances keyed by profile name.

**Constructor** — `new AWSMultiClientProvider({ profiles })`, where `profiles` is a `readonly M3LAWSProfile[]` (each built via [`parseAWSProfile`](./models.md)). Names are **deduplicated** on construction, and one `AWSClientProvider` is created per distinct profile.

- `mapParallel<T>(fn)` — runs `fn(provider)` across all profiles in parallel and resolves to the array of results, **rejecting if any operation throws**.
- `mapParallelSettled<T>(fn)` — runs `fn(provider)` across all profiles and collects per-profile results and errors **without throwing**.

### `AWSProvider`

The facade exposed by `M3LScript` via `script.aws`. It lazily instantiates its sub-provider(s) from a shared configuration and exposes two independent, independently-cached facades: a `clients` getter (raw SDK clients, a single-profile `AWSClientProvider`) and a `services` getter (library-owned wrapper objects, a single-profile `AWSServiceProvider`). Both share the same underlying `AWSClientProvider` instance — `services` is constructed with a reference to the already-lazily-built `clients` provider, so a raw client and its `.services` wrapper equivalent (e.g. `.clients.sqs` and the `SQSClient` underlying `.services.sqsOperations`) always resolve credentials once and share one connection, never two.

`AWSProvider` is a standalone facade; `M3LScript` constructs it and assigns it to `script.aws` during the AWS stage of its lifecycle (see [Script](../core/script.md)).

### `AWSServiceProvider`

For a single profile, `AWSServiceProvider` lazily constructs and caches
**library-owned wrapper objects** — the typed `M3L*Operations`/`M3L*Client`
classes each AWS submodule exports — over the raw SDK clients an
`AWSClientProvider` already provides. It is the consistent, single access
path ADR-0038 introduces: every wrapper submodule is reachable as
`provider.services.<name>` without the caller constructing it by hand.

**Constructor** — `new AWSServiceProvider(clientProvider)`, where
`clientProvider` is the `AWSClientProvider` this provider pulls raw clients
from (never constructed independently — always the same instance
`AWSProvider.clients` already lazily built, so no client is ever
double-constructed). There is no separate `options` parameter: the two
getters below that are **not** built from a raw client (`requestSigner`,
`credentials`) read `clientProvider.profile`/`clientProvider.region`
directly instead of taking their own independently-supplied
`profile`/`region`. This closes off a divergence the earlier two-parameter
constructor allowed — a caller passing a `clientProvider` for one profile and
`options` for a different profile would produce one `AWSServiceProvider`
instance whose getters silently authenticated as two different identities;
`clientProvider` is now the single source of truth for every getter on this
class.

**Service getters** — each is synchronous, constructs its wrapper on first
access, and caches it for the provider's lifetime. Every entry except
`dynamoDBDocument` is a **new** wrapper instance distinct from its
`.clients.<name>` equivalent (a fresh, lightweight object wrapping the same
underlying, still-shared SDK client — see `AWSProvider` above):

| Getter                   | Returns                                                     | Built from                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqsOperations`          | [`M3LSQSOperations`](./sqs.md)                              | `clientProvider.sqs`                                                                                                                                              |
| `eventBridgeOperations`  | [`M3LEventBridgeOperations`](./eventbridge.md)              | `clientProvider.eventBridge`                                                                                                                                      |
| `requestSigner`          | [`M3LRequestSigner`](./signing.md)                          | `clientProvider.profile`/`clientProvider.region` (not a raw client)                                                                                               |
| `dynamoDBDocument`       | `DynamoDBDocumentClient`                                    | **passthrough** — returns `clientProvider.dynamoDBDocument` directly; no separate library-owned wrapper class exists for it, so there is nothing new to construct |
| `athena`                 | [`M3LAthenaClient`](./athena.md)                            | `clientProvider.athena`                                                                                                                                           |
| `cloudFormation`         | [`M3LCloudFormationOperations`](./cloudformation.md)        | `clientProvider.cloudFormation`                                                                                                                                   |
| `cloudWatchAlarms`       | [`M3LCloudWatchAlarmsOperations`](./cloudwatch-alarms.md)   | `clientProvider.cloudWatch`                                                                                                                                       |
| `cloudWatchLogsInsights` | [`M3LLogsInsightsClient`](./cloudwatch-logs-insights.md)    | `clientProvider.cloudWatchLogs`                                                                                                                                   |
| `cloudWatchMetrics`      | [`M3LCloudWatchMetricsOperations`](./cloudwatch-metrics.md) | `clientProvider.cloudWatch`                                                                                                                                       |
| `codePipeline`           | [`M3LCodePipelineOperations`](./codepipeline.md)            | `clientProvider.codePipeline`                                                                                                                                     |
| `ecs`                    | [`M3LECSOperations`](./ecs.md)                              | `clientProvider.ecs`                                                                                                                                              |
| `eks`                    | [`M3LEKSOperations`](./eks.md)                              | `clientProvider.eks`                                                                                                                                              |
| `lambda`                 | [`M3LLambdaOperations`](./lambda.md)                        | `clientProvider.lambda`                                                                                                                                           |
| `secretsManager`         | [`M3LSecretsManagerOperations`](./secrets-manager.md)       | `clientProvider.secretsManager`                                                                                                                                   |
| `s3Operations`           | [`M3LS3Operations`](./s3.md)                                | `clientProvider.s3`                                                                                                                                               |
| `dynamoDBOperations`     | [`M3LDynamoDBOperations`](./dynamodb.md)                    | `clientProvider.dynamoDBDocument` + `clientProvider.dynamoDB` (two clients — see below)                                                                           |
| `credentials`            | [`M3LAWSCredentialsManager`](./credentials.md)              | `clientProvider.profile`/`clientProvider.region` (not a raw client)                                                                                               |

`cloudWatchAlarms` and `cloudWatchMetrics` both wrap the same underlying
`cloudWatch` raw client (two independent M3L wrapper classes over one SDK
client — the raw client is still constructed and connected exactly once,
since `clientProvider.cloudWatch` is itself memoized on `clientProvider`).

**`aws/s3` and `aws/dynamodb` remain primarily function-based**
([`aws/s3`](./s3.md): ADR-0033; [`aws/dynamodb`](./dynamodb.md): the same
shape for DynamoDB item operations) — every free function still takes an
already-provisioned client as its first parameter, unchanged. `s3Operations`/
`dynamoDBOperations` above are thin `M3LS3Operations`/`M3LDynamoDBOperations`
wrapper classes added over those same functions purely for `.services`
access-path consistency with every other wrapped service; they add no new
behavior. `dynamoDBOperations` is built from **two** clients —
`clientProvider.dynamoDBDocument` for every method except `describeTable`,
and `clientProvider.dynamoDB` for `describeTable` alone — mirroring the split
`aws/dynamodb/operations.ts` itself already has. Calling the free functions
directly with `.clients.s3` / `.clients.dynamoDBDocument` / `.clients.dynamoDB`
remains equally valid; neither access path is deprecated. The `s3://` URI
parser (`aws/s3`'s `parseS3Uri`/`formatS3Uri`) is pure string logic with no
client dependency at all, so it has no `.services` entry.

Other members:

- Credential resolution for `requestSigner`/`credentials` — same
  `fromIni({ profile })` vs. SDK-default-chain rule as `AWSClientProvider`
  (see above); every other getter delegates credential resolution entirely
  to `clientProvider`.
- `close()` — clears this provider's own cache so a later getter access
  constructs fresh wrapper instances. Unlike `AWSClientProvider.close()`,
  this **never calls `.destroy()`** on anything: none of the seventeen getters
  above holds a destroyable resource of its own — each either wraps a client
  `clientProvider` owns (and destroys), or (for `requestSigner`/
  `credentials`) holds no destroyable resource at all. Calling
  `clientProvider.close()` does **not** cascade into this provider's cache —
  a caller that closes the underlying client provider and wants fresh
  `.services` wrappers afterward must also call `services.close()`
  explicitly (mirrors the pre-existing risk of holding a stale `.clients.*`
  wrapper reference across a `close()`).

When constructing a wrapper fails for a reason unrelated to raw-client
construction (there is none currently — every wrapper's constructor is a
synchronous, non-throwing field assignment), the underlying
`clientProvider` getter's own `M3LAWSClientError` propagates unchanged;
`AWSServiceProvider` adds no error handling of its own.

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

### Use a library-owned wrapper via `.services`

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});

// Each wrapper is constructed lazily on first access and cached thereafter,
// built from the same underlying AWSClientProvider `provider.clients` uses.
const athena = provider.services.athena;
const sqsOperations = provider.services.sqsOperations;

// aws/s3 and aws/dynamodb are function-based (ADR-0033) — call the exported
// functions directly with the raw/document client instead.
import { getItem } from "@m3l-automation/m3l-common/aws";
const item = await getItem(provider.services.dynamoDBDocument, "orders", {
  id: "42",
});
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
- **`.services` shares `.clients`' connections:** `AWSProvider.services` (an `AWSServiceProvider`) is always built from the same `AWSClientProvider` instance `AWSProvider.clients` already lazily constructed — using both facades for the same service never resolves credentials twice or opens two connections.
- **`.services.close()` does not cascade from `.clients.close()`:** the two caches are cleared independently; call both if you want a full reset.

## See also

- [AWS credentials](./credentials.md) — validating and refreshing the credentials these clients use.
- [AWS models](./models.md) — shared AWS model types.
- [Lambda handlers](../../guides/lambda-handlers.md) — connection reuse across invocations.
- [Script](../core/script.md) — the `script.aws` facade.
- [ADR-0038](../../adr/0038-sqs-dlq-redrive-and-aws-services-tier.md) — why `AWSServiceProvider`/`.services` exists and why the four `.clients` convenience getters are deprecated in place rather than removed.
