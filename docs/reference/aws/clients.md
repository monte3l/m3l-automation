# AWS Clients

`AWSClientProvider` and `AWSMultiClientProvider` create and lazily cache raw AWS SDK v3 clients, resolving credentials per profile: they expose the underlying SDK clients directly.

## Overview

The client layer hands callers ready-to-use AWS SDK v3 clients with credentials already wired up:

- `AWSClientProvider` manages SDK clients for a **single** profile, caching each client lazily on first access.
- `AWSMultiClientProvider` manages a map of `AWSClientProvider` instances keyed by profile name, with helpers to run an operation across all profiles.
- `AWSProvider` is the facade exposed on `M3LScript` instances as `script.aws`.

Credential resolution is profile-aware: when a profile name is supplied it uses `fromIni()` (SSO-aware) from `@aws-sdk/credential-provider-ini`; otherwise it falls back to the AWS SDK default credential chain.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `AWSClientProvider` — single-profile, lazily-cached SDK client provider.
- `AWSMultiClientProvider` — multi-profile provider with parallel-map helpers.
- `AWSProvider` — facade exposed via `script.aws`.
- `AWS_REGION` — default region constant; defaults to `'eu-south-1'` (Milan) when unspecified.

### `AWSClientProvider`

For a single profile, `AWSClientProvider` creates and lazily caches AWS SDK v3 clients, each constructed on first access. Other members:

- Credential resolution — uses `fromIni()` for a named profile, otherwise the SDK default credential chain.
- `close()` — destroys all cached clients.

### `AWSMultiClientProvider`

Manages a map of `AWSClientProvider` instances keyed by profile name. Profile names are deduplicated on construction.

- `mapParallel<T>(fn)` — runs an operation across all profiles in parallel, rejecting if any operation throws.
- `mapParallelSettled<T>(fn)` — runs across all profiles and collects per-profile results and errors without throwing.

### `AWSProvider`

The facade exposed by `M3LScript` via `script.aws`. It lazily instantiates its sub-providers from a shared configuration and exposes them through getters.

## Usage

### Get a client for a single profile

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({ profile: "my-profile" });

// Each client is created lazily on first access and cached thereafter.
const s3 = provider.s3;
const dynamo = provider.dynamoDB;

// Release all cached clients when done.
provider.close();
```

### Run an operation across multiple profiles

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const multi = new AWS.AWSMultiClientProvider({
  profiles: ["profile-a", "profile-b"],
});

// Parallel across profiles; rejects if any throws.
await multi.mapParallel((p) => p.s3 /* ...use the client... */);

// Parallel across profiles; never throws — collects results and errors.
const settled = await multi.mapParallelSettled((p) => p.s3 /* ... */);
```

### From within a script

```typescript
// Inside an M3LScript main function, the facade is available as script.aws.
const s3 = script.aws.clients; /* ...single-profile clients via the facade... */
```

## Notes and behavior

- **Lazy caching:** each SDK client is created on first access and reused on subsequent access within the same `AWSClientProvider`.
- **Region:** clients default to `AWS_REGION` (`'eu-south-1'`, Milan) when a region is not otherwise specified.
- **Credential resolution:** `fromIni()` is used for a named profile (SSO-aware); without a profile, the SDK default credential chain is used.
- **Lifecycle in Lambda:** the SDK client cache is intentionally persisted across Lambda invocations to reuse connections. Per-invocation state reset does not tear down the client providers.
- **`close()`** destroys all cached clients on an `AWSClientProvider`.
- **Deduplication:** `AWSMultiClientProvider` deduplicates profile names on construction.

## See also

- [AWS credentials](./credentials.md) — validating and refreshing the credentials these clients use.
- [AWS models](./models.md) — shared AWS model types.
- [Lambda handlers](../../guides/lambda-handlers.md) — connection reuse across invocations.
- [Script](../core/script.md) — the `script.aws` facade.
