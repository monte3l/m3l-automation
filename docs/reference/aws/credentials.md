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
plus the branded identity types `M3LAWSRegion` / `M3LAWSProfile` and their
`parseAWSRegion`/`parseAWSProfile` constructors and `isAWSRegion`/`isAWSProfile`
guards — are the shared AWS vocabulary; their exact names and fields are defined
in [AWS models](./models.md).

### `M3LAWSCredentialsManager` methods

- `ensureValidCredentials(profile?: M3LAWSProfile)` — validate one profile via STS
  `GetCallerIdentityCommand`; on a recoverable failure, re-run SSO login (after
  an interactive confirm when enabled) and retry.
- `ensureValidCredentialsMultiple(profiles: readonly M3LAWSProfile[])` — validate
  many profiles in three phases (parallel validate → partition valid/invalid →
  **sequential** SSO login for the invalid ones).
- `retryWithRelogin<T>(operation, profile?: M3LAWSProfile)` — wrap an arbitrary AWS operation;
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
categories (defined in [AWS models](./models.md)) in two stages:

1. **Identity fast path** — when the failure is an `Error` whose `.name` is a
   recognized AWS SDK exception name, classification short-circuits on that
   name alone, skipping the message-regex chain entirely: `"ExpiredTokenException"`
   classifies as `SSO_SESSION_EXPIRED`, `"SSOTokenProviderFailure"` classifies
   as `SSO_SESSION_INVALID`. This is more robust than message text to SDK
   wording/localization changes across versions.
2. **Message-regex fallback** — when `.name` doesn't match either recognized
   literal (or the failure isn't an `Error` instance), classification falls
   back to matching `error.message` against a regex pattern set per category
   — invalid-session and profile-not-found each carry multiple phrasings;
   expired-session matches a single literal (`expired`), sufficient on its
   own since every other phrasing considered already contains that word.

## Usage

### Validate (and refresh) credentials for a single profile

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const manager = new AWS.M3LAWSCredentialsManager({
  profile: AWS.parseAWSProfile("my-profile"),
});

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
await manager.ensureValidCredentialsMultiple([
  AWS.parseAWSProfile("profile-a"),
  AWS.parseAWSProfile("profile-b"),
]);
```

SSO login is run sequentially for invalid profiles because parallel browser windows would be unusable.

## Notes and behavior

- **SSO login** spawns `aws sso login --profile=<name>` with `stdio: 'inherit'`. The login timeout is configurable and defaults to **120 seconds**.
- **Concurrent SSO logins for the same profile are coalesced.** Two callers
  that independently hit a recoverable credential error for the same
  resolved profile at the same time (e.g. concurrent `ensureValidCredentials()`
  calls, or `ensureValidCredentials()` racing `retryWithRelogin()`) share a
  single in-flight `aws sso login` spawn and its result, instead of each
  spawning its own duplicate browser-based flow. A few nuances:
  - **Scope is per-manager-instance, not process-wide** — two separate
    `M3LAWSCredentialsManager` instances for the same profile still spawn two
    independent logins.
  - **The coalescing key is the resolved profile** (an explicit profile, or
    `"default"` when none is supplied), so a caller passing no profile and one
    passing an explicit `"default"` coalesce onto the same in-flight login.
  - **All coalesced callers share one settlement**: a failed or timed-out
    login rejects/resolves every coalesced caller with the identical result.
  - **The interactive re-login confirmation is not coalesced** — each caller
    is still prompted independently before reaching the coalesced spawn, so
    with `interactive: true` two concurrent callers can each see a prompt
    while only one `aws sso login` process actually runs.
- **An injected `logger` (`M3LLoggerHandler`, optional) observes the SSO login
  lifecycle.** When supplied, `handle()` is called with a structured
  `M3LLogEvent` at four points: a `STEP` event before `aws sso login` spawns,
  and a terminal event once the child process settles — `SUCCESS` on a
  zero exit, `WARNING` on a timeout kill, `ERROR` on a non-zero exit or on a
  spawn failure (e.g. the `aws` executable not found on `PATH`). Each event's
  `data` carries only the resolved profile name (plus `durationMs`/`exitCode`
  on the terminal event) — never the raw SDK/CLI error text. **A throwing
  handler is isolated**: `logger.handle()` is called inside a try/catch at
  every dispatch point, so a bug in a caller-supplied handler cannot crash the
  SSO login flow or leave `ensureValidCredentials()`/`retryWithRelogin()`
  unsettled — the failure is diagnosed to `stderr` and the login proceeds
  unaffected, the same isolation `M3LLogger` gives its own handlers. Omitting
  `logger` emits no events; this is purely additive observability, never a
  required dependency.
- **Validation** is performed with the STS `GetCallerIdentityCommand`, which exercises the real credential resolution path rather than checking only for local file presence.
- **Retry-with-relogin**: when an AWS operation fails with a credential error, the manager checks whether the error is recoverable and whether retries remain. If so, it optionally prompts the user (in interactive mode), re-runs SSO login, and then retries the operation. The `M3LAWSRetryContext` describes the current attempt.
- **`ensureValidCredentialsMultiple()`** runs in three phases: parallel validation, separation of valid/invalid profiles, and sequential SSO login for the invalid ones.
- **Error classification** is exposed through `M3LAWSCredentialsErrorAnalysis` (using `M3LAWSCredentialsErrorType`), letting callers reason about whether a failure can be recovered by re-authenticating.
- **AWS SDK packages are required, hard dependencies (loaded lazily).** The manager loads `@aws-sdk/client-sts` and `@aws-sdk/credential-providers` via `await import(...)` only when a method needs them — a cold-start optimization (per [ADR-0017](../../adr/0017-dependency-loading-standard.md)), not an opt-in: both are hard `dependencies` and are always installed. If a package fails to load (e.g. a corrupt install), the manager throws `M3LAWSCredentialsError` with an actionable message naming the package and the import failure chained via `cause`.
- **Interactive confirmation** uses [`M3LPrompt`](../core/prompt.md) (from `core/prompt`), loaded lazily. Pass a `prompt` in the options to inject your own; otherwise a default `M3LPrompt` is constructed on demand.

## See also

- [AWS clients](./clients.md) — raw SDK client providers that consume resolved credentials; `M3LAWSCredentialsManager` is also reachable as `AWSServiceProvider.credentials` (`script.aws.services.credentials`).
- [AWS models](./models.md) — shared AWS model types used by the credentials manager.
- [Configuration](../../guides/configuration.md) — how the `aws.profile` parameter is resolved.
- [Errors](../core/errors.md) — the library's typed error hierarchy.
