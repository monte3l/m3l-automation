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

- `M3LAWSRegion` / `M3LAWSProfile` — branded AWS identity strings (mutually non-assignable).
- `parseAWSRegion` / `parseAWSProfile` — validating constructors that brand a `string`.
- `isAWSRegion` / `isAWSProfile` — non-throwing type guards for the brands.
- `M3LAWSIdentityError` / `M3LAWSIdentityErrorCode` — error (and its code union) thrown by the `parse*` constructors on invalid input.
- `M3LAWSCredentialsErrorType` — classified credential error categories.
- `M3LAWSCredentialsErrorAnalysis` — the result of analyzing a credential error.
- `M3LAWSRetryContext` — context describing a retry attempt.
- `M3LAWSLoginResult` — the result of an SSO login attempt.
- `M3LAWSCredentialsManagerOptions` — construction options for the credentials manager.

The credential/retry/login/options symbols are pure compile-time shapes; the
identity brands add small, side-effect-free runtime constructors
(`parseAWSRegion`/`parseAWSProfile`, plus the `is*` guards) and one error class.
`models` stays free of any `@aws-sdk` runtime dependency either way. The only
cross-module reference is a **type-only** import of [`M3LPrompt`](../core/prompt.md)
(from `core/prompt`) used to type the optional `prompt` field — compile-time
only, so `models` still tree-shakes cleanly and pulls in no extra runtime code.

### AWS identity types (`M3LAWSRegion`, `M3LAWSProfile`)

`region` and `profile` are both AWS identity strings, but they are **not
interchangeable** — passing a profile name where a region is expected (or vice
versa) is a bug the compiler should catch. Each is modelled as a
**branded string** — `string & { readonly __brand: unique symbol }`, with
`M3LAWSRegion` and `M3LAWSProfile` each declaring their **own** `unique symbol`
— so the two brands are mutually non-assignable and neither is assignable from a
plain `string` without going through its validating constructor or guard.

| Symbol                                                | Kind             | Description                                                                                                                     |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `M3LAWSRegion`                                        | branded `string` | A validated AWS region (e.g. `eu-south-1`).                                                                                     |
| `M3LAWSProfile`                                       | branded `string` | A validated AWS profile name.                                                                                                   |
| `parseAWSRegion(value: string): M3LAWSRegion`         | constructor      | Validates `value` as an AWS region and returns it branded; throws `M3LAWSIdentityError` (`ERR_AWS_INVALID_REGION`) otherwise.   |
| `parseAWSProfile(value: string): M3LAWSProfile`       | constructor      | Validates `value` as a profile name and returns it branded; throws `M3LAWSIdentityError` (`ERR_AWS_INVALID_PROFILE`) otherwise. |
| `isAWSRegion(value: string): value is M3LAWSRegion`   | guard            | Non-throwing boundary check; narrows `value` to `M3LAWSRegion` when it is a valid region.                                       |
| `isAWSProfile(value: string): value is M3LAWSProfile` | guard            | Non-throwing boundary check; narrows `value` to `M3LAWSProfile` when it is a valid profile name.                                |
| `M3LAWSIdentityError`                                 | error            | `M3LError` subclass thrown by the `parse*` constructors on invalid input; its `code` is a `M3LAWSIdentityErrorCode`.            |
| `M3LAWSIdentityErrorCode`                             | union            | `"ERR_AWS_INVALID_REGION" \| "ERR_AWS_INVALID_PROFILE"`.                                                                        |

**Validation.**

- A **region** must match the AWS region shape `<area>-<direction(s)>-<number>` —
  two lowercase letters, one or more hyphenated lowercase words, then a hyphen
  and digits (e.g. `eu-south-1`, `us-east-1`, `us-gov-east-1`). The check is a
  single bounded pattern with no nested quantifiers (ReDoS-safe).
- A **profile** must be non-empty and free of surrounding whitespace and control
  characters. Profile names are user-defined, so validation is deliberately
  lenient — its purpose is to reject an empty/garbage value and to brand the
  string, not to enforce an AWS-side naming policy.

Both `parse*` constructors validate **caller-supplied** input at the public
boundary and throw `M3LAWSIdentityError` on violation (never silently coerce),
per the library's fail-loud-on-caller-error rule; the guard/constructor pair is
consistent — `isAWSRegion(v)` is `true` exactly when `parseAWSRegion(v)`
succeeds (same for profile). The `is*` guards are the non-throwing equivalent
for callers that prefer a boolean check. `M3LAWSIdentityError` carries **no**
`cause` — an invalid string has no underlying failure to chain — so callers
narrow on its `code` (`M3LAWSIdentityErrorCode`) rather than inspecting `cause`.
`AWS_REGION` (see [AWS clients](./clients.md)) is a pre-validated `M3LAWSRegion`.

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
      readonly profile: M3LAWSProfile;
      readonly durationMs: number;
    }
  | {
      readonly outcome: "failed";
      readonly exitCode: number | null;
      readonly profile: M3LAWSProfile;
      readonly durationMs: number;
    }
  | {
      readonly outcome: "timedOut";
      readonly exitCode: null;
      readonly profile: M3LAWSProfile;
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
| `profile`    | `M3LAWSProfile`                       | The profile the SSO login targeted.                                                                                  |
| `durationMs` | `number`                              | The wall-clock duration of the login attempt.                                                                        |
| `exitCode`   | `0` \| `number \| null` (per arm)     | `0` on success; `null` for our timeout kill; `number \| null` for a failure (non-zero exit or external-signal kill). |

### `M3LAWSCredentialsManagerOptions`

Construction options for `M3LAWSCredentialsManager` (see [AWS credentials](./credentials.md)).

| Field            | Type                       | Description                                                                        |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `profile`        | `M3LAWSProfile` (optional) | The default profile to validate and, if needed, re-authenticate.                   |
| `region`         | `M3LAWSRegion` (optional)  | AWS region for the STS validation client; defaults to the SDK's resolution.        |
| `loginTimeoutMs` | `number` (optional)        | SSO login timeout in milliseconds; defaults to `120000` (120 s).                   |
| `maxRetries`     | `number` (optional)        | Max relogin retry attempts for a recoverable failure; defaults to `1`.             |
| `interactive`    | `boolean` (optional)       | Whether to prompt the user before re-running SSO login.                            |
| `prompt`         | `M3LPrompt` (optional)     | Prompt used to confirm re-login in interactive mode; a default is used if omitted. |

## Notes and behavior

- These types form the shared vocabulary used by the credentials manager and the
  client providers; they are not a standalone runtime feature.
- The runtime-valued symbols are `M3LAWSCredentialsErrorType` (the frozen `const`
  object), the `parseAWSRegion`/`parseAWSProfile` constructors, the
  `isAWSRegion`/`isAWSProfile` guards, and `M3LAWSIdentityError`; the credential
  analysis, retry-context, login-result, and manager-options symbols are
  compile-time-only shapes.
- The `prompt` option is typed as [`M3LPrompt`](../core/prompt.md) via a
  type-only import; `models` carries no runtime dependency on `core/prompt`.
- Field shapes may be extended (with matching updates here) as the credentials
  manager and client providers are implemented.

## See also

- [AWS credentials](./credentials.md) — the manager that produces and consumes these types.
- [AWS clients](./clients.md) — SDK client providers.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
