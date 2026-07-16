# `network` — HTTP Client

The `network` module provides `M3LHttpClient`, an event-emitting HTTP client wrapping `undici` with sensible defaults for automation scripts. It offers `get()`/`getAbortable()` GET convenience methods plus a general `request()`/`requestAbortable()` pair for issuing any HTTP method with per-request headers and a body.

## Overview

`M3LHttpClient` extends the library's event emitter base, so requests and responses can be observed through typed events. It wraps `undici`'s `fetch`, parses JSON responses automatically, enforces a request timeout via `AbortController`, and turns an unexpected response status into a typed error. An optional proxy URL routes traffic through local debugging proxies such as Charles or Proxyman.

The client exposes two request surfaces:

- `get<T>(path)` / `getAbortable<T>(path)` — GET convenience methods taking a single `path`. Their signatures and behavior are unchanged; internally they now delegate to `request()`/`requestAbortable()` with `method: "GET"`.
- `request<T>(options)` / `requestAbortable<T>(options)` — a general method for any of the six supported HTTP verbs (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`) with optional per-request `headers`, a `body`, and an `expectedStatus` allow-list. The client stays transport-only: it does not serialize the body or infer a `Content-Type`.

## Public API

Exported from `@m3l-automation/m3l-common/core` (surfaced through the `Core`
namespace barrel):

| Symbol                    | Kind  | Purpose                                                                                                                                                               |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LHttpClient`           | class | Event-emitting HTTP client over `undici` (GET convenience plus a general `request()` for any method).                                                                 |
| `M3LHttpClientOptions`    | type  | Constructor configuration.                                                                                                                                            |
| `M3LHttpMethod`           | type  | Union of supported HTTP methods (`"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE" \| "HEAD"`).                                                                        |
| `M3LHttpRequestOptions`   | type  | Options for `request()`/`requestAbortable()` — `{ method, path, headers?, body?, expectedStatus? }`.                                                                  |
| `M3LHttpClientError`      | class | Typed error thrown for every request failure (code `ERR_HTTP_REQUEST`).                                                                                               |
| `M3LHttpFailureReason`    | type  | The failure discriminator (`"status" \| "network" \| "timeout" \| "abort"`), exposed as `M3LHttpClientError.reason` and used as the discriminant of `M3LHttpFailure`. |
| `M3LHttpFailure`          | type  | Discriminated failure payload on `M3LHttpClientError.failure`; the `status` code is present **only** on the `"status"` arm.                                           |
| `M3LHttpAbortableRequest` | type  | Return shape of `getAbortable()`/`requestAbortable()` — `{ readonly promise, readonly abort() }`.                                                                     |
| `M3LHttpRequestEvent`     | type  | Payload of the `request` event (`{ method, url, headers }`).                                                                                                          |
| `M3LHttpResponseEvent`    | type  | Payload of the `response` event (`{ method, url, status, ok, durationMs }`).                                                                                          |
| `M3LHttpErrorEvent`       | type  | Payload of the `error` event (`{ method, url, error }`).                                                                                                              |
| `M3LHttpClientEventMap`   | type  | Maps each event name to its payload type.                                                                                                                             |

### Configuration (`M3LHttpClientOptions`)

| Option           | Default        | Purpose                                                              |
| ---------------- | -------------- | -------------------------------------------------------------------- |
| `baseUrl`        | —              | Base URL prepended to request paths.                                 |
| `defaultHeaders` | —              | Headers merged into every request.                                   |
| `timeout`        | `30000` (30 s) | Per-request timeout, enforced via `AbortController`.                 |
| `debug`          | —              | Enables structured request logging.                                  |
| `proxyUrl`       | —              | Optional `ProxyAgent` target for proxy debugging (Charles/Proxyman). |

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

| Event      | Payload type           | When                                                                                                                                                          |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`  | `M3LHttpRequestEvent`  | Just before dispatch. `method` is the resolved HTTP verb; `headers` is the merged set, as a defensive copy — mutating it does not alter the outgoing request. |
| `response` | `M3LHttpResponseEvent` | Once any response is received (including an unaccepted status), with the wall-clock `durationMs`.                                                             |
| `error`    | `M3LHttpErrorEvent`    | When the request fails (unaccepted status, network, timeout, or abort), carrying the normalized `M3LHttpClientError`.                                         |

### Cancellable requests

`getAbortable<T>()` and `requestAbortable<T>()` return `{ promise, abort() }`, letting a caller cancel an in-flight request before it settles.

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

## Notes & behavior

- **GET convenience + general requests.** `get()`/`getAbortable()` issue `GET` and take a single `path`; their signatures and behavior are unchanged. `request()`/`requestAbortable()` issue any `M3LHttpMethod` from an options object, and the GET methods are thin delegations to them (`get(path)` ≡ `request({ method: "GET", path })`).
- **Per-request headers merge over defaults.** `options.headers` are shallow-merged onto `defaultHeaders` (`{ ...defaultHeaders, ...options.headers }`); on an identical key the per-request value wins. Header-name case is not normalized by the client (`undici` normalizes at dispatch). The merged set is what the `request` event reports (a defensive copy) and what `undici` dispatches.
- **Transport-only body.** A `body` (`string | Uint8Array`) is passed straight to `undici`'s `fetch` with no auto-JSON-stringify and no inferred `Content-Type` — the caller owns serialization and any matching content-type header. When `body` is omitted, no body is sent. The client does not validate method/body combinations; passing a body with `GET`/`HEAD` is rejected by `undici` and surfaces as a `"network"` failure.
- **Status success is configurable.** With `expectedStatus` omitted, any 2xx is success (identical to `get()` today). A single `number` accepts exactly that status; a `readonly number[]` accepts any listed status. A response whose status is not accepted throws `M3LHttpClientError` with `failure.reason === "status"` carrying that response `status` — for any method, reusing code `ERR_HTTP_REQUEST` (no new error type). The `response` event's `ok` field independently continues to mean "status in the 2xx range", so `ok` and the throw-decision can diverge when `expectedStatus` is set (e.g. a 200 with `expectedStatus: 201` fires `response` with `ok: true` yet throws).
- **Automatic JSON parsing.** For both `get()` and `request()`, responses whose `Content-Type` matches `/[/+]json\b/i` are parsed as JSON automatically. An accepted response with any other content type resolves to the raw response text (returned as the caller-asserted `T`). The generic `T` on `get<T>()`/`getAbortable<T>()`/`request<T>()`/`requestAbortable<T>()` is **caller-asserted and not validated at runtime**.
- **One error type, with a discriminated failure payload.** Every failure — unaccepted status, underlying network failure, timeout, or manual abort — surfaces as a single `M3LHttpClientError` with `code === "ERR_HTTP_REQUEST"`. The specific mode is exposed two ways: the always-present convenience field `reason` (an `M3LHttpFailureReason`), and the discriminated `failure` payload (an `M3LHttpFailure`) where the response `status` code lives **only** on the `"status"` arm — so `error.failure.status` is reachable only after `error.failure.reason === "status"` narrows it, and an illegal state such as a `"timeout"` failure carrying a `status` is unrepresentable. `reason` is derived from `failure` (`error.reason === error.failure.reason` always). A caller catches `M3LHttpClientError` and branches on `error.reason` or `error.failure.reason` with no cast — both `switch`es are exhaustive. The request `url` is carried on `context`; timeout and abort chain the underlying `AbortError` as `cause`.
- **Timeout.** The default 30-second timeout is enforced through `AbortController`; override it with the `timeout` option. A timed-out request always rejects (`reason: "timeout"`) — it never hangs or silently resolves.
- **Cancellable requests.** `getAbortable()`/`requestAbortable()` return an `M3LHttpAbortableRequest` (`{ readonly promise, readonly abort() }`); calling `abort()` rejects `promise` with `reason: "abort"`.
- **Observable.** Because the client extends the event emitter base, requests can be traced via typed events for every method; one failing handler does not disrupt the others.
- **Proxy debugging.** `proxyUrl` wires up an `undici` `ProxyAgent` (constructed once per client and reused) for inspection in tools like Charles or Proxyman.
- **Logging & sensitive data.** The client never logs by default. When `debug: true`, it writes structured `{ method, url, status }` lines to `console.debug` — it never logs request/response bodies or headers. Note that the resolved `url` (in debug output, in `M3LHttpClientError.context.url`, and in the error `message`) reflects whatever the caller supplied: if a URL embeds credentials (userinfo or a token in the query string), those can surface through debug logs or a serialized error. Likewise, the `request` event payload's `headers` may include `Authorization`/API keys from `defaultHeaders` or per-request `headers`; avoid logging event payloads verbatim in handlers. Inputs (`baseUrl`, `proxyUrl`, `path`, `body`) are trusted — the client applies no SSRF/URL validation.

## See also

- [`events`](./events.md) — the event emitter base `M3LHttpClient` extends.
- [`polling`](./polling.md) — retry and polling helpers for flaky endpoints.
- [`errors`](./errors.md) — the `LibError` hierarchy `M3LHttpClientError` belongs to.
- [`logging`](./logging.md) — structured logging that pairs with `debug`.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
