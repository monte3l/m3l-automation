# AWS Models

Shared AWS model types used across the `AWS` namespace — the vocabulary the
credentials manager and the client providers exchange.

## Overview

`aws/models/` holds the shared AWS model types that the rest of the `AWS`
namespace builds on. These are cross-cutting type definitions — credential
error-analysis, retry context, login results, and manager options — rather than
a standalone runtime feature. `models` is implemented first so the credentials
manager and client providers can import a single, authoritative set of types
instead of redeclaring them.

This page is the authoritative home for these symbols: their exact names and
fields are defined here, and the component pages ([AWS credentials](./credentials.md),
[AWS clients](./clients.md)) reference them.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS`
namespace):

- `M3LAWSCredentialsErrorType` — classified credential error categories.
- `M3LAWSCredentialsErrorAnalysis` — the result of analyzing a credential error.
- `M3LAWSRetryContext` — context describing a retry attempt.
- `M3LAWSLoginResult` — the result of an SSO login attempt.
- `M3LAWSCredentialsManagerOptions` — construction options for the credentials manager.

All five are pure domain types with no `@aws-sdk` dependency;
`models` stays dependency-free.

### `M3LAWSCredentialsErrorType`

The error categories produced by credential error analysis. Implemented as a
frozen `const` object with a derived union type of the same name (the project's
convention in place of a TypeScript `enum`).

| Value                         | Meaning                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `SSO_SESSION_EXPIRED`         | The SSO session has expired; recoverable by re-running SSO login. |
| `SSO_SESSION_INVALID`         | The SSO session is present but invalid.                           |
| `CREDENTIALS_PROVIDER_FAILED` | The credential provider chain failed to resolve credentials.      |
| `PROFILE_NOT_FOUND`           | The named profile does not exist.                                 |
| `UNKNOWN`                     | The error could not be classified.                                |

### `M3LAWSCredentialsErrorAnalysis`

The result of classifying a credential failure, letting callers decide whether a
failure is recoverable by re-authenticating.

| Field         | Type                         | Description                                           |
| ------------- | ---------------------------- | ----------------------------------------------------- |
| `type`        | `M3LAWSCredentialsErrorType` | The classified error category.                        |
| `recoverable` | `boolean`                    | Whether re-running SSO login can recover the failure. |
| `cause`       | `unknown` (optional)         | The underlying error that was analyzed.               |

### `M3LAWSRetryContext`

Describes the current attempt when the credentials manager retries an operation
after re-authentication.

| Field         | Type                             | Description                                  |
| ------------- | -------------------------------- | -------------------------------------------- |
| `attempt`     | `number`                         | The 1-based index of the current attempt.    |
| `maxAttempts` | `number`                         | The total number of attempts permitted.      |
| `analysis`    | `M3LAWSCredentialsErrorAnalysis` | The error analysis that triggered the retry. |

### `M3LAWSLoginResult`

The outcome of a single SSO login attempt.

| Field        | Type      | Description                                   |
| ------------ | --------- | --------------------------------------------- |
| `profile`    | `string`  | The profile the SSO login targeted.           |
| `success`    | `boolean` | Whether the login completed successfully.     |
| `durationMs` | `number`  | The wall-clock duration of the login attempt. |

### `M3LAWSCredentialsManagerOptions`

Construction options for `M3LAWSCredentialsManager` (see [AWS credentials](./credentials.md)).

| Field            | Type                 | Description                                                      |
| ---------------- | -------------------- | ---------------------------------------------------------------- |
| `profile`        | `string` (optional)  | The default profile to validate and, if needed, re-authenticate. |
| `loginTimeoutMs` | `number` (optional)  | SSO login timeout in milliseconds; defaults to `120000` (120 s). |
| `interactive`    | `boolean` (optional) | Whether to prompt the user before re-running SSO login.          |

## Notes and behavior

- These types form the shared vocabulary used by the credentials manager and the
  client providers; they are not a standalone runtime feature.
- `M3LAWSCredentialsErrorType` is the only symbol with a runtime value (the
  frozen `const` object); the remaining four are compile-time-only shapes.
- Field shapes are intentionally minimal; they may be extended (with matching
  updates here) as the credentials manager and client providers are implemented.

## See also

- [AWS credentials](./credentials.md) — the manager that produces and consumes these types.
- [AWS clients](./clients.md) — SDK client providers.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
