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
- `M3LAWSCredentialsManagerOptions` — construction options.
- `M3LAWSCredentialsErrorType` — enum of classified credential error categories.
- `M3LAWSCredentialsErrorAnalysis` — result of analyzing a credential error.
- `M3LAWSRetryContext` — context describing a retry attempt.
- `M3LAWSLoginResult` — result of an SSO login attempt.

### `M3LAWSCredentialsErrorType`

The error categories produced by error analysis:

| Value                         | Meaning                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `SSO_SESSION_EXPIRED`         | The SSO session has expired; recoverable by re-running SSO login. |
| `SSO_SESSION_INVALID`         | The SSO session is present but invalid.                           |
| `CREDENTIALS_PROVIDER_FAILED` | The credential provider chain failed to resolve credentials.      |
| `PROFILE_NOT_FOUND`           | The named profile does not exist.                                 |
| `UNKNOWN`                     | The error could not be classified.                                |

Error analysis detects these patterns via regex sets (multiple patterns for an expired session, plus additional patterns for invalid sessions and profile-not-found).

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

## See also

- [AWS clients](./clients.md) — raw SDK client providers that consume resolved credentials.
- [AWS models](./models.md) — shared AWS model types used by the credentials manager.
- [Configuration](../../guides/configuration.md) — how the `aws.profile` parameter is resolved.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
