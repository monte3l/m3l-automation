/**
 * `core/network/M3LHttpClient` — an event-emitting HTTP client wrapping
 * `undici`'s `fetch`, with automatic JSON parsing, per-request timeouts via
 * `AbortController`, typed failure normalization, and optional proxy
 * routing.
 *
 * @packageDocumentation
 */

import { fetch, ProxyAgent } from "undici";

import { sanitizeRequestUrl } from "../../internal/network/sanitizeRequestUrl.js";
import { M3LError } from "../errors/index.js";
import { M3LEventEmitterBase } from "../events/index.js";
import { M3LHttpClientError } from "./M3LHttpClientError.js";

/** Matches a `Content-Type` header value that should be parsed as JSON. */
const JSON_CONTENT_TYPE_PATTERN = /[/+]json\b/i;

/** The per-request timeout applied when {@link M3LHttpClientOptions.timeout} is omitted. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Milliseconds per second, used to convert a `Retry-After` delta-seconds value. */
const MS_PER_SECOND = 1000;

/**
 * HTTP header names considered non-sensitive and safe to emit unredacted on
 * the `"request"` event. Every other header name — including one the shared
 * `redactSensitiveLogValue` denylist has never seen (`Cookie`, a
 * vendor-specific signature header) — is masked in full. An allowlist, not a
 * denylist: the credential-bearing header namespace is unbounded and
 * caller-controlled, so enumerating what's UNSAFE never converges (see the
 * "Allowlist, never denylist" rule in `.claude/rules/library-src.md`).
 * Matching is case-insensitive.
 */
const SAFE_REQUEST_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "host",
  "user-agent",
]);

/** Replacement literal for a header value masked on the `"request"` event. */
const REDACTED_HEADER_VALUE = "[REDACTED]";

/**
 * Builds the headers snapshot emitted on the `"request"` event: every header
 * NOT on {@link SAFE_REQUEST_HEADER_NAMES} (case-insensitive) is replaced
 * with {@link REDACTED_HEADER_VALUE} in full. The real headers object used
 * for the outgoing `fetch()` dispatch is never touched by this function —
 * only the event's own snapshot copy.
 */
function redactRequestHeadersForEvent(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SAFE_REQUEST_HEADER_NAMES.has(key.toLowerCase())
      ? value
      : REDACTED_HEADER_VALUE;
  }
  return result;
}

/**
 * Parses an HTTP `Retry-After` response header into a millisecond delay,
 * supporting both grammars RFC 9110 allows: delta-seconds (a non-negative
 * integer, e.g. `"120"`) and an HTTP-date (e.g.
 * `"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` for a missing,
 * empty, or unparseable header — never throws. A past HTTP-date resolves to
 * `0`, never a negative delay.
 */
function parseRetryAfterMs(
  headerValue: string | null,
  now: number,
): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === "") return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * MS_PER_SECOND;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - now);
}

/**
 * Validates a caller-supplied {@link M3LHttpClientOptions.maxResponseBytes}:
 * `undefined` (omitted) passes silently, anything else must be a positive
 * integer or this throws {@link M3LError} (`code: "ERR_INVALID_ARGUMENT"`).
 * Extracted so the constructor itself stays under the complexity budget.
 */
