/**
 * Tests for core/network submodule.
 *
 * Contract source: docs/reference/core/network.md, plus the hub-locked
 * behavioral contract for this change set (error codes/reasons, event
 * payload shapes, timeout/abort mechanics via undici).
 *
 * Exports under test: M3LHttpClient, M3LHttpClientError, M3LHttpFailure,
 *   M3LHttpFailureReason, M3LHttpClientOptions, M3LHttpRequestEvent,
 *   M3LHttpResponseEvent, M3LHttpErrorEvent, M3LHttpClientEventMap.
 *
 * The implementation wraps `undici`'s `fetch` and `ProxyAgent`. Both are
 * mocked at the module level so these tests never touch a real socket. The
 * mock `fetch` honors the AbortSignal passed in request options so the
 * timeout/abort tests are realistic without any real wall-clock waiting.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(),
}));

import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { Response as UndiciResponse } from "undici";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LHttpClient,
  M3LHttpClientError,
} from "../src/core/network/index.js";
import type {
  M3LHttpAbortableRequest,
  M3LHttpClientEventMap,
  M3LHttpClientOptions,
  M3LHttpErrorEvent,
  M3LHttpFailure,
  M3LHttpFailureReason,
  M3LHttpRequestEvent,
  M3LHttpResponseEvent,
} from "../src/core/network/index.js";

const mockFetch = vi.mocked(undiciFetch);
const mockProxyAgent = vi.mocked(ProxyAgent);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal shape the implementation relies on from a `fetch` Response. */
interface FakeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Builds a fake fetch Response. undici's `Response` is a concrete class, not
 * a structural interface, so a plain object literal is never structurally
 * assignable to it — the cast at this single boundary keeps every call site
 * typechecking without widening to `any`. The client only ever reads
 * `status`, `ok`, `headers.get`, `json()`, and `text()`, so the mock only
 * needs to implement that subset.
 */
function makeResponse(options: {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}): UndiciResponse {
  const { status, contentType, body } = options;
  const fake: FakeResponse = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    json(): Promise<unknown> {
      return Promise.resolve(body);
    },
    text(): Promise<string> {
      return Promise.resolve(typeof body === "string" ? body : String(body));
    },
  };
  return fake as unknown as UndiciResponse;
}

/**
 * Configures mockFetch to return a promise that rejects with an
 * AbortError-shaped value when the request's AbortSignal fires — mirroring
 * how a real `fetch` implementation reacts to cancellation.
 */
function fetchRespectsAbort(): void {
  mockFetch.mockImplementation((_url: unknown, options?: unknown) => {
    const signal = (options as { readonly signal?: AbortSignal } | undefined)
      ?.signal;
    return new Promise((_resolve, reject) => {
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1 — Happy JSON GET
// ---------------------------------------------------------------------------
describe("M3LHttpClient.get — JSON responses", () => {
  test.each([
    ["application/json", "application/json"],
    ["application/vnd.api+json", "application/vnd.api+json"],
    ["application/ld+json", "application/ld+json"],
  ])("parses a 2xx body when Content-Type is %s", async (contentType) => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        contentType,
        body: { id: "42", name: "ok" },
      }),
    );
    const client = new M3LHttpClient();

    const result = await client.get<{ id: string; name: string }>(
      "https://api.example.com/users/42",
    );

    expect(result).toEqual({ id: "42", name: "ok" });
  });
});

// ---------------------------------------------------------------------------
// 2 — Non-JSON 2xx
// ---------------------------------------------------------------------------
describe("M3LHttpClient.get — non-JSON responses", () => {
  test("resolves to the raw text body when Content-Type does not match the JSON regex", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        contentType: "text/plain",
        body: "hello world",
      }),
    );
    const client = new M3LHttpClient();

    const result = await client.get<string>("https://api.example.com/raw");

    expect(result).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// 3 — baseUrl join
// ---------------------------------------------------------------------------
describe("M3LHttpClient — baseUrl resolution", () => {
  test("joins baseUrl with path", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    await client.get("/users/42");

    const requestedUrl = mockFetch.mock.calls[0]?.[0];
    expect(typeof requestedUrl).toBe("string");
    expect(requestedUrl).toBe("https://api.example.com/users/42");
  });

  test("uses path as the full URL when no baseUrl is configured", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient();

    await client.get("https://other.example.com/resource");

    const requestedUrl = mockFetch.mock.calls[0]?.[0];
    expect(typeof requestedUrl).toBe("string");
    expect(requestedUrl).toBe("https://other.example.com/resource");
  });
});

