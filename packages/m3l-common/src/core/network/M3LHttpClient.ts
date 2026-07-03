/**
 * `core/network/M3LHttpClient` — an event-emitting HTTP client wrapping
 * `undici`'s `fetch`, with automatic JSON parsing, per-request timeouts via
 * `AbortController`, typed failure normalization, and optional proxy
 * routing.
 *
 * @packageDocumentation
 */

import { fetch, ProxyAgent } from "undici";

import { M3LEventEmitterBase } from "../events/index.js";
import { M3LHttpClientError } from "./M3LHttpClientError.js";
import type { M3LHttpFailureReason } from "./M3LHttpClientError.js";

/** Matches a `Content-Type` header value that should be parsed as JSON. */
const JSON_CONTENT_TYPE_PATTERN = /[/+]json\b/i;

/** The per-request timeout applied when {@link M3LHttpClientOptions.timeout} is omitted. */
const DEFAULT_TIMEOUT_MS = 30_000;

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
}

/** Payload emitted on the `"request"` event, just before dispatch. */
export interface M3LHttpRequestEvent {
  /** The HTTP method used for the request (always `"GET"` for this client). */
  readonly method: string;
  /** The fully resolved request URL. */
  readonly url: string;
  /**
   * The merged headers sent with the request. This is a snapshot copy — the
   * client's own header object used for dispatch is private, so mutating this
   * value from a handler has no effect on the in-flight request.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/** Payload emitted on the `"response"` event, once a response is received. */
export interface M3LHttpResponseEvent {
  /** The HTTP method used for the request. */
  readonly method: string;
  /** The fully resolved request URL. */
  readonly url: string;
  /** The HTTP status code of the response. */
  readonly status: number;
  /** Whether the response status is in the 2xx range. */
  readonly ok: boolean;
  /** Wall-clock duration of the request, in milliseconds. */
  readonly durationMs: number;
}

/** Payload emitted on the `"error"` event, when a request fails. */
export interface M3LHttpErrorEvent {
  /** The HTTP method used for the request. */
  readonly method: string;
  /** The fully resolved request URL. */
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
 * The result of {@link M3LHttpClient.getAbortable}: an in-flight promise plus
 * a cancel handle.
 */
export interface M3LHttpAbortableRequest<T> {
  /** Resolves with the parsed response body, or rejects with {@link M3LHttpClientError}. */
  readonly promise: Promise<T>;
  /** Cancels the in-flight request; the promise then rejects with reason `"abort"`. */
  readonly abort: () => void;
}

/**
 * Event-emitting HTTP client over `undici`'s `fetch`. Supports only `GET`
 * requests, automatic JSON parsing of matching response bodies, a
 * per-request timeout enforced via `AbortController`, typed failure
 * normalization (status / network / timeout / abort), optional proxy
 * routing, and structured debug logging.
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

  /**
   * Creates a new `M3LHttpClient`.
   *
   * When `proxyUrl` is set, a single `ProxyAgent` is constructed here and
   * reused for every request made by this client instance — constructing a
   * new one per request would leak a socket pool on each call.
   *
   * @param options - Optional client configuration. `timeout` defaults to
   *   `30000` milliseconds when omitted.
   */
  constructor(options?: M3LHttpClientOptions) {
    super();
    this.#baseUrl = options?.baseUrl;
    this.#defaultHeaders = { ...options?.defaultHeaders };
    this.#timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#debug = options?.debug ?? false;
    this.#dispatcher =
      options?.proxyUrl === undefined
        ? undefined
        : new ProxyAgent(options.proxyUrl);
  }

  /**
   * Performs a `GET` request and resolves with the parsed response body.
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
    return this.#request<T>(path).promise;
  }

  /**
   * Performs a cancellable `GET` request.
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
    return this.#request<T>(path);
  }

  /**
   * Resolves `path` against `baseUrl` when configured; otherwise `path` is
   * treated as the full request URL.
   */
  #resolveUrl(path: string): string {
    return this.#baseUrl === undefined
      ? path
      : new URL(path, this.#baseUrl).toString();
  }

  /**
   * Core request implementation shared by {@link get} and
   * {@link getAbortable}. Owns the `AbortController` lifecycle (timeout +
   * manual abort), dispatch, response parsing, failure normalization, event
   * emission, and debug logging.
   */
  #request<T>(path: string): M3LHttpAbortableRequest<T> {
    const method = "GET";
    const url = this.#resolveUrl(path);
    const headers = { ...this.#defaultHeaders };
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

    const promise = this.#dispatch<T>({
      method,
      url,
      headers,
      controller,
      timer,
      getFailureReason: () => failureReason,
    });

    return { promise, abort };
  }

  /**
   * Dispatches the request via `undici`'s `fetch`, reads and normalizes the
   * response, and emits the lifecycle events. Always clears the timeout
   * timer via `finally`.
   */
  async #dispatch<T>(input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly controller: AbortController;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly getFailureReason: () => "timeout" | "abort" | undefined;
  }): Promise<T> {
    const { method, url, headers, controller, timer, getFailureReason } = input;

    this.emit("request", { method, url, headers: { ...headers } });

    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(this.#dispatcher !== undefined && { dispatcher: this.#dispatcher }),
      });

      const durationMs = Date.now() - startedAt;
      const { status, ok } = response;

      this.#logDebug({ method, url, status });
      this.emit("response", { method, url, status, ok, durationMs });

      if (!ok) {
        throw new M3LHttpClientError(
          `request to ${url} failed with status ${String(status)}`,
          {
            reason: "status",
            status,
            context: { url },
          },
        );
      }

      return await this.#readBody<T>(response);
    } catch (cause) {
      const error = this.#normalizeFailure({
        cause,
        method,
        url,
        reason: getFailureReason(),
      });
      this.#logDebug({ method, url, error: error.message });
      this.emit("error", { method, url, error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads the response body, parsing it as JSON when the content type matches. */
  async #readBody<T>(response: {
    readonly headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    text(): Promise<string>;
  }): Promise<T> {
    const contentType = response.headers.get("content-type");
    const isJson =
      contentType !== null && JSON_CONTENT_TYPE_PATTERN.test(contentType);
    const body = isJson ? await response.json() : await response.text();
    return body as T;
  }

  /**
   * Normalizes any failure raised during dispatch into a single
   * {@link M3LHttpClientError}. An already-typed error (the non-2xx branch)
   * passes through unchanged; every other failure is classified as
   * `"timeout"`, `"abort"`, or `"network"` and wrapped with `cause` set to
   * the original thrown value.
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

    const resolvedReason: M3LHttpFailureReason = reason ?? "network";
    return new M3LHttpClientError(
      `${method} ${url} failed: ${resolvedReason}`,
      {
        reason: resolvedReason,
        context: { url },
        cause,
      },
    );
  }

  /** Writes a structured debug line when `debug: true` was configured; otherwise a no-op. */
  #logDebug(payload: Record<string, unknown>): void {
    if (!this.#debug) return;
    console.debug(payload);
  }
}