function validateMaxResponseBytes(maxResponseBytes: number | undefined): void {
  if (maxResponseBytes === undefined) return;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new M3LError(
      `M3LHttpClient: maxResponseBytes must be a positive integer, got ${String(maxResponseBytes)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
}

/**
 * Builds the `ProxyAgent` dispatcher for a new {@link M3LHttpClient}, or
 * `undefined` when no `proxyUrl` was configured. Extracted so the
 * constructor itself stays under the complexity budget.
 */
function createDispatcher(
  proxyUrl: string | undefined,
): ProxyAgent | undefined {
  return proxyUrl === undefined ? undefined : new ProxyAgent(proxyUrl);
}

/**
 * Constructor configuration for {@link M3LHttpClient}.
 *
 * @example
 * ```ts
 * import type { M3LHttpClientOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LHttpClientOptions = {
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { accept: "application/json" },
 *   timeout: 10_000,
 * };
 * ```
 */
export interface M3LHttpClientOptions {
  /** Base URL prepended to request paths via `new URL(path, baseUrl)`. */
  readonly baseUrl?: string;
  /** Headers merged into every outgoing request. */
  readonly defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds, enforced via `AbortController`. Defaults to `30000`. */
  readonly timeout?: number;
  /** When `true`, writes structured request/response/error lines to `console.debug`. */
  readonly debug?: boolean;
  /** When set, routes every request through an `undici` `ProxyAgent` targeting this URL. */
  readonly proxyUrl?: string;
  /**
   * Optional cap, in bytes, on a response body's total size before
   * `request()`/`get()` buffer it for JSON/text parsing. Enforced by
   * counting bytes as the body stream is read; once the running total
   * exceeds this cap, the read is aborted and the request rejects with
   * {@link M3LHttpClientError} (`failure.reason === "network"`) instead of
   * continuing to buffer an unbounded body into memory. Omitted (the
   * default) is unbounded, matching every prior release's behavior — a
   * future major may flip this default to a finite cap. Does not apply to
   * {@link M3LHttpClient.requestStream}, which never buffers a body.
   */
  readonly maxResponseBytes?: number;
}

/**
 * The HTTP methods {@link M3LHttpClient.request} and
 * {@link M3LHttpClient.requestAbortable} accept.
 */
export type M3LHttpMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/**
 * Options for {@link M3LHttpClient.request} and
 * {@link M3LHttpClient.requestAbortable}.
 *
 * @example
 * ```ts
 * import type { M3LHttpRequestOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LHttpRequestOptions = {
 *   method: "POST",
 *   path: "/users",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ name: "Ada" }),
 *   expectedStatus: 201,
 * };
 * ```
 */
export interface M3LHttpRequestOptions {
  /** The HTTP verb to dispatch. */
  readonly method: M3LHttpMethod;
  /** The request path or full URL. Resolved against `baseUrl` exactly like `get()`. */
  readonly path: string;
  /**
   * Per-request headers, shallow-merged over `defaultHeaders`
   * (`{ ...defaultHeaders, ...headers }`); on an identical key the
   * per-request value wins.
   */
  readonly headers?: Record<string, string>;
  /**
   * Request body passed straight to `undici`'s `fetch` — not serialized, and
   * no `Content-Type` is inferred. Omit for `GET`/`HEAD`.
   */
  readonly body?: string | Uint8Array;
  /**
   * Accepted response status(es). Omitted means any 2xx is success
   * (identical to `get()`'s current behavior). A single `number` requires an
   * exact match; a non-empty `readonly number[]` accepts any listed status.
   * Anything else throws {@link M3LHttpClientError} with
   * `failure.reason === "status"`.
   */
  readonly expectedStatus?: number | readonly [number, ...number[]];
}

/** Payload emitted on the `"request"` event, just before dispatch. */
export interface M3LHttpRequestEvent {
  /** The HTTP method used for the request. */
  readonly method: string;
  /**
   * The fully resolved request URL. Unlike `headers` on this same event,
   * this is NOT sanitized — it can carry a query string, fragment, or other
   * caller-supplied content unchanged. Prefer `M3LHttpClientError.context.url`
   * (sanitized) when logging a failed request's URL.
   */
  readonly url: string;
  /**
   * The merged headers sent with the request. This is a snapshot copy — the
   * client's own header object used for dispatch is private, so mutating this
   * value from a handler has no effect on the in-flight request. Redaction
   * here is allowlist-based, not a denylist of recognized sensitive field
   * names: only header names on a small known-safe set (e.g. `accept`,
   * `content-type`, `user-agent`) pass through unchanged; every other header
   * name — including one this library has never seen before, such as
   * `Cookie` or a vendor-specific signature header — is replaced with
   * `"[REDACTED]"` in full. This trades some observability completeness
   * (a genuinely non-sensitive but unlisted header is masked too) for
   * guaranteed safety against the unbounded, caller-controlled header
   * namespace. The real outgoing `fetch` request still carries the
   * unredacted values.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/** Payload emitted on the `"response"` event, once a response is received. */
export interface M3LHttpResponseEvent {
  /** The HTTP method used for the request. */
  readonly method: string;
  /**
   * The fully resolved request URL. This is NOT sanitized — it can carry a
   * query string, fragment, or other caller-supplied content unchanged.
   * Prefer `M3LHttpClientError.context.url` (sanitized) when logging a
   * failed request's URL.
   */
  readonly url: string;
  /** The HTTP status code of the response. */
  readonly status: number;
  /**
   * Whether the response status is in the 2xx range. Independent of
   * `expectedStatus` — a 2xx response still reports `ok: true` even when a
   * narrower `expectedStatus` causes the request to reject.
   */
  readonly ok: boolean;
  /** Wall-clock duration of the request, in milliseconds. */
  readonly durationMs: number;
}

/** Payload emitted on the `"error"` event, when a request fails. */
export interface M3LHttpErrorEvent {
  /** The HTTP method used for the request. */
  readonly method: string;
  /**
   * The fully resolved request URL. This is NOT sanitized — it can carry a
   * query string, fragment, or other caller-supplied content unchanged.
   * Prefer `M3LHttpClientError.context.url` (sanitized) when logging a
   * failed request's URL.
   */
  readonly url: string;
  /** The normalized error describing the failure. */
  readonly error: M3LHttpClientError;
}

/**
 * Maps each event name {@link M3LHttpClient} emits to its payload type.
 *
 * @example
 * ```ts
 * import type { M3LHttpClientEventMap } from "@m3l-automation/m3l-common/core";
 *
 * declare const handler: (event: M3LHttpClientEventMap["response"]) => void;
 * ```
 */
export interface M3LHttpClientEventMap {
  readonly request: M3LHttpRequestEvent;
  readonly response: M3LHttpResponseEvent;
  readonly error: M3LHttpErrorEvent;
}

/**
 * The result of {@link M3LHttpClient.getAbortable} and
 * {@link M3LHttpClient.requestAbortable}: an in-flight promise plus a cancel
 * handle.
 */
export interface M3LHttpAbortableRequest<T> {
  /** Resolves with the parsed response body, or rejects with {@link M3LHttpClientError}. */
  readonly promise: Promise<T>;
  /** Cancels the in-flight request; the promise then rejects with reason `"abort"`. */
  readonly abort: () => void;
}

/**
 * Event-emitting HTTP client over `undici`'s `fetch`. Offers `GET`
 * convenience methods plus a general `request()`/`requestAbortable()` pair
 * for any {@link M3LHttpMethod}, automatic JSON parsing of matching response
 * bodies, a per-request timeout enforced via `AbortController`, typed
 * failure normalization (status / network / timeout / abort), optional
 * proxy routing, and structured debug logging.
 *
 * @example
 * ```ts
 * import { M3LHttpClient, M3LHttpClientError } from "@m3l-automation/m3l-common/core";
 *
 * const client = new M3LHttpClient({
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { accept: "application/json" },
 *   timeout: 10_000,
 * });
 *
 * client.on("response", (event) => {
 *   console.log(`${event.method} ${event.url} -> ${event.status}`);
 * });
 *
 * try {
 *   const data = await client.get<{ id: string; name: string }>("/users/42");
 *   console.log(data.name);
 * } catch (error) {
 *   if (error instanceof M3LHttpClientError) {
 *     console.error(`request failed: ${error.message}`);
 *   }
 *   throw error;
 * }
 * ```
 */
export class M3LHttpClient extends M3LEventEmitterBase<M3LHttpClientEventMap> {
  readonly #baseUrl: string | undefined;
  readonly #defaultHeaders: Record<string, string>;
  readonly #timeout: number;
  readonly #debug: boolean;
  readonly #dispatcher: ProxyAgent | undefined;
  readonly #maxResponseBytes: number | undefined;

  /**
   * Creates a new `M3LHttpClient`.
   *
   * When `proxyUrl` is set, a single `ProxyAgent` is constructed here and
   * reused for every request made by this client instance — constructing a
   * new one per request would leak a socket pool on each call.
   *
   * @param options - Optional client configuration. `timeout` defaults to
   *   `30000` milliseconds when omitted.
   * @throws {@link M3LError} (`code: "ERR_INVALID_ARGUMENT"`) synchronously
   *   when `maxResponseBytes` is supplied but is not a positive integer.
   */
  constructor(options?: M3LHttpClientOptions) {
    super();
    this.#baseUrl = options?.baseUrl;
    this.#defaultHeaders = { ...options?.defaultHeaders };
    this.#timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#debug = options?.debug ?? false;
    this.#dispatcher = createDispatcher(options?.proxyUrl);
    validateMaxResponseBytes(options?.maxResponseBytes);
    this.#maxResponseBytes = options?.maxResponseBytes;
  }

  /**
   * Performs a `GET` request and resolves with the parsed response body.
   * Equivalent to `request({ method: "GET", path })`.
   *
   * JSON responses (detected via `Content-Type`) are parsed automatically;
   * any other content type resolves to the raw response text.
   *
   * @typeParam T - The caller-asserted shape of the response body. This is
   *   not validated at runtime — the parsed body is returned as `T` without
   *   a runtime check.
   * @param path - The request path or full URL. Resolved against `baseUrl`
   *   when configured.
   * @returns A promise resolving to the parsed response body.
   * @throws {@link M3LHttpClientError} on a non-2xx response, a network
   *   failure, or a timeout.
   */
  get<T>(path: string): Promise<T> {
    return this.request<T>({ method: "GET", path });
  }

  /**
   * Performs a cancellable `GET` request. Equivalent to
   * `requestAbortable({ method: "GET", path })`.
   *
   * @typeParam T - The caller-asserted shape of the response body. This is
   *   not validated at runtime — the parsed body is returned as `T` without
   *   a runtime check.
   * @param path - The request path or full URL. Resolved against `baseUrl`
   *   when configured.
   * @returns An object containing the in-flight `promise` and an `abort()`
   *   handle. Calling `abort()` rejects `promise` with
   *   {@link M3LHttpClientError} carrying `error.reason === "abort"`.
   */
  getAbortable<T>(path: string): M3LHttpAbortableRequest<T> {
    return this.requestAbortable<T>({ method: "GET", path });
  }

  /**
   * Performs a request for any {@link M3LHttpMethod} and resolves with the
   * parsed response body.
   *
   * The client is transport-only: `options.body` is passed straight to
   * `undici` with no serialization and no inferred `Content-Type`.
   *
   * @typeParam T - The caller-asserted shape of the response body. This is
   *   not validated at runtime — the parsed body is returned as `T` without
   *   a runtime check.
   * @param options - The request options: `method` and `path` are required;
   *   `headers`, `body`, and `expectedStatus` are optional.
   * @returns A promise resolving to the parsed response body.
   * @throws {@link M3LHttpClientError} when the response status is not
   *   accepted (per `expectedStatus`, or any 2xx when omitted), on a
   *   network failure, or on a timeout.
   * @example
   * ```ts
   * import { M3LHttpClient } from "@m3l-automation/m3l-common/core";
   *
   * const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
   *
   * const created = await client.request<{ id: string }>({
   *   method: "POST",
   *   path: "/users",
   *   headers: { "content-type": "application/json" },
   *   body: JSON.stringify({ name: "Ada" }),
   *   expectedStatus: 201,
   * });
   * console.log(created.id);
   * ```
   */
  request<T>(options: M3LHttpRequestOptions): Promise<T> {
    return this.#dispatchRequest<T>(options).promise;
  }

  /**
   * Performs a cancellable request for any {@link M3LHttpMethod}.
   *
   * @typeParam T - The caller-asserted shape of the response body. This is
   *   not validated at runtime — the parsed body is returned as `T` without
   *   a runtime check.
   * @param options - The request options: `method` and `path` are required;
   *   `headers`, `body`, and `expectedStatus` are optional.
   * @returns An object containing the in-flight `promise` and an `abort()`
   *   handle. Calling `abort()` rejects `promise` with
   *   {@link M3LHttpClientError} carrying `error.reason === "abort"`.
   */
  requestAbortable<T>(
    options: M3LHttpRequestOptions,
  ): M3LHttpAbortableRequest<T> {
    return this.#dispatchRequest<T>(options);
  }

  /**
   * Performs a request for any {@link M3LHttpMethod} and resolves with the
   * RAW, unbuffered response — status plus the web `ReadableStream<Uint8Array>`
   * body — instead of a parsed body. Intended for callers that need to pipe a
   * response directly to another destination (e.g. a file) without buffering
   * it in memory first, such as {@link M3LFileDownloader}.
   *
   * Shares the same URL resolution, header merging, timeout/abort handling,
   * proxy dispatcher forwarding, status-acceptance, and failure-normalization
   * logic as {@link request} — the only difference is what happens with an
   * accepted response: this method skips body parsing entirely and resolves
   * with the stream itself. Always accepts any 2xx status (there is no
   * `expectedStatus` option here, matching `get()`'s default behavior).
   *
   * @param options - `method` and `path` are required; `headers` is optional
   *   and shallow-merges over `defaultHeaders` exactly like {@link request}.
   * @returns A promise resolving to `{ status, body }`, where `body` is the
   *   response's raw byte stream.
   * @throws {@link M3LHttpClientError} on a non-2xx response, a network
   *   failure, a timeout, or a 2xx response with no body at all.
   * @example
   * ```ts
   * import { M3LHttpClient } from "@m3l-automation/m3l-common/core";
   * import { createWriteStream } from "node:fs";
   * import { Readable } from "node:stream";
   * import { pipeline } from "node:stream/promises";
   *
   * const client = new M3LHttpClient();
   * const { body } = await client.requestStream({
   *   method: "GET",
   *   path: "https://example.com/large-file.bin",
   * });
   * await pipeline(Readable.fromWeb(body), createWriteStream("./out.bin"));
   * ```
   */
  requestStream(options: {
    readonly method: M3LHttpMethod;
    readonly path: string;
    readonly headers?: Record<string, string>;
  }): Promise<{
    readonly status: number;
    readonly body: ReadableStream<Uint8Array>;
  }> {
    const { method, path, headers: requestHeaders } = options;

    let url: string;
    try {
      url = this.#resolveUrl(path);
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cause is always the M3LHttpClientError thrown by #resolveUrl (an Error subclass); TS narrows a catch binding to unknown regardless
      return Promise.reject(cause);
    }

    const headers = { ...this.#defaultHeaders, ...requestHeaders };
    const { controller, timer, getFailureReason } =
      this.#createRequestContext();

    return this.#performRequest(
      {
        method,
        url,
        headers,
        body: undefined,
        expectedStatus: undefined,
        controller,
        timer,
        getFailureReason,
      },
      (response, timer) =>
        this.#readStreamBody(url, response, timer, (cause) =>
          this.#normalizeFailure({
            cause,
            method,
            url,
            reason: getFailureReason(),
          }),
        ),
    );
  }

  /**
   * Resolves `path` against `baseUrl` when configured; otherwise `path` is
   * treated as the full request URL. Validates eagerly via `URL` in both
   * branches so an invalid `path`/`baseUrl` combination fails right here,
   * synchronously, instead of reaching `fetch()` as an unvalidated string —
   * a native `fetch()` failure on a malformed URL embeds the raw,
   * unsanitized input in its own `TypeError.message`, which would leak a
   * credential (query string or fragment) through `cause` even though this
   * module's other sanitization strips it from the error's own
   * `message`/`context`.
   *
   * Also rejects, upfront, any successfully-parsed URL that carries userinfo
   * (`user:pass@host`): a real `fetch()`/`Request` unconditionally throws
   * for a credentialed URL, and that raw error embeds the full credential in
   * its own message, so such a URL is never actually usable and is refused
   * here instead of dispatched.
   */
  #resolveUrl(path: string): string {
    let parsed: URL;
    try {
      parsed =
        this.#baseUrl === undefined
          ? new URL(path)
          : new URL(path, this.#baseUrl);
    } catch {
      // The input could not be parsed as a URL at all — there is no reliable
      // way to sanitize an arbitrary malformed string (regex-based stripping
      // assumes structure that provably isn't there), so no `context.url` is
      // included rather than risk echoing unsanitized fragments of it.
      // `context.source` instead names WHICH input to check — the caller's
      // `path`, or this client's own configured `baseUrl` — without echoing
      // any part of either string.
      throw new M3LHttpClientError("invalid request URL", {
        failure: { reason: "network" },
        context: {
          source: this.#baseUrl === undefined ? "path" : "path-or-baseUrl",
        },
      });
    }
    if (parsed.username !== "" || parsed.password !== "") {
      // A userinfo-bearing URL (`https://user:pass@host/`) is rejected here,
      // before dispatch: undici's own `fetch()` unconditionally throws for
      // any credentialed URL, and that raw error embeds the full credential
      // in its own message — chaining it as `cause` would leak exactly what
      // this module's sanitization exists to prevent. Since such a URL was
      // never actually usable against a real `fetch()` anyway, reject it
      // cleanly and immediately instead of silently stripping and attempting
      // a request that would fail regardless. `context.host` is a separate
      // accessor from `.username`/`.password` on a `URL` and structurally
      // cannot contain the credential, so it is safe to surface here.
      throw new M3LHttpClientError(
        "request URL must not embed credentials (userinfo) — pass them via the headers option instead",
        { failure: { reason: "network" }, context: { host: parsed.host } },
      );
    }
    return parsed.toString();
  }

  /**
   * Determines whether a response `status` should be treated as a success.
   * Omitted `expectedStatus` preserves the historical behavior (any 2xx);
   * a single number requires an exact match; an array is membership-based.
   */
  #isAccepted(
    status: number,
    ok: boolean,
    expectedStatus: number | readonly number[] | undefined,
  ): boolean {
    if (expectedStatus === undefined) return ok;
    if (typeof expectedStatus === "number") return status === expectedStatus;
    return expectedStatus.includes(status);
  }

  /**
   * Creates a fresh `AbortController` plus its timeout timer and a matching
   * `abort()` handle, shared by every request-issuing method (`#dispatchRequest`,
   * {@link requestStream}). Only one of the timer or a manual `abort()` call
   * ever fires per request; whichever fires first records its reason in the
   * returned `getFailureReason` closure so `#normalizeFailure` can classify
   * the resulting `AbortError` correctly.
   */
  #createRequestContext(): {
    readonly controller: AbortController;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly getFailureReason: () => "timeout" | "abort" | undefined;
    readonly abort: () => void;
  } {
    const controller = new AbortController();
    let failureReason: "timeout" | "abort" | undefined;

    const timer = setTimeout(() => {
      failureReason = "timeout";
      controller.abort(new DOMException("request timed out", "AbortError"));
    }, this.#timeout);

    const abort = (): void => {
      failureReason = "abort";
      controller.abort(new DOMException("request aborted", "AbortError"));
    };

    return { controller, timer, getFailureReason: () => failureReason, abort };
  }

  /**
   * Core request engine shared by {@link get}, {@link getAbortable},
   * {@link request}, and {@link requestAbortable}. Owns header merging,
   * dispatch, failure normalization, event emission, and debug logging on
   * top of the `AbortController` lifecycle from `#createRequestContext`.
   */
  #dispatchRequest<T>(
    options: M3LHttpRequestOptions,
  ): M3LHttpAbortableRequest<T> {
    const {
      method,
      path,
      headers: requestHeaders,
      body,
      expectedStatus,
    } = options;

    let url: string;
    try {
      url = this.#resolveUrl(path);
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cause is always the M3LHttpClientError thrown by #resolveUrl (an Error subclass); TS narrows a catch binding to unknown regardless
      return { promise: Promise.reject(cause), abort: () => undefined };
    }

    const headers = { ...this.#defaultHeaders, ...requestHeaders };
    const { controller, timer, getFailureReason, abort } =
      this.#createRequestContext();

    const promise = this.#performRequest<T>(
      {
        method,
        url,
        headers,
        body,
        expectedStatus,
        controller,
        timer,
        getFailureReason,
      },
      (response, timer) => this.#readBody<T>(response, timer, url),
    );

    return { promise, abort };
  }

  /**
   * Fetches the response for `input`, then applies status-acceptance and
   * emits the `"response"` event/debug log. Throws {@link M3LHttpClientError}
   * (`failure.reason === "status"`) when the response is not accepted.
   * Extracted from `#performRequest` so both it and the failure-normalization
   * `catch` around it stay small and single-purpose.
   */
  async #fetchAccepted(input: {
    readonly method: M3LHttpMethod;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string | Uint8Array | undefined;
    readonly expectedStatus: number | readonly number[] | undefined;
    readonly controller: AbortController;
  }): Promise<Awaited<ReturnType<typeof fetch>>> {
    const { method, url, headers, body, expectedStatus, controller } = input;
    const startedAt = Date.now();

    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined && { body }),
      signal: controller.signal,
      ...(this.#dispatcher !== undefined && { dispatcher: this.#dispatcher }),
    });

    const durationMs = Date.now() - startedAt;
    const { status, ok } = response;

    this.#logDebug({ method, url, status });
    this.emit("response", { method, url, status, ok, durationMs });

    if (!this.#isAccepted(status, ok, expectedStatus)) {
      const safeUrl = sanitizeRequestUrl(url);
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
        Date.now(),
      );
      throw new M3LHttpClientError(
        `request to ${safeUrl} failed with status ${String(status)}`,
        {
          failure: { reason: "status", status },
          context: { url: safeUrl },
          ...(retryAfterMs !== undefined && { retryAfterMs }),
        },
      );
    }

    return response;
  }

  /**
   * Dispatches the request via `#fetchAccepted` and applies failure
   * normalization and the `"request"`/`"error"` lifecycle events — shared by
   * every public request method, including {@link requestStream}.
   *
   * Timer-clearing is NOT owned centrally here: only `readOutput` itself
   * knows when it is genuinely done with the response. For the parsed-body
   * path (`#readBody`), that is the instant the full body has been read; for
   * the stream path (`#readStreamBody`), `readOutput` returns as soon as
   * headers are accepted, so its own wrapped stream clears the timer only
   * once consumption finishes. Either way, a fetch failure or a `readOutput`
   * throw/rejection is caught here and clears the timer unconditionally, so
   * it never fires late or leaks.
   */
  async #performRequest<TOut>(
    input: {
      readonly method: M3LHttpMethod;
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly body: string | Uint8Array | undefined;
      readonly expectedStatus: number | readonly number[] | undefined;
      readonly controller: AbortController;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly getFailureReason: () => "timeout" | "abort" | undefined;
    },
    readOutput: (
      response: Awaited<ReturnType<typeof fetch>>,
      timer: ReturnType<typeof setTimeout>,
    ) => TOut | Promise<TOut>,
  ): Promise<TOut> {
    const { method, url, headers, timer, getFailureReason } = input;

    this.emit("request", {
      method,
      url,
      headers: redactRequestHeadersForEvent(headers),
    });

    try {
      const response = await this.#fetchAccepted(input);
      return await readOutput(response, timer);
    } catch (cause) {
      clearTimeout(timer);
      const error = this.#normalizeFailure({
        cause,
        method,
        url,
        reason: getFailureReason(),
      });
      this.#logDebug({ method, url, error: error.message });
      this.emit("error", { method, url, error });
      throw error;
    }
  }

  /**
   * Reads the response body, parsing it as JSON when the content type
   * matches. Clears `timer` only once the FULL body has been read — the
   * `#performRequest` catch already covers this method's failure path (e.g.
   * a `json()` parse error).
   *
   * When `#maxResponseBytes` is configured, the body is read via
   * `#readBoundedText` instead of `response.json()`/`.text()` directly, so an
   * oversized body aborts mid-read rather than buffering unbounded content in
   * memory; the unbounded default path is unchanged.
   */
  async #readBody<T>(
    response: {
      readonly headers: { get(name: string): string | null };
      readonly body: ReadableStream<Uint8Array> | null;
      json(): Promise<unknown>;
      text(): Promise<string>;
    },
    timer: ReturnType<typeof setTimeout>,
    url: string,
  ): Promise<T> {
    const contentType = response.headers.get("content-type");
    const isJson =
      contentType !== null && JSON_CONTENT_TYPE_PATTERN.test(contentType);

    let body: unknown;
    const maxBytes = this.#maxResponseBytes;
    if (maxBytes === undefined) {
      body = isJson ? await response.json() : await response.text();
    } else {
      const text = await this.#readBoundedText(response, url, maxBytes);
      body = isJson ? JSON.parse(text) : text;
    }

    clearTimeout(timer);
    return body as T;
  }

  /**
   * Reads `response`'s body stream into a UTF-8 string, aborting the read
   * the moment the accumulated byte count exceeds `maxBytes` rather than
   * buffering an unbounded body into memory. Only invoked when
   * `#maxResponseBytes` is configured; the unbounded default path reads via
   * `response.json()`/`.text()` directly.
   */
  async #readBoundedText(
    response: { readonly body: ReadableStream<Uint8Array> | null },
    url: string,
    maxBytes: number,
  ): Promise<string> {
    if (response.body === null) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const safeUrl = sanitizeRequestUrl(url);
        throw new M3LHttpClientError(
          `response from ${safeUrl} exceeded the configured ${String(maxBytes)}-byte limit`,
          {
            failure: { reason: "network" },
            context: { url: safeUrl, maxResponseBytes: maxBytes },
          },
        );
      }
      chunks.push(value);
    }

    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  /**
   * Extracts `{ status, body }` from an accepted response for
   * {@link requestStream}, without buffering the body. The null-body branch
   * throws directly (unaffected by `timer` — `#performRequest`'s catch
   * clears it); the success branch wraps the stream via
   * `#wrapStreamWithTimeoutCleanup` so `timer` stays live for the entire
   * transfer instead of clearing the instant headers are accepted.
   * `normalizeStreamError` classifies a later read failure (e.g. the abort
   * raised when `timer` fires mid-transfer) into a typed
   * {@link M3LHttpClientError} the same way `#performRequest`'s own catch
   * would, so a caller consuming the stream after this method returns still
   * observes a correctly-classified `reason` (`"timeout"`, `"abort"`, or
   * `"network"`) instead of the raw underlying stream error.
   */
  #readStreamBody(
    url: string,
    response: {
      readonly status: number;
      readonly body: ReadableStream<Uint8Array> | null;
    },
    timer: ReturnType<typeof setTimeout>,
    normalizeStreamError: (cause: unknown) => M3LHttpClientError,
  ): { readonly status: number; readonly body: ReadableStream<Uint8Array> } {
    if (response.body === null) {
      const safeUrl = sanitizeRequestUrl(url);
      throw new M3LHttpClientError(
        `request to ${safeUrl} succeeded but returned no response body`,
        { failure: { reason: "network" }, context: { url: safeUrl } },
      );
    }
    return {
      status: response.status,
      body: this.#wrapStreamWithTimeoutCleanup(
        response.body,
        timer,
        normalizeStreamError,
      ),
    };
  }

  /**
   * Wraps `source` so the request's timeout timer clears only once the
   * stream is fully consumed, errors, or is cancelled by the downstream
   * consumer — never immediately on return, unlike the parsed-body path.
   * Until then, the original timeout (and its `AbortController`) stays live
   * for the entire transfer: if it fires mid-stream, the underlying reader's
   * `read()` rejects with the resulting `AbortError`, which this wrapper
   * surfaces by erroring the returned stream with the result of
   * `normalizeStreamError` — a typed {@link M3LHttpClientError} instead of
   * the raw rejection — so a downstream consumer (e.g.
   * {@link M3LFileDownloader}) can re-throw it unchanged rather than wrap it
   * a second time.
   */
  #wrapStreamWithTimeoutCleanup(
    source: ReadableStream<Uint8Array>,
    timer: ReturnType<typeof setTimeout>,
    normalizeStreamError: (cause: unknown) => M3LHttpClientError,
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let cleared = false;
    const clearOnce = (): void => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearOnce();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          clearOnce();
          controller.error(normalizeStreamError(error));
        }
      },
      cancel(reason): Promise<void> {
        clearOnce();
        return reader.cancel(reason);
      },
    });
  }

  /**
   * Normalizes any failure raised during dispatch into a single
   * {@link M3LHttpClientError}. An already-typed error (the unaccepted
   * status branch) passes through unchanged; every other failure is
   * classified as `"timeout"`, `"abort"`, or `"network"` and wrapped with
   * `cause` set to the original thrown value.
   */
  #normalizeFailure(input: {
    readonly cause: unknown;
    readonly method: string;
    readonly url: string;
    readonly reason: "timeout" | "abort" | undefined;
  }): M3LHttpClientError {
    const { cause, method, url, reason } = input;

    if (cause instanceof M3LHttpClientError) {
      return cause;
    }

    const resolvedReason: "network" | "timeout" | "abort" = reason ?? "network";
    const safeUrl = sanitizeRequestUrl(url);
    return new M3LHttpClientError(
      `${method} ${safeUrl} failed: ${resolvedReason}`,
      {
        failure: { reason: resolvedReason },
        context: { url: safeUrl },
        cause,
      },
    );
  }

  /** Writes a structured debug line when `debug: true` was configured; otherwise a no-op. */
  #logDebug(payload: Record<string, unknown>): void {
    if (!this.#debug) return;
    // eslint-disable-next-line no-console -- opt-in debug: true diagnostic path, not default logging; the "no logging by default" guarantee holds because this is gated on caller-supplied debug: true
    console.debug(payload);
  }
}