// ---------------------------------------------------------------------------
// 4 — defaultHeaders merged
// ---------------------------------------------------------------------------
describe("M3LHttpClient — defaultHeaders", () => {
  test("merges defaultHeaders into the outgoing request", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      defaultHeaders: { "x-api-key": "secret", accept: "application/json" },
    });

    await client.get("/ping");

    const options = mockFetch.mock.calls[0]?.[1] as
      { readonly headers?: Record<string, string> } | undefined;
    expect(options?.headers).toMatchObject({
      "x-api-key": "secret",
      accept: "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// 5 — Non-2xx -> M3LHttpClientError
// ---------------------------------------------------------------------------
describe("M3LHttpClient — non-2xx responses", () => {
  test.each([404, 500])(
    "a %d response rejects with M3LHttpClientError carrying typed reason 'status' and a failure.status payload",
    async (status) => {
      mockFetch.mockResolvedValue(
        makeResponse({
          status,
          contentType: "application/json",
          body: { message: "nope" },
        }),
      );
      const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

      await expect(client.get("/broken")).rejects.toBeInstanceOf(
        M3LHttpClientError,
      );

      let thrown: unknown;
      try {
        await client.get("/broken");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LHttpClientError);
      expect(thrown).toBeInstanceOf(M3LError);
      const httpError = thrown as M3LHttpClientError;
      expect(httpError.code).toBe("ERR_HTTP_REQUEST");
      expect(httpError.name).toBe("M3LHttpClientError");
      // Typed own fields, NOT via context — the whole point of C1.
      expect(httpError.reason).toBe("status");
      // The response status lives only on the "status" arm of the
      // discriminated failure payload — narrow before reading it.
      expect(httpError.failure.reason).toBe("status");
      if (httpError.failure.reason === "status") {
        expect(httpError.failure.status).toBe(status);
      }
      // context still carries the request url per the documented contract,
      // but must NOT be the source of truth for reason/status any more.
      expect(httpError.context).toMatchObject({
        url: "https://api.example.com/broken",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 6 — Network failure
// ---------------------------------------------------------------------------
describe("M3LHttpClient — network failure", () => {
  test("rejects with M3LHttpClientError chaining the original thrown value as cause", async () => {
    const networkFailure = new Error("ECONNRESET");
    mockFetch.mockRejectedValue(networkFailure);
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    let thrown: unknown;
    try {
      await client.get("/down");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    const httpError = thrown as M3LHttpClientError;
    expect(httpError.reason).toBe("network");
    // The "network" arm of the discriminated failure payload carries no
    // status field at all — an illegal "network with a status" state is
    // unrepresentable, not merely undefined.
    expect(httpError.failure.reason).toBe("network");
    expect("status" in httpError.failure).toBe(false);
    expect(httpError.cause).toBe(networkFailure);
  });
});

// ---------------------------------------------------------------------------
// 7 — Timeout via AbortController
// ---------------------------------------------------------------------------
describe("M3LHttpClient — request timeout", () => {
  test("default timeout is 30000ms — a request exceeding it rejects with reason 'timeout'", async () => {
    vi.useFakeTimers();
    fetchRespectsAbort();
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    const pending = client.get("/slow");
    const assertion =
      expect(pending).rejects.toBeInstanceOf(M3LHttpClientError);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    let thrown: unknown;
    mockFetch.mockClear();
    fetchRespectsAbort();
    const secondPending = client.get("/slow-again");
    const catchPromise = secondPending.catch((error: unknown) => {
      thrown = error;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await catchPromise;

    expect((thrown as M3LHttpClientError).reason).toBe("timeout");
  });

  test("a shorter timeout override fires before the default 30000ms", async () => {
    vi.useFakeTimers();
    fetchRespectsAbort();
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      timeout: 500,
    });

    let thrown: unknown;
    const pending = client.get("/slow").catch((error: unknown) => {
      thrown = error;
    });

    await vi.advanceTimersByTimeAsync(500);
    await pending;

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    expect((thrown as M3LHttpClientError).reason).toBe("timeout");
  });

  test("the timed-out promise rejects and never hangs or resolves", async () => {
    vi.useFakeTimers();
    fetchRespectsAbort();
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      timeout: 100,
    });

    let settled: "resolved" | "rejected" | undefined;
    const pending = client
      .get("/slow")
      .then(() => {
        settled = "resolved";
      })
      .catch(() => {
        settled = "rejected";
      });

    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(settled).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 8 — getAbortable cancellation
// ---------------------------------------------------------------------------
describe("M3LHttpClient.getAbortable", () => {
  test("returns { promise, abort } and abort() rejects the promise with reason 'abort'", async () => {
    fetchRespectsAbort();
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    const { promise, abort } = client.getAbortable<{ id: string }>("/slow");

    expect(typeof abort).toBe("function");

    let thrown: unknown;
    const settlement = promise.catch((error: unknown) => {
      thrown = error;
    });

    abort();
    await settlement;

    expect(thrown).toBeInstanceOf(M3LHttpClientError);
    expect((thrown as M3LHttpClientError).reason).toBe("abort");
  });

  test("resolves the promise with the parsed body when not aborted (happy path)", async () => {
    const user = { id: "42", name: "Ada" };
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        contentType: "application/json",
        body: user,
      }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    const { promise } = client.getAbortable<{ id: string; name: string }>(
      "/users/42",
    );

    await expect(promise).resolves.toEqual(user);
  });
});

// ---------------------------------------------------------------------------
// 9 — Event emission + handler isolation
// ---------------------------------------------------------------------------
describe("M3LHttpClient — events", () => {
  test("request event fires before dispatch with method/url/headers", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
    const received: M3LHttpRequestEvent[] = [];

    client.on("request", (event) => {
      received.push(event);
    });

    await client.get("/ping");

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("GET");
    expect(received[0]?.url).toBe("https://api.example.com/ping");
    expect(received[0]?.headers).toBeTypeOf("object");
  });

  test("response event fires with status/ok/durationMs (durationMs is a number >= 0)", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
    const received: M3LHttpResponseEvent[] = [];

    client.on("response", (event) => {
      received.push(event);
    });

    await client.get("/ping");

    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe(200);
    expect(received[0]?.ok).toBe(true);
    expect(received[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("error event fires with the M3LHttpClientError on failure", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 500, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
    const received: M3LHttpErrorEvent[] = [];

    client.on("error", (event) => {
      received.push(event);
    });

    await expect(client.get("/broken")).rejects.toBeInstanceOf(
      M3LHttpClientError,
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.error).toBeInstanceOf(M3LHttpClientError);
  });

  test("a throwing 'request' handler does not prevent a second handler from running, and the request still completes", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        contentType: "application/json",
        body: { ok: true },
      }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
    let secondRan = false;

    client.on("request", () => {
      throw new Error("boom in first handler");
    });
    client.on("request", () => {
      secondRan = true;
    });

    const result = await client.get<{ ok: boolean }>("/ping");

    expect(secondRan).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  test("a 'request' handler mutating event.headers does not affect the outgoing fetch headers (no shared reference)", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      defaultHeaders: { accept: "application/json" },
    });

    client.on("request", (event) => {
      // The event payload's `headers` is declared `Readonly<Record<string,
      // string>>`; casting away readonly here simulates a misbehaving
      // handler that tries to mutate its copy — the whole point of this
      // test is to prove that mutation cannot reach the in-flight request.
      const mutable = event.headers as Record<string, string>;
      mutable["x-injected"] = "evil";
      delete mutable["accept"];
    });

    await client.get("/ping");

    const options = mockFetch.mock.calls[0]?.[1] as
      { readonly headers?: Record<string, string> } | undefined;
    expect(options?.headers).toMatchObject({ accept: "application/json" });
    expect(options?.headers).not.toHaveProperty("x-injected");
  });
});

// ---------------------------------------------------------------------------
// 10 — proxyUrl -> ProxyAgent
// ---------------------------------------------------------------------------
describe("M3LHttpClient — proxy support", () => {
  test("constructs a ProxyAgent and passes it as the per-request dispatcher when proxyUrl is set", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      proxyUrl: "http://127.0.0.1:8888",
    });

    await client.get("/ping");

    expect(mockProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:8888");
    const options = mockFetch.mock.calls[0]?.[1] as
      { readonly dispatcher?: unknown } | undefined;
    expect(options?.dispatcher).toBeInstanceOf(mockProxyAgent);
  });

  test("does not construct a ProxyAgent or set a dispatcher when proxyUrl is unset", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    await client.get("/ping");

    expect(mockProxyAgent).not.toHaveBeenCalled();
    const options = mockFetch.mock.calls[0]?.[1] as
      { readonly dispatcher?: unknown } | undefined;
    expect(options?.dispatcher).toBeUndefined();
  });

  test("constructs exactly one ProxyAgent per client and reuses it across requests (no per-request leak)", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      proxyUrl: "http://127.0.0.1:8888",
    });

    await client.get("/first");
    await client.get("/second");

    expect(mockProxyAgent).toHaveBeenCalledTimes(1);
    expect(mockProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:8888");

    const firstOptions = mockFetch.mock.calls[0]?.[1] as
      { readonly dispatcher?: unknown } | undefined;
    const secondOptions = mockFetch.mock.calls[1]?.[1] as
      { readonly dispatcher?: unknown } | undefined;
    expect(firstOptions?.dispatcher).toBeDefined();
    expect(secondOptions?.dispatcher).toBe(firstOptions?.dispatcher);
  });
});

// ---------------------------------------------------------------------------
// 11 — debug logging
// ---------------------------------------------------------------------------
describe("M3LHttpClient — debug logging", () => {
  test("debug: true writes structured lines to console.debug", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      debug: true,
    });

    await client.get("/ping");

    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  test("console.debug is never called when debug is unset (never log by default)", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });

    await client.get("/ping");

    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  test("console.debug is never called when debug is explicitly false", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      makeResponse({ status: 200, contentType: "application/json", body: {} }),
    );
    const client = new M3LHttpClient({
      baseUrl: "https://api.example.com",
      debug: false,
    });

    await client.get("/ping");

    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Type-level tests
// ---------------------------------------------------------------------------
describe("M3LHttpClient — type-level contract", () => {
  test("M3LHttpClientOptions optional fields are T | undefined", () => {
    expectTypeOf<M3LHttpClientOptions["baseUrl"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LHttpClientOptions["defaultHeaders"]>().toEqualTypeOf<
      Record<string, string> | undefined
    >();
    expectTypeOf<M3LHttpClientOptions["timeout"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LHttpClientOptions["debug"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<M3LHttpClientOptions["proxyUrl"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("get<T> returns Promise<T> — generic response type flows through", () => {
    expectTypeOf<M3LHttpClient["get"]>().parameter(0).toEqualTypeOf<string>();

    const client: M3LHttpClient = new M3LHttpClient();
    expectTypeOf(client.get<{ id: string }>("/x")).toEqualTypeOf<
      Promise<{ id: string }>
    >();
  });

  test("getAbortable<T> returns the exported M3LHttpAbortableRequest<T> shape", () => {
    const client: M3LHttpClient = new M3LHttpClient();
    expectTypeOf(client.getAbortable<{ id: string }>("/x")).toEqualTypeOf<
      M3LHttpAbortableRequest<{ id: string }>
    >();
  });

  test("M3LHttpAbortableRequest<T> has readonly promise and abort fields", () => {
    expectTypeOf<M3LHttpAbortableRequest<{ id: string }>>().toEqualTypeOf<{
      readonly promise: Promise<{ id: string }>;
      readonly abort: () => void;
    }>();
  });

  test("M3LHttpFailureReason is the literal union of the four documented reasons", () => {
    expectTypeOf<M3LHttpFailureReason>().toEqualTypeOf<
      "status" | "network" | "timeout" | "abort"
    >();
  });

  test("the 'response' event handler parameter is M3LHttpResponseEvent", () => {
    const client: M3LHttpClient = new M3LHttpClient();
    const handler = (event: M3LHttpResponseEvent): void => {
      expectTypeOf(event).toEqualTypeOf<M3LHttpResponseEvent>();
    };
    client.on("response", handler);
  });

  test("M3LHttpRequestEvent.headers is a readonly header map", () => {
    expectTypeOf<M3LHttpRequestEvent["headers"]>().toEqualTypeOf<
      Readonly<Record<string, string>>
    >();
  });

  test("the event map ties each event name to its declared payload type", () => {
    expectTypeOf<M3LHttpClientEventMap>().toEqualTypeOf<{
      readonly request: M3LHttpRequestEvent;
      readonly response: M3LHttpResponseEvent;
      readonly error: M3LHttpErrorEvent;
    }>();
  });

  test("M3LHttpClientError.code is the literal 'ERR_HTTP_REQUEST', not widened to string", () => {
    expectTypeOf<
      M3LHttpClientError["code"]
    >().toEqualTypeOf<"ERR_HTTP_REQUEST">();
  });

  test("M3LHttpClientError.reason is a typed, always-present M3LHttpFailureReason — not unknown", () => {
    // toEqualTypeOf is strict identity: it only passes if `reason` is exactly
    // the four-member literal union, which by construction excludes `unknown`
    // (an `unknown`-typed field would fail this exact-equality check).
    expectTypeOf<
      M3LHttpClientError["reason"]
    >().toEqualTypeOf<M3LHttpFailureReason>();
  });

  test("M3LHttpFailure is the exact discriminated union — 'status' carries a status code, the other three arms carry none", () => {
    expectTypeOf<M3LHttpFailure>().toEqualTypeOf<
      | { readonly reason: "status"; readonly status: number }
      | { readonly reason: "network" | "timeout" | "abort" }
    >();
  });

  test("M3LHttpClientError.failure is typed as the exact M3LHttpFailure union", () => {
    expectTypeOf<
      M3LHttpClientError["failure"]
    >().toEqualTypeOf<M3LHttpFailure>();
  });

  test("accessing .status on the base M3LHttpFailure union is a compile error until narrowed", () => {
    // The base union must not expose `status` unconditionally, or an illegal
    // "timeout with a status" state becomes representable.
    expectTypeOf<M3LHttpFailure>().not.toHaveProperty("status");

    const assertNarrowing = (failure: M3LHttpFailure): void => {
      if (failure.reason === "status") {
        expectTypeOf(failure.status).toBeNumber();
      }
    };
    expectTypeOf(assertNarrowing).parameter(0).toEqualTypeOf<M3LHttpFailure>();
  });

  test("accessing .status on error.failure is a compile error until failure.reason === 'status' narrows it", () => {
    expectTypeOf<M3LHttpClientError["failure"]>().not.toHaveProperty("status");

    const assertNarrowing = (error: M3LHttpClientError): void => {
      if (error.failure.reason === "status") {
        expectTypeOf(error.failure.status).toBeNumber();
      }
    };
    expectTypeOf(assertNarrowing)
      .parameter(0)
      .toEqualTypeOf<M3LHttpClientError>();
  });

  test("switch (error.reason) narrows exhaustively over the four documented failure modes with no default needed", () => {
    const classify = (error: M3LHttpClientError): string => {
      switch (error.reason) {
        case "status":
          return "status";
        case "network":
          return "network";
        case "timeout":
          return "timeout";
        case "abort":
          return "abort";
      }
    };
    expectTypeOf(classify).parameter(0).toEqualTypeOf<M3LHttpClientError>();
    expectTypeOf(classify).returns.toEqualTypeOf<string>();
  });

  test("switch (error.failure.reason) narrows exhaustively over the discriminated failure payload with no default needed", () => {
    const classify = (error: M3LHttpClientError): string => {
      switch (error.failure.reason) {
        case "status":
          return `status:${String(error.failure.status)}`;
        case "network":
          return "network";
        case "timeout":
          return "timeout";
        case "abort":
          return "abort";
      }
    };
    expectTypeOf(classify).parameter(0).toEqualTypeOf<M3LHttpClientError>();
    expectTypeOf(classify).returns.toEqualTypeOf<string>();
  });
});
