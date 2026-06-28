# `network` — HTTP Client

The `network` module provides `M3LHttpClient`, an event-emitting HTTP client wrapping `undici` with sensible defaults for automation scripts.

## Overview

`M3LHttpClient` extends the library's event emitter base, so requests and responses can be observed through typed events. It wraps `undici`'s `fetch`, parses JSON responses automatically, enforces a request timeout via `AbortController`, and turns non-2xx responses into typed errors. An optional proxy URL routes traffic through local debugging proxies such as Charles or Proxyman.

## Public API

Exported from `@m3l-automation/m3l-common/core` (`network` subpath):

| Symbol                 | Kind  | Purpose                                        |
| ---------------------- | ----- | ---------------------------------------------- |
| `M3LHttpClient`        | class | Event-emitting HTTP client over `undici`.      |
| `M3LHttpClientOptions` | type  | Constructor configuration.                     |
| `M3LHttpClientError`   | class | Typed error thrown for non-2xx responses.      |
| event types            | types | Payload types for the events the client emits. |

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

- **Automatic JSON parsing.** Responses whose `Content-Type` matches `/[/+]json\b/i` are parsed as JSON automatically.
- **Non-2xx → error.** Any non-2xx response throws `M3LHttpClientError`.
- **Timeout.** The default 30-second timeout is enforced through `AbortController`; override it with the `timeout` option.
- **Observable.** Because the client extends the event emitter base, requests can be traced via typed events; one failing handler does not disrupt the others.
- **Proxy debugging.** `proxyUrl` wires up an `undici` `ProxyAgent` for inspection in tools like Charles or Proxyman.

## See also

- [`events`](./events.md) — the event emitter base `M3LHttpClient` extends.
- [`polling`](./polling.md) — retry and polling helpers for flaky endpoints.
- [`errors`](./errors.md) — the `LibError` hierarchy `M3LHttpClientError` belongs to.
- [`logging`](./logging.md) — structured logging that pairs with `debug`.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
