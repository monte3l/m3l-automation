# AWS Credentials

`M3LAWSCredentialsManager` manages AWS SSO credentials for one or more profiles: it validates credentials, drives the browser-based SSO login flow, and wraps AWS operations with retry-on-relogin behavior.

## Overview

`M3LAWSCredentialsManager` is the credential layer of the `AWS` namespace. It does not store secrets itself; instead it tests the _actual_ credential resolution path for a profile and, when credentials are missing or expired, re-runs the AWS SSO login flow.

- **Validation** uses the AWS STS `GetCallerIdentityCommand`, so it verifies that credentials actually resolve and authenticate — not merely that a profile file exists.
- **SSO login** spawns the `aws` CLI (`aws sso login --profile=<name>`) as a child process with `stdio: 'inherit'`, so the browser-based flow appears directly in the user's terminal.
- **Error analysis** classifies failures (expired session, invalid session, profile-not-found, etc.) so callers can decide whether a failure is recoverable by re-logging in.
- **Retry** wraps an AWS operation and, on a recoverable credential error, re-runs SSO login before retrying.

This manager is invoked automatically by `M3LScript.run()` (only when an `aws.profile` parameter is defined). You can also use it directly.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `M3LAWSCredentialsManager` — the manager class.
- `M3LAWSCredentialsError` — the typed error the manager throws for an
  unrecoverable credential failure (or when a required AWS SDK package cannot be
  loaded).

The manager's construction options and the credential model types it produces
and consumes — `M3LAWSCredentialsManagerOptions`, `M3LAWSCredentialsErrorType`,
`M3LAWSCredentialsErrorAnalysis`, `M3LAWSRetryContext`, and `M3LAWSLoginResult` —
are the shared AWS vocabulary; their exact names and fields are defined in
[AWS models](./models.md).

### `M3LAWSCredentialsManager` methods

- `ensureValidCredentials(profile?)` — validate one profile via STS
  `GetCallerIdentityCommand`; on a recoverable failure, re-run SSO login (after
  an interactive confirm when enabled) and retry.
- `ensureValidCredentialsMultiple(profiles)` — validate many profiles in three
  phases (parallel validate → partition valid/invalid → **sequential** SSO login
  for the invalid ones).
- `retryWithRelogin<T>(operation, profile?)` — wrap an arbitrary AWS operation;
  on a recoverable credential error, re-run SSO login and retry while attempts
  remain (`M3LAWSRetryContext`).
- `analyzeError(error)` — classify an arbitrary failure into a
  `M3LAWSCredentialsErrorAnalysis` without acting on it.

### `M3LAWSCredentialsError`

Thrown when a credential failure cannot be recovered by re-authenticating, or
when a required AWS SDK package cannot be loaded. It is a subclass
of [`M3LError`](../core/errors.md) with the `code` `"ERR_AWS_CREDENTIALS"`,
carries the classified `M3LAWSCredentialsErrorType` and the affected `profile` in
its `context`, and chains the underlying SDK or spawn failure via `cause`.

Error analysis classifies failures into the `M3LAWSCredentialsErrorType`
categories (defined in [AWS models](./models.md)) by matching error messages
against regex sets — multiple patterns for an expired session, plus additional
patterns for invalid sessions and profile-not-found.

## Usage

### Validate (and refresh) credentials for a single profile

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const manager = new AWS.M3LAWSCredentialsManager({ profile: "my-profile" });

// Validates via STS GetCallerIdentity; if the SSO session is expired and
// recoverable, re-runs `aws sso login --profile=my-profile` before retrying.
await manager.ensureValidCredentials();
```

### Validate multiple profiles

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const manager = new AWS.M3LAWSCredentialsManager();

// Phase 1: validate all profiles in parallel.
// Phase 2: separate valid from invalid profiles.
// Phase 3: run SSO login *sequentially* for the invalid ones.
await manager.ensureValidCredentialsMultiple(["profile-a", "profile-b"]);
```

SSO login is run sequentially for invalid profiles because parallel browser windows would be unusable.

## Notes and behavior

- **SSO login** spawns `aws sso login --profile=<name>` with `stdio: 'inherit'`. The login timeout is configurable and defaults to **120 seconds**.
- **Validation** is performed with the STS `GetCallerIdentityCommand`, which exercises the real credential resolution path rather than checking only for local file presence.
- **Retry-with-relogin**: when an AWS operation fails with a credential error, the manager checks whether the error is recoverable and whether retries remain. If so, it optionally prompts the user (in interactive mode), re-runs SSO login, and then retries the operation. The `M3LAWSRetryContext` describes the current attempt.
- **`ensureValidCredentialsMultiple()`** runs in three phases: parallel validation, separation of valid/invalid profiles, and sequential SSO login for the invalid ones.
- **Error classification** is exposed through `M3LAWSCredentialsErrorAnalysis` (using `M3LAWSCredentialsErrorType`), letting callers reason about whether a failure can be recovered by re-authenticating.
- **AWS SDK packages are required, hard dependencies (loaded lazily).** The manager loads `@aws-sdk/client-sts` and `@aws-sdk/credential-providers` via `await import(...)` only when a method needs them — a cold-start optimization (per [ADR-0017](../../adr/0017-dependency-loading-standard.md)), not an opt-in: both are hard `dependencies` and are always installed. If a package fails to load (e.g. a corrupt install), the manager throws `M3LAWSCredentialsError` with an actionable message naming the package and the import failure chained via `cause`.
- **Interactive confirmation** uses [`M3LPrompt`](../core/prompt.md) (from `core/prompt`), loaded lazily. Pass a `prompt` in the options to inject your own; otherwise a default `M3LPrompt` is constructed on demand.

## See also

- [AWS clients](./clients.md) — raw SDK client providers that consume resolved credentials.
- [AWS models](./models.md) — shared AWS model types used by the credentials manager.
- [Configuration](../../guides/configuration.md) — how the `aws.profile` parameter is resolved.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
