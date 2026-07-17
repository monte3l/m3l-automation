# Request Signing

`M3LRequestSigner` produces AWS Signature Version 4 (SigV4) signing headers for
an arbitrary HTTP request, so a caller can authenticate a request to an
IAM-protected endpoint (e.g. AWS API Gateway with IAM auth) without importing
`@smithy/*` signing primitives directly. See
[ADR-0029](../../adr/0029-script-dependency-boundary.md) for why the SigV4
dependency is owned by the library rather than a consumer script, and
[ADR-0017](../../adr/0017-dependency-loading-standard.md) for the exact-pin
policy on the new `@smithy/*` runtime dependencies.

## Overview

Every AWS client getter on `AWSClientProvider` hands back a raw AWS SDK v3
client that signs its own requests internally — see [AWS Clients](./clients.md).
`M3LRequestSigner` covers the case those clients do not: signing a _bespoke_
HTTP request (a raw `execute-api` call to API Gateway) that no service-specific
SDK client models. It resolves credentials the same profile-aware way
`AWSClientProvider` does — `fromIni({ profile })` when a profile is supplied,
the SDK default credential chain otherwise — and returns only the SigV4 signing
headers, ready to merge into an outgoing request.

- `M3LRequestSigner` — the signer class; resolves credentials and produces
  signing headers.
- `M3LSigningError` — thrown when signing fails (e.g. credential resolution).
- Plain types: `M3LRequestSignerOptions`, `M3LSignableRequest`.

## Public API

### `M3LRequestSigner`

**Constructor** — `new M3LRequestSigner(options?)`, where `options` is an
`M3LRequestSignerOptions`:

- `region?` — the `M3LAWSRegion` to sign for; defaults to `AWS_REGION`
  (`eu-south-1`) when omitted.
- `profile?` — the `M3LAWSProfile` whose credentials sign the request; when
  omitted, the SDK default credential chain applies.
- `service?` — the AWS service name embedded in the credential scope; defaults
  to `"execute-api"` (API Gateway).

Construction performs no I/O — no credentials are resolved until
`signedHeaders` is first called. When accessed via
`AWSClientProvider.requestSigner` (the cached convenience getter), the signer is
built from the provider's own `profile`/`region`.

| Method                   | Returns                           | Throws            |
| ------------------------ | --------------------------------- | ----------------- |
| `signedHeaders(request)` | `Promise<Record<string, string>>` | `M3LSigningError` |

`signedHeaders(request)` takes an `M3LSignableRequest`
(`{ method, url, headers?, body? }`), parses `url`, builds the canonical request
internally, signs it, and resolves to a plain record of **just the SigV4 signing
headers**: `authorization`, `x-amz-date`, `x-amz-content-sha256`, and
`x-amz-security-token` (the last present only when the resolved credentials
carry a session token). Header keys are lowercase, matching SigV4's canonical
form; the caller's own request headers are not echoed back. The caller merges
the returned headers into the outgoing request.

A raw `@smithy/protocol-http` `HttpRequest` never appears in the public surface
— the plain `M3LSignableRequest` is translated into one internally and the
result is reduced back to a header record.

### `M3LSigningError`

Subclass of `M3LError` with `code: "ERR_SIGNING_FAILURE"`. Thrown by
`signedHeaders` when the request URL is malformed or the underlying SigV4
signing fails — most commonly a credential-resolution failure surfaced when the
lazily-resolved credential provider is first invoked. The originating error is
chained via `cause`.

### Plain types

- **`M3LRequestSignerOptions`** — `{ region?, profile?, service? }`. All fields
  optional; `region` defaults to `AWS_REGION`, `service` defaults to
  `"execute-api"`, and an omitted `profile` selects the SDK default credential
  chain.
- **`M3LSignableRequest`** — `{ method, url, headers?, body? }`. A plain,
  SDK-free description of the request to sign: `method` is the HTTP method,
  `url` the absolute request URL (its host, path, and query are all folded into
  the canonical request), `headers` any caller headers that must be covered by
  the signature, and `body` the request body as a string.

## Usage

### From within a script

```typescript
// script.aws.clients.requestSigner is the cached convenience getter
const signer = script.aws.clients.requestSigner;

const headers = await signer.signedHeaders({
  method: "POST",
  url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "world" }),
});
// headers now carries authorization / x-amz-date / x-amz-content-sha256
// (and x-amz-security-token for temporary credentials) — merge them into the
// outgoing request's headers.
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const signer = new AWS.M3LRequestSigner({
  profile: AWS.parseAWSProfile("my-profile"),
  region: AWS.parseAWSRegion("eu-south-1"),
});

const headers = await signer.signedHeaders({
  method: "GET",
  url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
});
```

## Notes and behavior

- No `@smithy/*` type ever appears in this module's public surface — the
  `HttpRequest` shape SigV4 consumes is built and reduced back to a plain header
  record entirely inside `aws/signing/client.ts`.
- SigV4 requires a SHA-256 `ChecksumConstructor`; this module supplies a thin
  `node:crypto`-backed adapter internally rather than depending on
  `@aws-crypto/sha256-js`.
- Construction resolves no credentials and performs no I/O; credential
  resolution is deferred to the first `signedHeaders` call, so a bad profile
  surfaces as an `M3LSigningError` from `signedHeaders`, not from the
  constructor.
- `AWSClientProvider` exposes a cached `requestSigner` getter that constructs an
  `M3LRequestSigner` from the provider's own `profile`/`region`, mirroring the
  `sqsOperations` convenience getter; it holds no destroyable resource of its
  own and is cleared (not independently destroyed) by `provider.close()`.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider` and the cached
  `requestSigner` convenience getter this module is reached through.
- [AWS Models](./models.md) — `M3LAWSRegion` / `M3LAWSProfile` and their
  parsers, reused for this signer's options.
- [Network](../core/network.md) — `M3LHttpClient`, into whose request headers
  the signing headers are merged.
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — why the library
  owns the SigV4 dependency instead of the consumer script.
- [ADR-0017](../../adr/0017-dependency-loading-standard.md) — the exact-pin
  policy for the new `@smithy/*` runtime dependencies.
