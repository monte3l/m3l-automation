# `network` — HTTP Client

The `network` module provides `M3LHttpClient`, an event-emitting HTTP client wrapping `undici` with sensible defaults for automation scripts, plus `M3LFileDownloader`, which streams a response body directly to disk. `M3LHttpClient` offers `get()`/`getAbortable()` GET convenience methods, a general `request()`/`requestAbortable()` pair for issuing any HTTP method with per-request headers and a body, and `requestStream()` for consuming the raw, unbuffered response body.

## Overview

`M3LHttpClient` extends the library's event emitter base, so requests and responses can be observed through typed events. It wraps `undici`'s `fetch`, parses JSON responses automatically, enforces a request timeout via `AbortController`, and turns an unexpected response status into a typed error. An optional proxy URL routes traffic through local debugging proxies such as Charles or Proxyman.

The client exposes three request surfaces:

- `get<T>(path)` / `getAbortable<T>(path)` — GET convenience methods taking a single `path`. Their signatures and behavior are unchanged; internally they now delegate to `request()`/`requestAbortable()` with `method: "GET"`.
- `request<T>(options)` / `requestAbortable<T>(options)` — a general method for any of the six supported HTTP verbs (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`) with optional per-request `headers`, a `body`, and an `expectedStatus` allow-list. The client stays transport-only: it does not serialize the body or infer a `Content-Type`.
- `requestStream(options)` — resolves with the raw `{ status, body }` (a web `ReadableStream<Uint8Array>`), skipping body parsing entirely. Intended for a streaming consumer such as `M3LFileDownloader` that pipes the body to another destination without buffering it in memory.

`M3LFileDownloader` composes with an injected `M3LHttpClient` (via `requestStream()`) to download a URL straight to a file, streaming through `node:stream/promises`'s `pipeline` rather than buffering the whole response.

## Public API

Exported from `@m3l-automation/m3l-common/core` (surfaced through the `Core`
namespace barrel):

| Symbol                     | Kind  | Purpose                                                                                                                                                               |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LHttpClient`            | class | Event-emitting HTTP client over `undici` (GET convenience plus a general `request()` for any method).                                                                 |
| `M3LHttpClientOptions`     | type  | Constructor configuration.                                                                                                                                            |
| `M3LHttpMethod`            | type  | Union of supported HTTP methods (`"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE" \| "HEAD"`).                                                                        |
| `M3LHttpRequestOptions`    | type  | Options for `request()`/`requestAbortable()` — `{ method, path, headers?, body?, expectedStatus? }`.                                                                  |
| `M3LHttpClientError`       | class | Typed error thrown for every request failure (code `ERR_HTTP_REQUEST`).                                                                                               |
| `M3LHttpFailureReason`     | type  | The failure discriminator (`"status" \| "network" \| "timeout" \| "abort"`), exposed as `M3LHttpClientError.reason` and used as the discriminant of `M3LHttpFailure`. |
| `M3LHttpFailure`           | type  | Discriminated failure payload on `M3LHttpClientError.failure`; the `status` code is present **only** on the `"status"` arm.                                           |
| `M3LHttpAbortableRequest`  | type  | Return shape of `getAbortable()`/`requestAbortable()` — `{ readonly promise, readonly abort() }`.                                                                     |
| `M3LHttpRequestEvent`      | type  | Payload of the `request` event (`{ method, url, headers }`).                                                                                                          |
| `M3LHttpResponseEvent`     | type  | Payload of the `response` event (`{ method, url, status, ok, durationMs }`).                                                                                          |
| `M3LHttpErrorEvent`        | type  | Payload of the `error` event (`{ method, url, error }`).                                                                                                              |
| `M3LHttpClientEventMap`    | type  | Maps each event name to its payload type.                                                                                                                             |
| `M3LFileDownloader`        | class | Streams an HTTP response body directly to a file on disk via an injected `M3LHttpClient`.                                                                             |
| `M3LFileDownloaderOptions` | type  | Constructor options for `M3LFileDownloader` — `{ httpClient: M3LHttpClient }`.                                                                                        |

### Configuration (`M3LHttpClientOptions`)

| Option             | Default        | Purpose                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | —              | Base URL prepended to request paths.                                                                                                                                                                                                                                                                              |
| `defaultHeaders`   | —              | Headers merged into every request.                                                                                                                                                                                                                                                                                |
| `timeout`          | `30000` (30 s) | Per-request timeout, enforced via `AbortController`.                                                                                                                                                                                                                                                              |
| `debug`            | —              | Enables structured request logging.                                                                                                                                                                                                                                                                               |
| `proxyUrl`         | —              | Optional `ProxyAgent` target for proxy debugging (Charles/Proxyman).                                                                                                                                                                                                                                              |
| `maxResponseBytes` | unbounded      | Optional cap, in bytes, on a buffered response body for `request()`/`get()`; exceeding it rejects with `M3LHttpClientError` (`failure.reason === "network"`). Must be a positive integer or the constructor throws `M3LError` (`ERR_INVALID_ARGUMENT`). Does not apply to `requestStream()`, which never buffers. |

### General requests (`request` / `requestAbortable`)

For any HTTP verb, use `request()` (awaitable) or `requestAbortable()` (with a cancel handle). Both take a single `M3LHttpRequestOptions` object and return exactly what their GET counterparts do:

- `request<T>(options: M3LHttpRequestOptions): Promise<T>`
- `requestAbortable<T>(options: M3LHttpRequestOptions): M3LHttpAbortableRequest<T>`

`M3LHttpRequestOptions` fields:

| Field            | Type                                       | Required | Purpose                                                                                                                                                                                     |
| ---------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`         | `M3LHttpMethod`                            | yes      | HTTP verb to dispatch (`"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE" \| "HEAD"`).                                                                                                        |
| `path`           | `string`                                   | yes      | Request path or full URL; resolved against `baseUrl` exactly like `get()`.                                                                                                                  |
| `headers`        | `Record<string, string>`                   | no       | Per-request headers, shallow-merged **over** `defaultHeaders` (`{ ...defaultHeaders, ...headers }`); on an identical key the per-request value wins.                                        |
| `body`           | `string \| Uint8Array`                     | no       | Request body passed straight to `undici`. Not serialized; no `Content-Type` inferred. Omit for `GET`/`HEAD`.                                                                                |
| `expectedStatus` | `number \| readonly [number, ...number[]]` | no       | Accepted response status(es). Omitted → any 2xx is success (current `get()` behavior). A single `number` → exact match. A non-empty array → membership. Anything else → `"status"` failure. |

Both `get<T>(path)` and `getAbortable<T>(path)` keep their single-`path` signatures and delegate internally — `get(path)` is equivalent to `request({ method: "GET", path })`.

### Events

`M3LHttpClient` extends the event emitter base, so you can subscribe to its typed events with `on()`. Handler signatures are enforced against the declared event payload types, and a failing handler does not affect the others.

It emits exactly three events around each request lifecycle, for every method:

| Event      | Payload type           | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`  | `M3LHttpRequestEvent`  | Just before dispatch. `method` is the resolved HTTP verb; `headers` is the merged set, as a defensive copy with every header masked to `"[REDACTED]"` except a small fixed allowlist of known-safe names (`accept`, `content-type`, `user-agent`, etc. — see "Logging & sensitive data" below) — mutating it does not alter the outgoing request, and the real (unredacted) headers are still what `undici` dispatches. `url` on all three events is NOT sanitized — it carries the full resolved URL, including any query string or fragment. |
| `response` | `M3LHttpResponseEvent` | Once any response is received (including an unaccepted status), with the wall-clock `durationMs`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `error`    | `M3LHttpErrorEvent`    | When the request fails (unaccepted status, network, timeout, or abort), carrying the normalized `M3LHttpClientError`.                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Cancellable requests

`getAbortable<T>()` and `requestAbortable<T>()` return `{ promise, abort() }`, letting a caller cancel an in-flight request before it settles.

### Streaming requests (`requestStream`) and `M3LFileDownloader`

`requestStream(options)` shares the same URL resolution, header merging, timeout/abort handling, proxy dispatcher forwarding, status-acceptance, and failure-normalization logic as `request()` — the only difference is that an accepted response skips body parsing and resolves with the raw stream instead:

- `requestStream(options: { method, path, headers? }): Promise<{ status: number; body: ReadableStream<Uint8Array> }>`

It always accepts any 2xx status (there is no `expectedStatus` option here, matching `get()`'s default behavior), and throws `M3LHttpClientError` on a non-2xx response, a network failure, a timeout, or a 2xx response with no body at all. **The timeout genuinely bounds the entire transfer, not just header acquisition**: the returned `body` stream stays wired to the same underlying timeout/`AbortController` for as long as it is being read, so a connection that goes quiet mid-transfer still times out — the stream errors with the same normalized `M3LHttpClientError` a caller would get from `request()`, instead of hanging forever.

`M3LFileDownloader` is the streaming-to-disk consumer built on top of it:

- `new M3LFileDownloader({ httpClient: M3LHttpClient })`
- `download(url: string, destinationPath: string): Promise<void>`

`download()` calls `requestStream({ method: "GET", path: url })` and pipes the resolved body to `destinationPath` via `node:stream/promises`'s `pipeline`, never buffering the full response in memory. A failed download — whether the failure happens before the first byte (non-2xx status, network failure, timeout), mid-transfer (a stalled or dropped connection), or on the write side (a bad `destinationPath`) — always surfaces as `M3LHttpClientError` and never leaves a partial file behind: `download()` best-effort deletes the destination path on any `pipeline()` failure, in addition to the pre-write case where nothing was ever written at all.

## Usage

```typescript
import { Core } from "@m3l-automation/m3l-common";

const client = new Core.M3LHttpClient({
  baseUrl: "https://api.example.com",
  defaultHeaders: { accept: "application/json" },
  timeout: 10_000,
});

// JSON responses are parsed automatically.
const data = await client.get<{ id: string; name: string }>("/users/42");
console.log(data.name);
```

General request (POST with a per-request header, a caller-serialized body, and an explicit accepted status):

```typescript
import { Core } from "@m3l-automation/m3l-common";

const client = new Core.M3LHttpClient({
  baseUrl: "https://api.example.com",
  defaultHeaders: { accept: "application/json" },
});

// The client is transport-only: the caller serializes the body and sets a
// matching Content-Type. `expectedStatus: 201` means only a 201 succeeds.
const created = await client.request<{ id: string }>({
  method: "POST",
  path: "/users",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Ada" }),
  expectedStatus: 201,
});
console.log(created.id);
```

Cancellable request via `getAbortable`:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const client = new Core.M3LHttpClient({ baseUrl: "https://api.example.com" });

const { promise, abort } = client.getAbortable<{ items: readonly string[] }>(
  "/slow",
);

// Abort if it takes too long for the caller's purposes.
setTimeout(abort, 2_000);

try {
  const result = await promise;
  console.log(result.items);
} catch (error) {
  if (error instanceof Core.M3LHttpClientError) {
    console.error(`request failed: ${error.message}`);
    // `status` is reachable only on the "status" arm.
    if (error.failure.reason === "status") {
      console.error(`HTTP ${error.failure.status}`);
    }
  }
}
```

Routing through a local debugging proxy:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const client = new Core.M3LHttpClient({
  baseUrl: "https://api.example.com",
  proxyUrl: "http://127.0.0.1:8888", // Charles / Proxyman
  debug: true,
});
```

Downloading a file straight to disk without buffering the response in memory:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const downloader = new Core.M3LFileDownloader({
  httpClient: new Core.M3LHttpClient(),
});

await downloader.download(
  "https://example.com/report.csv",
  "./data/output/report.csv",
);
```

## Notes & behavior

- **GET convenience + general requests.** `get()`/`getAbortable()` issue `GET` and take a single `path`; their signatures and behavior are unchanged. `request()`/`requestAbortable()` issue any `M3LHttpMethod` from an options object, and the GET methods are thin delegations to them (`get(path)` ≡ `request({ method: "GET", path })`).
- **Per-request headers merge over defaults.** `options.headers` are shallow-merged onto `defaultHeaders` (`{ ...defaultHeaders, ...options.headers }`); on an identical key the per-request value wins. Header-name case is not normalized by the client (`undici` normalizes at dispatch). The merged set is what `undici` dispatches; the `request` event reports the same set with sensitive values redacted (see "Logging & sensitive data" below).
- **Transport-only body.** A `body` (`string | Uint8Array`) is passed straight to `undici`'s `fetch` with no auto-JSON-stringify and no inferred `Content-Type` — the caller owns serialization and any matching content-type header. When `body` is omitted, no body is sent. The client does not validate method/body combinations; passing a body with `GET`/`HEAD` is rejected by `undici` and surfaces as a `"network"` failure.
- **Status success is configurable.** With `expectedStatus` omitted, any 2xx is success (identical to `get()` today). A single `number` accepts exactly that status; a `readonly number[]` accepts any listed status. A response whose status is not accepted throws `M3LHttpClientError` with `failure.reason === "status"` carrying that response `status` — for any method, reusing code `ERR_HTTP_REQUEST` (no new error type). The `response` event's `ok` field independently continues to mean "status in the 2xx range", so `ok` and the throw-decision can diverge when `expectedStatus` is set (e.g. a 200 with `expectedStatus: 201` fires `response` with `ok: true` yet throws).
- **`Retry-After` is parsed into `retryAfterMs`.** A non-accepted response's `Retry-After` header (both grammars RFC 9110 allows — delta-seconds, e.g. `"120"`, and an HTTP-date) is parsed into a millisecond delay and carried as the thrown `M3LHttpClientError`'s top-level `retryAfterMs` field — a past HTTP-date clamps to `0`, never negative; a missing or unparseable header leaves it `undefined`. This is what makes `httpRetryAfterClassifier` (`core/polling`) actually fire: the classifier reads `err.retryAfterMs` directly and, when present, returns a `{ decision: "retriable", delayMs: retryAfterMs }` advice so the server's own back-off directs the retry. `retryAfterMs` is only ever set for a `"status"`-reason failure — network/timeout/abort failures never carry it.
- **Automatic JSON parsing.** For both `get()` and `request()`, responses whose `Content-Type` matches `/[/+]json\b/i` are parsed as JSON automatically. An accepted response with any other content type resolves to the raw response text (returned as the caller-asserted `T`). The generic `T` on `get<T>()`/`getAbortable<T>()`/`request<T>()`/`requestAbortable<T>()` is **caller-asserted and not validated at runtime**.
- **Response size is optionally bounded.** `maxResponseBytes` caps a buffered response body's total size for `get()`/`request()`; bytes are counted as the body stream is read, and the moment the running total exceeds the cap, the read aborts and the request rejects with `M3LHttpClientError` (`failure.reason === "network"`) instead of continuing to buffer an unbounded body into memory. Omitted (the default) is unbounded, matching every prior release. This does not apply to `requestStream()`, which never buffers a body regardless of its size.
- **One error type, with a discriminated failure payload.** Every failure — unaccepted status, underlying network failure, timeout, or manual abort — surfaces as a single `M3LHttpClientError` with `code === "ERR_HTTP_REQUEST"`. The specific mode is exposed two ways: the always-present convenience field `reason` (an `M3LHttpFailureReason`), and the discriminated `failure` payload (an `M3LHttpFailure`) where the response `status` code lives **only** on the `"status"` arm — so `error.failure.status` is reachable only after `error.failure.reason === "status"` narrows it, and an illegal state such as a `"timeout"` failure carrying a `status` is unrepresentable. `reason` is derived from `failure` (`error.reason === error.failure.reason` always). A caller catches `M3LHttpClientError` and branches on `error.reason` or `error.failure.reason` with no cast — both `switch`es are exhaustive. The request `url` is carried on `context`, with any query string or fragment stripped before it reaches either `context.url` or the error `message` (a credential passed as a query parameter or a URL fragment — the OAuth implicit-flow pattern — must never round-trip through a thrown error); timeout and abort chain the underlying `AbortError` as `cause`. Two failure modes are resolved before the request is ever dispatched: an unparseable resolved URL (an invalid `baseUrl`, or a `path` that isn't itself a valid absolute URL when no `baseUrl` is configured — the native `URL` constructor's own thrown error would otherwise embed the raw, unsanitized input as `cause`), and a URL that embeds userinfo (`https://user:pass@host/`), which is rejected outright rather than stripped-and-continued — `undici`'s own `fetch()` unconditionally rejects a credentialed URL, so silently stripping it and proceeding would only defer that same failure to a later, less sanitized point (the stripped-out credential itself is never referenced in either error's message). Both surface exactly like every other failure mode in this client: `M3LHttpClientError` **rejects the returned promise** (`get()`/`request()`'s `Promise<T>`, or `getAbortable()`/`requestAbortable()`'s handle `promise` — the handle itself is still returned synchronously, `abort()` is a safe no-op on it) rather than throwing synchronously out of the calling method, and neither carries a `cause` — but each carries a small, credential-free `context` naming what was implicated (`context.source` — `"path"` or `"path-or-baseUrl"` — for the unparseable case; `context.host` for the userinfo case, since `URL.host` is a separate accessor from `.username`/`.password` and cannot itself carry the rejected credential). Both set `failure.reason` to `"network"` — the opening enumeration above ("unaccepted status, underlying network failure, timeout, or manual abort") does not call out "invalid URL"/"userinfo" as distinct reasons because they aren't: a caller branching on `error.reason` observes `"network"` for both, same as any other pre-flight failure.
- **Timeout.** The default 30-second timeout is enforced through `AbortController`; override it with the `timeout` option. A timed-out request always rejects (`reason: "timeout"`) — it never hangs or silently resolves.
- **Cancellable requests.** `getAbortable()`/`requestAbortable()` return an `M3LHttpAbortableRequest` (`{ readonly promise, readonly abort() }`); calling `abort()` rejects `promise` with `reason: "abort"`.
- **Observable.** Because the client extends the event emitter base, requests can be traced via typed events for every method; one failing handler does not disrupt the others.
- **Proxy debugging.** `proxyUrl` wires up an `undici` `ProxyAgent` (constructed once per client and reused) for inspection in tools like Charles or Proxyman.
- **Logging & sensitive data.** The client never logs by default.
  - **Userinfo, as the WHATWG `URL` parser recognizes it, never reaches any surface at all.** `#resolveUrl` rejects a URL whose parsed `username`/`password` are non-empty (`https://user:pass@host/`, including protocol-relative and non-special-scheme variants) immediately, before the request is dispatched and before any event fires — so unlike the query-string/fragment case below, there is nothing to strip downstream: the credential never reaches `context.url`, `message`, `cause`, or any of the `request`/`response`/`error` events' `url` fields, because none of those are ever populated for a rejected request. This check is only as strong as the URL parser's own model of "userinfo": a schemeless, credential-_looking_ string that `new URL()` parses as an opaque value with no actual username/password (e.g. `"myuser:s3cret@api.example.com/path"` — not preceded by `//`) is not recognized as userinfo and is not rejected; such a string is the caller's malformed input either way and is not specifically protected by this check.
  - Every `M3LHttpClientError` this module throws for a request that WAS dispatched — including `M3LFileDownloader`'s write-side failure, which reuses the same error type and the same sanitizer — always has its `context.url` and `message` stripped of the query string and fragment, so a credential passed as a query parameter (`?token=...`) or a URL fragment (`#access_token=...`, a presigned-URL signature, an OAuth implicit-flow token) never round-trips through a thrown error.
  - The `request` event's `headers` are built from a **fixed allowlist of known-safe header names** (`accept`, `accept-encoding`, `accept-language`, `cache-control`, `connection`, `content-length`, `content-type`, `host`, `user-agent`; case-insensitive) — every other header, including `Cookie`, `Authorization`, or a made-up vendor header the library has never seen, is replaced with `"[REDACTED]"` in full. This is deliberately an allowlist rather than a denylist of "known-sensitive" names: the credential-bearing header namespace is unbounded and caller-controlled, so a name-based denylist cannot converge. The tradeoff is that a genuinely harmless but unrecognized header (e.g. a custom correlation-ID header) is also masked on this event.
  - **One residual surface is left unstripped by design, for a request that WAS dispatched:** the `request`/`response`/`error` events' own top-level `url` field always carries the full resolved URL including any query string or fragment (only the `M3LHttpClientError` `context.url`/`message` and the `request` event's `headers` are sanitized — the event's own `url` field is not). `debug: true` output has the same property — it writes structured `{ method, url, status }` (success) or `{ method, url, error }` (failure) lines to `console.debug` using the full, unredacted `url` and never headers — this opt-in path is the caller's own responsibility to gate.
  - Inputs (`baseUrl`, `proxyUrl`, `path`, `body`) are trusted for their **content and destination** — the client applies no SSRF validation and does not restrict which hosts/paths a caller may target. `baseUrl`/`path` **are** validated for URL well-formedness and absence of embedded userinfo (see the two upfront failure modes above), but that is a syntax/shape check, not a safety check. `proxyUrl` is not validated the same way — a malformed `proxyUrl` still surfaces as a raw, unsanitized error from the `M3LHttpClient` constructor, a known gap tracked for a future pass rather than fixed here.
- **`M3LFileDownloader` composes, never opens its own connection.** It is constructed with an injected `M3LHttpClient` and issues its request through that client's `requestStream()`, inheriting the injected client's `baseUrl`, `defaultHeaders`, `timeout`, and `proxyUrl` configuration rather than opening a separate `undici` dispatcher. An existing file at `destinationPath` is overwritten.
- **`M3LFileDownloader`'s write-side failures also surface as `M3LHttpClientError`.** A filesystem-side failure (e.g. a `destinationPath` whose parent directory does not exist) is wrapped the same way a mid-transfer body failure is — `cause` carries the underlying Node error, `failure.reason` is `"network"` — so callers never have to distinguish an HTTP-layer failure from a disk-layer one by error type.

## See also

- [`events`](./events.md) — the event emitter base `M3LHttpClient` extends.
- [`polling`](./polling.md) — retry and polling helpers for flaky endpoints.
- [`errors`](./errors.md) — the `LibError` hierarchy `M3LHttpClientError` belongs to.
- [`logging`](./logging.md) — structured logging that pairs with `debug`.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
