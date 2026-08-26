/**
 * `http/context` — builds and evolves the per-request {@link M3LRequestContext}.
 *
 * A request's correlation id flows straight into a log line and a response
 * header, so an inbound `x-correlation-id` is only ever reused when it is
 * safe to echo; anything else is a log-injection / header-splitting vector
 * and gets replaced with a freshly minted id (ADR-0066, ADR-0071).
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";

import type { M3LOperatorProfile } from "../auth/identity.js";
import { M3LConsoleError } from "../errors/console-error.js";

/** The request header a caller may supply a correlation id under. */
export const CORRELATION_ID_HEADER: string = "x-correlation-id";

/** The longest inbound correlation id this module will echo back. */
const MAX_CORRELATION_ID_LENGTH = 128;

/** The only characters an echoed correlation id may contain. */
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The base against which a path-only `req.url` is resolved into a `URL`. */
const URL_PARSE_BASE = "http://localhost";

/**
 * Returns `true` when `value` is safe to echo back verbatim in a log line
 * and a response header: non-empty, at most {@link MAX_CORRELATION_ID_LENGTH}
 * characters, and composed only of `[A-Za-z0-9._-]`. Anything else — an
 * empty string, an overlong value, embedded whitespace, or control
 * characters such as CRLF — is a log-injection / header-splitting vector
 * and must never be echoed.
 */
function isSafeCorrelationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID_PATTERN.test(value)
  );
}

/**
 * Resolves the correlation id for a request: the inbound
 * {@link CORRELATION_ID_HEADER} value when it is safe to echo, otherwise a
 * freshly minted one via `newCorrelationId`.
 */
function resolveCorrelationId(
  headers: Readonly<Record<string, string | undefined>>,
  newCorrelationId: () => string,
): string {
  const inbound = headers[CORRELATION_ID_HEADER];
  if (inbound !== undefined && isSafeCorrelationId(inbound)) return inbound;
  return newCorrelationId();
}

/**
 * Parses `rawUrl` (a path-only `req.url`, per Node's `http` contract)
 * against {@link URL_PARSE_BASE}, surfacing a malformed value as an
 * {@link M3LConsoleError} rather than letting a raw `TypeError` escape.
 */
function parseRequestUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl, URL_PARSE_BASE);
  } catch (cause) {
    // Deliberately does not echo `rawUrl`: this message reaches the response
    // body via the error envelope, and the raw request target is untrusted
    // input on a surface a browser frontend shares an origin with.
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "malformed request url",
      { cause },
    );
  }
}

/**
 * Strips a single trailing slash from `pathname`, except when `pathname` is
 * exactly `"/"`.
 */
function normalizePath(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * The immutable, per-request state threaded through routing and every
 * middleware/handler. Never mutated in place — {@link withOperator} and
 * {@link withParams} each return a new frozen context.
 *
 * @example
 * ```ts
 * function describe(ctx: M3LRequestContext): string {
 *   return `${ctx.method} ${ctx.path} [${ctx.correlationId}]`;
 * }
 * ```
 */
export interface M3LRequestContext {
  /** The safe-to-echo correlation id for this request (see module docs). */
  readonly correlationId: string;
  /** The HTTP method, as received (not upper-cased). */
  readonly method: string;
  /** The request path, with a trailing slash stripped (except `"/"`). */
  readonly path: string;
  /** The parsed query string. */
  readonly query: URLSearchParams;
  /** Route parameters captured by the router; empty until {@link withParams} runs. */
  readonly params: Readonly<Record<string, string>>;
  /** The resolved operator, when one has been attached via {@link withOperator}. */
  readonly operator: M3LOperatorProfile | undefined;
  /** The cooperative-cancellation signal for this request (ADR-0049). */
  readonly signal: AbortSignal;
  /** The timestamp (`Date.now()`-shaped) this request was received at. */
  readonly receivedAt: number;
}

/**
 * Constructor options for {@link createRequestContext}.
 *
 * @example
 * ```ts
 * const input: CreateRequestContextInput = {
 *   method: "GET",
 *   url: "/api/v1/runs",
 *   headers: {},
 *   signal: new AbortController().signal,
 * };
 * ```
 */
export interface CreateRequestContextInput {
  /** The HTTP method, as received. */
  readonly method: string;
  /** The path-only request url (`req.url`), per Node's `http` contract. */
  readonly url: string;
  /** The inbound request headers. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The cooperative-cancellation signal for this request. */
  readonly signal: AbortSignal;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable correlation-id generator; defaults to `randomUUID` from `node:crypto`. */
  readonly newCorrelationId?: () => string;
}

/**
 * Builds the {@link M3LRequestContext} for one inbound request: resolves a
 * safe correlation id, parses `input.url` into `path` and `query`, and
 * defaults `params` to `{}` and `operator` to `undefined`.
 *
 * @param input - See {@link CreateRequestContextInput}.
 * @returns The resulting frozen {@link M3LRequestContext}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `input.url` cannot be parsed.
 *
 * @example
 * ```ts
 * const ctx = createRequestContext({
 *   method: "GET",
 *   url: "/api/v1/runs?limit=10",
 *   headers: {},
 *   signal: new AbortController().signal,
 * });
 * ```
 */
export function createRequestContext(
  input: CreateRequestContextInput,
): M3LRequestContext {
  const now = input.now ?? Date.now;
  const newCorrelationId = input.newCorrelationId ?? randomUUID;
  const correlationId = resolveCorrelationId(input.headers, newCorrelationId);
  const parsed = parseRequestUrl(input.url);

  return Object.freeze({
    correlationId,
    method: input.method,
    path: normalizePath(parsed.pathname),
    query: parsed.searchParams,
    params: {},
    operator: undefined,
    signal: input.signal,
    receivedAt: now(),
  });
}

/**
 * Returns a new frozen {@link M3LRequestContext} identical to `ctx` except
 * for `operator`. Does not mutate `ctx`.
 *
 * @param ctx - The context to derive from.
 * @param operator - The resolved operator profile to attach.
 * @returns The new context.
 *
 * @example
 * ```ts
 * const authenticated = withOperator(ctx, { name: "ada", email: undefined });
 * ```
 */
export function withOperator(
  ctx: M3LRequestContext,
  operator: M3LOperatorProfile,
): M3LRequestContext {
  return Object.freeze({ ...ctx, operator });
}

/**
 * Returns a new frozen {@link M3LRequestContext} identical to `ctx` except
 * for `params`. Does not mutate `ctx`.
 *
 * @param ctx - The context to derive from.
 * @param params - The route parameters captured by the router.
 * @returns The new context.
 *
 * @example
 * ```ts
 * const withRouteParams = withParams(ctx, { id: "42" });
 * ```
 */
export function withParams(
  ctx: M3LRequestContext,
  params: Readonly<Record<string, string>>,
): M3LRequestContext {
  return Object.freeze({ ...ctx, params });
}
