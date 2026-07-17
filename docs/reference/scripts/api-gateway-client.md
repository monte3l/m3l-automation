# api-gateway-client

Invoke HTTP APIs fronted by AWS API Gateway (the `execute-api` invoke plane) —
single request or bounded-concurrency batch, with `none` / `api-key` / `iam`
(SigV4) auth.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/api-gateway-client/README.md`](../../../scripts/api-gateway-client/README.md).

## Purpose and scope

A consumer script that calls an HTTP API published by AWS API Gateway. A
`command` config parameter selects one of two modes: `request` (one HTTP call
per run) and `batch` (a JSONL file of request-parameter records fanned through
a shared request template with bounded concurrency, writing responses and
per-request failures to output files). An `auth` config parameter selects how
each request is authenticated: `none` (no auth headers), `api-key` (an
`x-api-key` header carrying a secret resolved from `.env`), or `iam` (SigV4
request signing via the library's `aws/signing` submodule). Mutating HTTP verbs
(`POST`/`PUT`/`PATCH`/`DELETE`) are confirm-gated before dispatch; `GET`/`HEAD`
are never gated.

It is out of scope for this script to **manage** API Gateway infrastructure
(creating REST/HTTP APIs, stages, authorizers, usage plans, or API keys) — that
is CloudFormation territory. This script only **invokes** an already-deployed
API. The library's `Core.M3LHttpClient` is transport-only (the body is sent
verbatim, with no serialization and no inferred `Content-Type`), so shaping the
request body and headers is the caller's responsibility.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-mode / per-auth requiredness (the "Required for" column) is
**not** expressed by `M3LConfigParameter({ required: true })` — the library has
no cross-parameter/conditional-required seam yet (F1b, deferred). Instead each
parameter besides `command`/`auth`/`baseUrl`/`method` is declared optional, and
the selected step guard-checks presence before any HTTP call (mirroring
`sqs-etl`'s per-command guard). Declaring `aws.profile` (via
`Core.AWS_PROFILE_PARAM_NAME`) is what enables the `script.aws`
dynamic-provisioning seam — it is declared globally optional and guard-required
only for `auth: iam`.

| Parameter     | Type     | Default | Validation                                                     | Required for                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------- | ------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws.profile` | `STRING` | —       | guard-checked (see `resolve-auth-headers`)                     | `auth: iam`                  | AWS SSO/credential profile name; declaring it (via `Core.AWS_PROFILE_PARAM_NAME`) triggers `M3LScript`'s AWS-provisioning stage and populates `script.aws`, so `iam` auth can reach `script.aws.clients.requestSigner`. Unused for `auth: none`/`api-key`                                                                                                                                                                                                                                                                                                                                        |
| `command`     | `STRING` | —       | `required: true`, `oneOf(request, batch)`                      | all                          | Selects single-request vs batch mode; dispatched by `run-api-gateway-client.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth`        | `STRING` | —       | `required: true`, `oneOf(none, api-key, iam)`                  | all                          | Selects the auth mode applied to every request in the run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `baseUrl`     | `STRING` | —       | `required: true`, `nonEmpty`                                   | all                          | API Gateway `execute-api` invoke base URL; each `path` is resolved against it via `new URL(path, baseUrl)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `method`      | `STRING` | —       | `required: true`, `oneOf(GET, POST, PUT, PATCH, DELETE, HEAD)` | all                          | The single-request HTTP verb, and the **uniform** verb for every `batch` record (per-record method override is out of scope — see below). Required with no default so an implicit `GET` can never mask a misconfigured mutating call                                                                                                                                                                                                                                                                                                                                                             |
| `path`        | `STRING` | —       | `nonEmpty` (guard-checked for `request`)                       | `request`                    | Request path or full URL resolved against `baseUrl`; unused in `batch` (each record carries its own `path`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `body`        | `STRING` | —       | —                                                              | `request` (optional)         | Single-request body, sent verbatim (no serialization, no inferred `Content-Type`); omit for `GET`/`HEAD`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `input`       | `STRING` | —       | `nonEmpty` (guard-checked for `batch`)                         | `batch`                      | JSONL of request-parameter records (`{ path, body? }`), resolved via `M3LPaths.resolveInput`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `output`      | `STRING` | —       | `nonEmpty`                                                     | both (optional)              | Response sink (JSONL), resolved via `M3LPaths.resolveOutput`; omitted means responses are not persisted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `maxInFlight` | `INT`    | `4`     | `range(1, 64)`                                                 | `batch` (optional)           | Bounded concurrency for the batch fan-out (`M3LConcurrencyPool`). A **true in-flight ceiling**, deliberately far smaller than `sqs-etl`'s message-budget `batchSize` — it caps concurrent HTTP requests to stay under API Gateway throttling and local socket exhaustion                                                                                                                                                                                                                                                                                                                         |
| `apiKey`      | `STRING` | —       | `nonEmpty`; `.env`-only via alias `api-gateway-api-key`        | `auth: api-key`              | The API Gateway API key. Never a CLI flag or plain-logged value — sourced from `.env` as `API_GATEWAY_API_KEY` (the `api-gateway-api-key` alias derives that SCREAMING_SNAKE_CASE env key via `M3LConfigParameter`'s `aliases` option). `M3LSecretsSpecifier` (`core/config`) is a classification-only utility with no automatic wiring into `M3LScript` or its logger — no config value is redacted for free — so `resolve-auth-headers` and every step must never log this value or the `x-api-key` header it produces, the same discipline applied to the `iam` mode's `authorization` header |
| `yes`         | `BOOL`   | `false` | —                                                              | any mutating verb (optional) | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle. `run-api-gateway-client.ts` dispatches on
the resolved `command`; each mode step composes `resolve-auth-headers` and (for
mutating verbs) `destructive-gate`.

| Step                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-api-gateway-client` | Composition/dispatcher: reads the `oneOf`-validated `command` and **dynamic-imports** the matching step — `single-request.js` (`request`) or `batch-request.js` (`batch`) — forwarding the deps object unchanged; a defensive `default` throws `ERR_API_GATEWAY_CLIENT_CONFIG`. Dynamic import (not a top-level static import) so `steps/*.test.ts` can `vi.mock` each step before dispatch resolves it                                                                                                                                                                                                                                                                                                                                                                                             |
| `resolve-auth-headers`   | Maps `auth` to the per-request auth headers: `none` → `{}`; `api-key` → `{ "x-api-key": <resolved apiKey> }` (throws `ERR_API_GATEWAY_CLIENT_CONFIG` when `apiKey` is unresolved); `iam` → `signer.signedHeaders({ method, url, headers?, body? })`, returning only the SigV4 headers (`authorization` / `x-amz-date` / `x-amz-content-sha256` / `x-amz-security-token`) to merge into the request. Never logs the resolved `apiKey`, the `x-api-key` header, or `authorization` — the library has no automatic secret redaction (`M3LSecretsSpecifier` is classification-only and not wired into `M3LScript`), so this is enforced by discipline in this step, not a library guarantee; throws `ERR_API_GATEWAY_CLIENT_CONFIG` when `auth: iam` but `script.aws` (hence the signer) is unavailable |
| `single-request`         | Guard-resolves `path` (throws `_CONFIG` when missing); runs `destructive-gate` when `method` is mutating (`POST`/`PUT`/`PATCH`/`DELETE`; `GET`/`HEAD` are not gated); resolves auth headers for the one request; builds the `M3LHttpRequestOptions` and calls `httpClient.request()`; writes the response to `output` when configured                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `batch-request`          | Guard-resolves `input` (throws `_CONFIG` when missing); runs `destructive-gate` **once up front** when the configured `method` is mutating; streams `input` JSONL request-parameter records, resolves auth headers per record (IAM signs each record's own resolved URL/body), and fans each record through `M3LConcurrencyPool(maxInFlight).runEach(...)`; successful responses append to `output`, per-request failures (original record + normalized error info) append to `paths.resolveOutput("failed.jsonl")`. A best-effort writer `close()` on the error path never masks the original throw                                                                                                                                                                                                |
| `destructive-gate`       | Shared confirmation step (mirrors `sqs-etl`'s): prints the target verb + URL, prompts via `script.prompt.confirm(description)`, and throws `ERR_API_GATEWAY_CLIENT_ABORTED` when declined; bypassed by `yes` (bypass logged as a warning so an unattended run still leaves an audit trail)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

All HTTP dispatch goes through a script-constructed `Core.M3LHttpClient` (see
[`core/network`](../core/network.md)) configured with `baseUrl`; SigV4 signing
goes through `script.aws.clients.requestSigner` (`AWS.M3LRequestSigner`, see
[`aws/signing`](../aws/signing.md)); the batch fan-out uses
`Core.M3LConcurrencyPool` (see [`core/utils`](../core/utils.md)). This script
never imports `@aws-sdk/*`, `@smithy/*`, or `undici` directly (ADR-0029).

Script-local error codes are plain `M3LError.code` strings (the field is an open
`string`, not a closed union, so script-local codes are fine — exactly like
`sqs-etl`'s `ERR_SQS_ETL_*`), all prefixed `ERR_API_GATEWAY_CLIENT_`:

- `ERR_API_GATEWAY_CLIENT_CONFIG` — a guard-checked config/auth requirement was
  unmet (missing `path` for `request`, missing `input` for `batch`, missing
  `apiKey` for `api-key`, unavailable signer/`aws.profile` for `iam`, or an
  unrecognized `command`).
- `ERR_API_GATEWAY_CLIENT_ABORTED` — the destructive-gate confirmation was
  declined.
- `ERR_API_GATEWAY_CLIENT_NO_CORRELATION_ID` — thrown by `getCorrelationId()`
  when read before `onBeforeRun` has captured it (mirrors `sqs-etl`'s hook
  guard).

## Inputs and outputs

Buffers JSONL request-parameter records from `M3L_INPUT_DIR` (`batch` mode only,
via `input`); every other knob (`baseUrl`, `method`, `path`, `body`, `auth`,
`maxInFlight`, `yes`) comes from config, and the `apiKey` secret from `.env` —
never from input-file content. Writes response bodies to the configured `output`
under `M3L_OUTPUT_DIR` (both modes, when set), and per-request `batch` failures
to the fixed `failed.jsonl` re-drive file — each row is the original
request-parameter record plus normalized error info (HTTP status / failure
reason / message, never `authorization` or `apiKey`), ready to re-drive with no
bookkeeping. Two failure reasons are specific to this script's batch fan-out,
beyond a plain request failure: `"path-origin-mismatch"` — the record's `path`
resolved to an absolute URL whose origin differs from `baseUrl`'s, so the
record is rejected _before_ auth headers are resolved or the request is sent
(a hardening guard against a batch record smuggling the signed credential to
an unintended origin); and `"output-write-failed"` — the HTTP request
**succeeded**, but persisting the response to `output` failed. The latter is
deliberately distinguished from a request failure: blindly re-driving a
`failed.jsonl` entry with a mutating `method` would re-issue an
already-successful call, so operators should treat `"output-write-failed"`
rows differently (re-fetch/reconcile, not resend).

## Out of scope for this iteration

- **Named request "presets" library** (a reusable catalog of named request
  templates) is deferred — v1 uses explicit config fields (`method`/`path`/
  `body`) plus per-record JSONL parameters only.
- **Per-record `method`/`headers` overrides in batch mode** — the configured
  `method` applies uniformly to every record, which is exactly what lets the
  destructive gate run once up front rather than per record.
- **Checkpoint/resume** for a killed `batch` run (it restarts rather than
  resuming) — mirrors `sqs-etl`'s deferral; filed as a friction candidate, not
  silently dropped.
- **Client-side rate capping / throttle backoff** — v1 has no retry layer
  (`Core.M3LHttpClient` is transport-only), so a `429`/`5xx` surfaces as a
  per-request failure to `failed.jsonl` rather than being retried.
- **Response transformation/projection** (`fields`/`filters`) — responses are
  persisted verbatim.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [`core/network`](../core/network.md) — `M3LHttpClient`, the only HTTP access seam this script uses
- [`aws/signing`](../aws/signing.md) — `M3LRequestSigner`, the SigV4 header source for `auth: iam`
- [`core/utils`](../core/utils.md) — `M3LConcurrencyPool`, the bounded batch fan-out primitive
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — why the SigV4 dependency is library-owned, not script-local
