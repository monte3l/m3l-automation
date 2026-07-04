# `network` — HTTP Client

The `network` module provides `M3LHttpClient`, an event-emitting HTTP client wrapping `undici` with sensible defaults for automation scripts.

## Overview

`M3LHttpClient` extends the library's event emitter base, so requests and responses can be observed through typed events. It wraps `undici`'s `fetch`, parses JSON responses automatically, enforces a request timeout via `AbortController`, and turns non-2xx responses into typed errors. An optional proxy URL routes traffic through local debugging proxies such as Charles or Proxyman.

## Public API

Exported from `@m3l-automation/m3l-common/core` (surfaced through the `Core`
namespace barrel):

| Symbol                    | Kind  | Purpose                                                                           |
| ------------------------- | ----- | --------------------------------------------------------------------------------- |
| `M3LHttpClient`           | class | Event-emitting HTTP client over `undici` (GET-only).                              |
| `M3LHttpClientOptions`    | type  | Constructor configuration.                                                        |
| `M3LHttpClientError`      | class | Typed error thrown for every request failure (code `ERR_HTTP_REQUEST`).           |
| `M3LHttpFailureReason`    | type  | The failure discriminator exposed as the typed `M3LHttpClientError.reason` field. |
| `M3LHttpAbortableRequest` | type  | Return shape of `getAbortable()` — `{ readonly promise, readonly abort() }`.      |
| `M3LHttpRequestEvent`     | type  | Payload of the `request` event (`{ method, url, headers }`).                      |
| `M3LHttpResponseEvent`    | type  | Payload of the `response` event (`{ method, url, status, ok, durationMs }`).      |
| `M3LHttpErrorEvent`       | type  | Payload of the `error` event (`{ method, url, error }`).                          |
| `M3LHttpClientEventMap`   | type  | Maps each event name to its payload type.                                         |

### Configuration (`M3LHttpClientOptions`)

| Option           | Default        | Purpose                                                              |
| ---------------- | -------------- | -------------------------------------------------------------------- |
| `baseUrl`        | —              | Base URL prepended to request paths.                                 |
| `defaultHeaders` | —              | Headers merged into every request.                                   |
| `timeout`        | `30000` (30 s) | Per-request timeout, enforced via `AbortController`.                 |
| `debug`          | —              | Enables structured request logging.                                  |
| `proxyUrl`       | —              | Optional `ProxyAgent` target for proxy debugging (Charles/Proxyman). |

### Events

`M3LHttpClient` extends the event emitter base, so you can subscribe to its typed events with `on()`. Handler signatures are enforced against the declared event payload types, and a failing handler does not affect the others.

It emits exactly three events around each request lifecycle:

| Event      | Payload type           | When                                                                                                        |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `request`  | `M3LHttpRequestEvent`  | Just before dispatch. `headers` is a defensive copy — mutating it does not alter the outgoing request.      |
| `response` | `M3LHttpResponseEvent` | Once any response is received (including non-2xx), with the wall-clock `durationMs`.                        |
| `error`    | `M3LHttpErrorEvent`    | When the request fails (non-2xx, network, timeout, or abort), carrying the normalized `M3LHttpClientError`. |

### Cancellable requests

`getAbortable<T>()` returns `{ promise, abort() }`, letting a caller cancel an in-flight request before it settles.

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

- **GET-only.** The client issues `GET` requests; `get()` and `getAbortable()` take a single `path` argument.
- **Automatic JSON parsing.** Responses whose `Content-Type` matches `/[/+]json\b/i` are parsed as JSON automatically. A 2xx response with any other content type resolves to the raw response text (returned as the caller-asserted `T`). The generic `T` on `get<T>()`/`getAbortable<T>()` is **caller-asserted and not validated at runtime**.
- **Non-2xx → error.** Any non-2xx response throws `M3LHttpClientError`.
- **One error type, discriminated by reason.** Every failure — non-2xx status, underlying network failure, timeout, or manual abort — surfaces as a single `M3LHttpClientError` with `code === "ERR_HTTP_REQUEST"`. The specific failure mode is exposed as the typed, always-present `reason` field (an `M3LHttpFailureReason`: `"status" | "network" | "timeout" | "abort"`); the non-2xx case additionally sets the typed optional `status` field. A caller catches `M3LHttpClientError` and branches on `error.reason` with no cast — `switch (error.reason)` is exhaustive. The request `url` is also carried on `context`. Timeout and abort chain the underlying `AbortError` as `cause`.
- **Timeout.** The default 30-second timeout is enforced through `AbortController`; override it with the `timeout` option. A timed-out request always rejects (`reason: "timeout"`) — it never hangs or silently resolves.
- **Cancellable requests.** `getAbortable()` returns an `M3LHttpAbortableRequest` (`{ readonly promise, readonly abort() }`); calling `abort()` rejects `promise` with `reason: "abort"`.
- **Observable.** Because the client extends the event emitter base, requests can be traced via typed events; one failing handler does not disrupt the others.
- **Proxy debugging.** `proxyUrl` wires up an `undici` `ProxyAgent` (constructed once per client and reused) for inspection in tools like Charles or Proxyman.
- **Logging & sensitive data.** The client never logs by default. When `debug: true`, it writes structured `{ method, url, status }` lines to `console.debug` — it never logs request/response bodies or headers. Note that the resolved `url` (in debug output, in `M3LHttpClientError.context.url`, and in the error `message`) reflects whatever the caller supplied: if a URL embeds credentials (userinfo or a token in the query string), those can surface through debug logs or a serialized error. Likewise, the `request` event payload's `headers` may include `Authorization`/API keys from `defaultHeaders`; avoid logging event payloads verbatim in handlers. Inputs (`baseUrl`, `proxyUrl`, `path`) are trusted — the client applies no SSRF/URL validation.

## See also

- [`events`](./events.md) — the event emitter base `M3LHttpClient` extends.
- [`polling`](./polling.md) — retry and polling helpers for flaky endpoints.
- [`errors`](./errors.md) — the `LibError` hierarchy `M3LHttpClientError` belongs to.
- [`logging`](./logging.md) — structured logging that pairs with `debug`.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
