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

All five are pure domain types with no `@aws-sdk` runtime dependency;
`models` stays free of the AWS SDK. The only cross-module reference is a
**type-only** import of [`M3LPrompt`](../core/prompt.md) (from `core/prompt`) used
to type the optional `prompt` field — compile-time only, so `models` still
tree-shakes cleanly and pulls in no extra runtime code.

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
failure is recoverable by re-authenticating. A **discriminated union** on
`recoverable` so the flag can never disagree with `type` — the recoverable arm
carries only the recoverable categories, the unrecoverable arm only the rest:

```ts
type M3LAWSCredentialsErrorAnalysis =
  | {
      readonly recoverable: true;
      readonly type:
        | "SSO_SESSION_EXPIRED"
        | "SSO_SESSION_INVALID"
        | "CREDENTIALS_PROVIDER_FAILED";
      readonly cause?: unknown;
    }
  | {
      readonly recoverable: false;
      readonly type: "PROFILE_NOT_FOUND" | "UNKNOWN";
      readonly cause?: unknown;
    };
```

Narrowing on `recoverable` narrows `type` and vice versa; the impossible pairing
(e.g. `{ type: "PROFILE_NOT_FOUND", recoverable: true }`) does not type-check.

| Field         | Type                                        | Description                                           |
| ------------- | ------------------------------------------- | ----------------------------------------------------- |
| `recoverable` | `boolean` (the discriminant)                | Whether re-running SSO login can recover the failure. |
| `type`        | `M3LAWSCredentialsErrorType` (arm-narrowed) | The classified error category.                        |
| `cause`       | `unknown` (optional)                        | The underlying error that was analyzed.               |

### `M3LAWSRetryContext`

Describes the current attempt when the credentials manager retries an operation
after re-authentication.

| Field         | Type                             | Description                                  |
| ------------- | -------------------------------- | -------------------------------------------- |
| `attempt`     | `number`                         | The 1-based index of the current attempt.    |
| `maxAttempts` | `number`                         | The total number of attempts permitted.      |
| `analysis`    | `M3LAWSCredentialsErrorAnalysis` | The error analysis that triggered the retry. |

### `M3LAWSLoginResult`

The outcome of a single SSO login attempt, modelled as a **discriminated union**
on an `outcome` tag so contradictory states (a "successful" login that also
timed out, a "failed" login with exit code `0`) are unrepresentable. Every arm
carries `profile` and `durationMs`; the arms differ on `outcome` and `exitCode`:

```ts
type M3LAWSLoginResult =
  | {
      readonly outcome: "success";
      readonly exitCode: 0;
      readonly profile: string;
      readonly durationMs: number;
    }
  | {
      readonly outcome: "failed";
      readonly exitCode: number | null;
      readonly profile: string;
      readonly durationMs: number;
    }
  | {
      readonly outcome: "timedOut";
      readonly exitCode: null;
      readonly profile: string;
      readonly durationMs: number;
    };
```

`switch (result.outcome)` is exhaustive. `"success"` is the only arm with
`exitCode: 0`. `"timedOut"` means **we** killed the process for exceeding
`loginTimeoutMs` (`exitCode: null`). `"failed"` covers every other unsuccessful
outcome — a non-zero exit code, or a process killed by an **external** signal
(e.g. `SIGINT`) that was _not_ our timeout, whose `exitCode` is `null`; hence
`"failed"` carries `number | null`. The contradiction this union removes is a
`success`/`timedOut` pair that disagrees — not the `null` exit code itself,
which two distinct kill paths legitimately share.

| Field        | Type                                  | Description                                                                                                          |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `outcome`    | `"success" \| "failed" \| "timedOut"` | The discriminant tag for the login outcome.                                                                          |
| `profile`    | `string`                              | The profile the SSO login targeted.                                                                                  |
| `durationMs` | `number`                              | The wall-clock duration of the login attempt.                                                                        |
| `exitCode`   | `0` \| `number \| null` (per arm)     | `0` on success; `null` for our timeout kill; `number \| null` for a failure (non-zero exit or external-signal kill). |

### `M3LAWSCredentialsManagerOptions`

Construction options for `M3LAWSCredentialsManager` (see [AWS credentials](./credentials.md)).

| Field            | Type                   | Description                                                                        |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `profile`        | `string` (optional)    | The default profile to validate and, if needed, re-authenticate.                   |
| `region`         | `string` (optional)    | AWS region for the STS validation client; defaults to the SDK's resolution.        |
| `loginTimeoutMs` | `number` (optional)    | SSO login timeout in milliseconds; defaults to `120000` (120 s).                   |
| `maxRetries`     | `number` (optional)    | Max relogin retry attempts for a recoverable failure; defaults to `1`.             |
| `interactive`    | `boolean` (optional)   | Whether to prompt the user before re-running SSO login.                            |
| `prompt`         | `M3LPrompt` (optional) | Prompt used to confirm re-login in interactive mode; a default is used if omitted. |

## Notes and behavior

- These types form the shared vocabulary used by the credentials manager and the
  client providers; they are not a standalone runtime feature.
- `M3LAWSCredentialsErrorType` is the only symbol with a runtime value (the
  frozen `const` object); the remaining four are compile-time-only shapes.
- The `prompt` option is typed as [`M3LPrompt`](../core/prompt.md) via a
  type-only import; `models` carries no runtime dependency on `core/prompt`.
- Field shapes may be extended (with matching updates here) as the credentials
  manager and client providers are implemented.

## See also

- [AWS credentials](./credentials.md) — the manager that produces and consumes these types.
- [AWS clients](./clients.md) — SDK client providers.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
