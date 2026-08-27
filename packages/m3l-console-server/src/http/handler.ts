/**
 * `http/handler` — builds the `node:http` request listener: the seam
 * between a raw socket-level request and the {@link M3LRequestContext} /
 * {@link M3LRouter} / {@link composeMiddleware} pipeline (ADR-0065,
 * ADR-0049).
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Core } from "@m3l-automation/m3l-common";

import { createRequestContext, withAccessMode, withParams } from "./context.js";
import type { M3LRequestContext } from "./context.js";
import { errorResponse, isFaultError } from "./envelope.js";
import { M3LConsoleError } from "../errors/console-error.js";
import { composeMiddleware } from "./middleware.js";
import type { M3LConsoleHandler, M3LConsoleMiddleware } from "./middleware.js";
import { writeResponse } from "./respond.js";
import type { M3LConsoleResponse } from "./respond.js";
import type { M3LRouteAuth, M3LRouteLookup, M3LRouter } from "./router.js";

/** The status below which a response is logged at `info`. */
const STATUS_CLIENT_ERROR_THRESHOLD = 400;
/** The status at and above which a response is logged at `error`. */
const STATUS_SERVER_ERROR_THRESHOLD = 500;
/** Logged in place of a request's path when it failed to parse — never the raw, unparsed target. */
const PATH_PLACEHOLDER_UNPARSED = "(unparsed)";

/**
 * Constructor options for {@link createConsoleRequestListener}.
 *
 * @example
 * ```ts
 * const options: CreateConsoleRequestListenerOptions = {
 *   router: createRouter([]),
 *   middlewares: [],
 *   preRouting: [],
 *   logger,
 *   signal: new AbortController().signal,
 * };
 * ```
 */
export interface CreateConsoleRequestListenerOptions {
  /** The compiled router dispatching each request. */
  readonly router: M3LRouter;
  /**
   * The middleware chain wrapping every matched route's handler. Runs only
   * once a route has matched, so `ctx.accessMode` is populated (the matched
   * route's {@link M3LRouteAuth}) and `ctx.params` are available. This is
   * where per-route policy belongs (e.g. auth) — it never sees an unmatched
   * request (a 404 or 405 never reaches it). See {@link preRouting} for the
   * chain that does.
   */
  readonly middlewares: readonly M3LConsoleMiddleware[];
  /**
   * A second middleware chain that runs around the WHOLE of dispatch,
   * before routing has resolved — including a request that ends up 404 or
   * 405. This is where a control that must not be bypassable by requesting
   * an unknown path belongs (e.g. an origin guard): a `middlewares` member
   * would never see that request at all. Its members always observe
   * `ctx.accessMode === undefined`, since routing has not run yet. Runs
   * outermost relative to {@link middlewares} — see
   * {@link createConsoleRequestListener}.
   */
  readonly preRouting: readonly M3LConsoleMiddleware[];
  /** The logger every request's single outcome line is written through. */
  readonly logger: Core.M3LLogger;
  /** The drain signal — aborts every in-flight request context (ADR-0049). */
  readonly signal: AbortSignal;
  /** Injectable correlation-id generator; defaults to `randomUUID`. */
  readonly newCorrelationId?: () => string;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The `node:http` request listener shape: synchronous from Node's point of
 * view, never a promise, and never a rejection escaping it.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 *
 * const listener: M3LConsoleRequestListener = (_req, res) => {
 *   res.end("ok");
 * };
 * createServer(listener);
 * ```
 */
export type M3LConsoleRequestListener = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` when `rawHeaders` carries more than one
 * `Host` field-line, per RFC 9110 §7.2 ("a server MUST respond with a 400...
 * status code to any request message that contains more than one Host
 * header field"). MEASURED on a real `node:http` server (Node v26.7.0):
 * `req.headers` collapses a duplicate `Host` down to the FIRST value, so a
 * request sending the loopback host first and an attacker host second was
 * served 200 — the second value was invisible to every downstream check,
 * including the origin guard. `rawHeaders` is the only place a duplicate is
 * still observable: it is the flat, alternating
 * `[name, value, name, value, ...]` list Node never collapses, so this steps
 * by 2. Matching is case-insensitive (`Host` and `host` name the same field)
 * and this is a malformed-framing check, not a content check — it rejects
 * even when both values happen to be loopback.
 *
 * `rawHeaders` is typed as always present on a real `IncomingMessage`, but
 * is accepted here as possibly `undefined` and treated as "nothing to
 * check" rather than thrown on: a real socket-backed request always
 * populates it, so an absent value only ever occurs in a lightweight test
 * double that never claimed to model wire-level duplicate framing in the
 * first place — this guard exists to catch a real duplicate, not to reject
 * a caller that has no rawHeaders to offer.
 */
/**
 * `rawHeaders` interleaves names and values as
 * `[name, value, name, value, ...]`, so scanning for field-line names steps
 * by two rather than iterating one entry at a time.
 */
const RAW_HEADER_STRIDE = 2;

function assertSingleHostHeader(
  rawHeaders: readonly string[] | undefined,
): void {
  if (rawHeaders === undefined) return;
  let hostFieldLines = 0;
  for (let index = 0; index < rawHeaders.length; index += RAW_HEADER_STRIDE) {
    if (rawHeaders[index]?.toLowerCase() === "host") hostFieldLines += 1;
  }
  if (hostFieldLines > 1) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request carries more than one Host header field-line",
    );
  }
}

/**
 * Coerces Node's header map to the plain string map `createRequestContext`
 * expects, first rejecting a duplicate `Host` field-line that `headers`
 * itself cannot represent (see {@link assertSingleHostHeader}).
 */
function toHeaderMap(
  headers: IncomingMessage["headers"],
  rawHeaders: readonly string[] | undefined,
): Readonly<Record<string, string | undefined>> {
  assertSingleHostHeader(rawHeaders);
  // `IncomingHttpHeaders` types every value as `string | string[] | undefined`
  // only to accommodate a handful of headers (`set-cookie`) that never occur
  // on an inbound server request; every header this package reads
  // (`x-correlation-id`) is always a single string in practice.
  return headers as unknown as Readonly<Record<string, string | undefined>>;
}

/** The three log levels a request outcome is ever recorded at. */
function logLevelForStatus(status: number): "error" | "warning" | "info" {
  if (status >= STATUS_SERVER_ERROR_THRESHOLD) return "error";
  if (status >= STATUS_CLIENT_ERROR_THRESHOLD) return "warning";
  return "info";
}

/** Fields logged for exactly one line per request — never headers, query, or body. */
interface RequestOutcome {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly correlationId: string;
  readonly accessMode: M3LRouteAuth | undefined;
}

/** Logs the single outcome line for a request, at the level its status implies. */
function logOutcome(logger: Core.M3LLogger, outcome: RequestOutcome): void {
  const message = `${outcome.method} ${outcome.path} -> ${String(outcome.status)}`;
  const data = {
    method: outcome.method,
    path: outcome.path,
    status: outcome.status,
    durationMs: outcome.durationMs,
    correlationId: outcome.correlationId,
    ...(outcome.accessMode !== undefined && { accessMode: outcome.accessMode }),
  };

  const level = logLevelForStatus(outcome.status);
  if (level === "error") {
    logger.error(message, data);
  } else if (level === "warning") {
    logger.warning(message, data);
  } else {
    logger.info(message, data);
  }
}

/** Context for {@link logDiagnosticIfFault} — never the query string, headers, or body. */
interface RequestFaultContext {
  readonly method: string;
  readonly path: string;
  readonly correlationId: string;
}

/**
 * Emits a diagnostic `ERROR` line via {@link Core.M3LLogger.errorFrom} for a
 * genuine fault — but never for a routine non-fault outcome (a bad request,
 * an unauthenticated/not-found/method-not-allowed lookup, or a drain
 * refusal) — so the real cause behind a handler/middleware throw is
 * recorded somewhere, even though only the fixed generic envelope message
 * ever reaches the caller (ADR-0070's display-vs-persist split; see
 * {@link isFaultError}). The gate is "is this a fault", not "is this
 * caller-origin": a drain refusal (`ERR_CONSOLE_UNAVAILABLE`) is
 * `origin: "library"` yet not a fault, so gating on origin alone would emit
 * a spurious error-level line for every request refused during an ordinary
 * shutdown. Gating on fault also keeps a caller from remotely steering log
 * severity by choosing which routine error to trigger. The message carries
 * only the correlation id, method, and normalized path — never the query
 * string, headers, or body.
 */
function logDiagnosticIfFault(
  logger: Core.M3LLogger,
  error: unknown,
  context: RequestFaultContext,
): void {
  if (!isFaultError(error)) return;
  logger.errorFrom(
    error,
    `unhandled failure handling ${context.method} ${context.path} (correlationId=${context.correlationId})`,
  );
}

/** Builds the response for a router lookup that did not reach a route handler. */
function responseForUnmatchedLookup(
  outcome: "not-found" | "method-not-allowed",
  allowed: readonly string[] | undefined,
  ctx: M3LRequestContext,
): M3LConsoleResponse {
  if (outcome === "not-found") {
    return errorResponse(
      new M3LConsoleError(
        "ERR_CONSOLE_NOT_FOUND",
        `no route matches ${ctx.method} ${ctx.path}`,
      ),
      ctx.correlationId,
    );
  }
  const response = errorResponse(
    new M3LConsoleError(
      "ERR_CONSOLE_METHOD_NOT_ALLOWED",
      `method ${ctx.method} is not allowed for ${ctx.path}`,
    ),
    ctx.correlationId,
  );
  return {
    ...response,
    headers: { ...response.headers, allow: (allowed ?? []).join(", ") },
  };
}

/**
 * Last-resort recovery when {@link writeResponse} itself throws (e.g. an
 * out-of-range status or a header value `res.writeHead` rejects): writes a
 * bare 500 and ends the socket so a request can never finish with an open
 * connection and no log line. Every step is individually best-effort —
 * `res` may already be in a state where even this fails — since the
 * overriding goal is for {@link runRequest} to reach its `logOutcome` call,
 * not for this recovery path itself to succeed.
 */
function writeFallbackResponse(res: ServerResponse): void {
  try {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(STATUS_SERVER_ERROR_THRESHOLD);
    }
  } catch {
    // best-effort: nothing more can be done if even the fallback header
    // write fails; still attempt to end the response below.
  }
  try {
    if (!res.writableEnded) res.end();
  } catch {
    // best-effort: the socket may already be closed.
  }
}

/**
 * Writes `response` to `res`, guarded: a throw from {@link writeResponse}
 * (e.g. an out-of-range status or a header value `res.writeHead` rejects)
 * must never leave the socket open with no log line, so this falls back to
 * a bare 500 rather than letting the throw escape to the outer `.catch`,
 * which only logs and never touches the socket. A failed write is always a
 * genuine fault — never a routine caller-origin outcome — so its
 * {@link Core.M3LLogger.errorFrom} diagnostic line is unconditional, unlike
 * {@link logDiagnosticIfFault}.
 */
function writeResponseGuarded(
  res: ServerResponse,
  response: M3LConsoleResponse,
  context: RequestFaultContext,
  logger: Core.M3LLogger,
): void {
  try {
    writeResponse(res, response, context.correlationId);
  } catch (writeError) {
    logger.errorFrom(
      writeError,
      `failed writing response for ${context.method} ${context.path} (correlationId=${context.correlationId})`,
    );
    writeFallbackResponse(res);
  }
}

/** The result of dispatching a request: the response, and the auth mode of any matched route. */
interface DispatchResult {
  readonly response: M3LConsoleResponse;
  readonly accessMode: M3LRouteAuth | undefined;
}

/** Resolves the router lookup for `ctx` and dispatches to its handler through the middleware chain. */
async function dispatch(
  ctx: M3LRequestContext,
  router: M3LRouter,
  middlewares: readonly M3LConsoleMiddleware[],
): Promise<DispatchResult> {
  const lookup: M3LRouteLookup = router.lookup(ctx.method, ctx.path);

  if (lookup.outcome === "not-found") {
    return {
      response: responseForUnmatchedLookup("not-found", undefined, ctx),
      accessMode: undefined,
    };
  }
  if (lookup.outcome === "method-not-allowed") {
    return {
      response: responseForUnmatchedLookup(
        "method-not-allowed",
        lookup.allowed,
        ctx,
      ),
      accessMode: undefined,
    };
  }

  const matchedCtx = withAccessMode(
    withParams(ctx, lookup.params),
    lookup.route.auth,
  );
  const dispatched = composeMiddleware(middlewares)(lookup.route.handler);
  const response = await dispatched(matchedCtx);
  return { response, accessMode: lookup.route.auth };
}

/**
 * Wraps {@link dispatch} in the `preRouting` middleware chain, so it runs
 * around the whole of dispatch — an unmatched lookup (404/405) included —
 * unlike `middlewares`, which only wraps a matched route's handler.
 *
 * `composeMiddleware` yields an {@link M3LConsoleHandler} returning a plain
 * {@link M3LConsoleResponse}, with no room to carry {@link DispatchResult}'s
 * `accessMode` back out without widening every middleware layer to carry
 * routing detail — a leak of routing internals into a seam that should stay
 * response-shaped. So the terminal handler passed to the `preRouting` chain
 * reports `accessMode` to `onDispatched` as a side effect instead;
 * `onDispatched` is only invoked once {@link dispatch} actually runs, never
 * when a `preRouting` member short-circuits before reaching it.
 */
function dispatchThroughPreRouting(
  ctx: M3LRequestContext,
  router: M3LRouter,
  middlewares: readonly M3LConsoleMiddleware[],
  preRouting: readonly M3LConsoleMiddleware[],
  onDispatched: (accessMode: M3LRouteAuth | undefined) => void,
): Promise<M3LConsoleResponse> {
  const terminal: M3LConsoleHandler = async (routedCtx) => {
    const result = await dispatch(routedCtx, router, middlewares);
    onDispatched(result.accessMode);
    return result.response;
  };
  return Promise.resolve(composeMiddleware(preRouting)(terminal)(ctx));
}

/** The per-request bookkeeping {@link beginRequest} hands to {@link runRequest}. */
interface BeginRequestResult {
  readonly startedAt: number;
  readonly fallbackCorrelationId: string;
  readonly connectionController: AbortController;
  readonly onClose: () => void;
  readonly signal: AbortSignal;
}

/**
 * Sets up the bookkeeping {@link runRequest} needs before it can build a
 * request context: the start timestamp, a fallback correlation id, the
 * connection-abort controller, and the composite signal it feeds.
 *
 * The returned `onClose` is registered via `req.once("close", onClose)`
 * BEFORE the composite signal is built, and MUST be removed by the caller
 * (via `req.removeListener("close", onClose)`, in `runRequest`'s `finally`)
 * once the request is done with it. The composite is
 * `AbortSignal.any([options.signal, connectionController.signal])`, in that
 * order — see {@link finishRequest}'s TSDoc for why both the controller and
 * this order matter.
 */
function beginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateConsoleRequestListenerOptions,
  newCorrelationId: () => string,
  now: () => number,
): BeginRequestResult {
  const startedAt = now();
  const fallbackCorrelationId = newCorrelationId();
  const connectionController = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) connectionController.abort();
  };
  req.once("close", onClose);
  const signal = AbortSignal.any([options.signal, connectionController.signal]);

  return {
    startedAt,
    fallbackCorrelationId,
    connectionController,
    onClose,
    signal,
  };
}

/** Builds the request context, reusing the already-generated fallback correlation id rather than minting a fresh one. */
function buildRequestContext(
  req: IncomingMessage,
  method: string,
  signal: AbortSignal,
  now: () => number,
  fallbackCorrelationId: string,
): M3LRequestContext {
  return createRequestContext({
    method,
    url: req.url ?? "/",
    headers: toHeaderMap(req.headers, req.rawHeaders),
    signal,
    now,
    newCorrelationId: () => fallbackCorrelationId,
  });
}

/**
 * Turns a thrown value caught by {@link runRequest} into its response,
 * emitting the diagnostic line for a genuine fault along the way (see
 * {@link logDiagnosticIfFault} for the fault-vs-routine gate). `context`
 * carries the CURRENT correlation id, method, and path as they stand at the
 * moment of the throw — never the raw, unparsed `req.url`.
 */
function responseForThrownError(
  error: unknown,
  logger: Core.M3LLogger,
  context: RequestFaultContext,
): M3LConsoleResponse {
  const response = errorResponse(error, context.correlationId);
  logDiagnosticIfFault(logger, error, context);
  return response;
}

/**
 * Runs one request end-to-end: context, dispatch, response, and its logging.
 * Exactly one outcome line is logged per request; a failure additionally
 * emits one diagnostic line (see {@link logDiagnosticIfFault}), gated so a
 * routine caller-origin outcome (4xx) never doubles up.
 */
async function runRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateConsoleRequestListenerOptions,
  newCorrelationId: () => string,
  now: () => number,
): Promise<void> {
  const began = beginRequest(req, res, options, newCorrelationId, now);

  let method = req.method ?? "";
  // Never seeded from the raw `req.url`: a request whose target fails to
  // parse must not log its (possibly query-string-bearing) raw target.
  let path = PATH_PLACEHOLDER_UNPARSED;
  let correlationId = began.fallbackCorrelationId;
  let accessMode: M3LRouteAuth | undefined;
  let response: M3LConsoleResponse;

  try {
    const ctx = buildRequestContext(
      req,
      method,
      began.signal,
      now,
      began.fallbackCorrelationId,
    );
    correlationId = ctx.correlationId;
    method = ctx.method;
    path = ctx.path;

    response = await dispatchThroughPreRouting(
      ctx,
      options.router,
      options.middlewares,
      options.preRouting,
      (mode) => {
        accessMode = mode;
      },
    );
  } catch (error) {
    response = responseForThrownError(error, options.logger, {
      method,
      path,
      correlationId,
    });
  } finally {
    req.removeListener("close", began.onClose);
  }

  finishRequest({
    res,
    response,
    context: { method, path, correlationId },
    connectionController: began.connectionController,
    startedAt: began.startedAt,
    now,
    accessMode,
    logger: options.logger,
  });
}

/** Inputs for {@link finishRequest}. */
interface FinishRequestInputs {
  readonly res: ServerResponse;
  readonly response: M3LConsoleResponse;
  readonly context: RequestFaultContext;
  readonly connectionController: AbortController;
  readonly startedAt: number;
  readonly now: () => number;
  readonly accessMode: M3LRouteAuth | undefined;
  readonly logger: Core.M3LLogger;
}

/**
 * Writes `response`, releases the composite abort signal, and logs the
 * request's outcome line — the tail shared by every completion path through
 * {@link runRequest}.
 *
 * Releasing the composite `signal` — built as
 * `AbortSignal.any([options.signal, connectionController.signal])` and
 * threaded through as `ctx.signal` — is a fix for a MEASURED leak (Node
 * v26.7.0): a composite whose sources are both
 * still open is normally collectable, but the moment anything attaches an
 * `abort` listener to it and never removes it — exactly what `ctx.signal`
 * exists for (pollers, X4's run orchestration) — the still-open long-lived
 * `options.signal` (the drain signal, which lives as long as the server)
 * pins the composite for the rest of the process. Aborting
 * `connectionController` here releases that pin on every completion path
 * (2xx, a thrown/rejected handler, an unmatched 404/405, or a `preRouting`
 * short-circuit).
 *
 * ORDER IS LOAD-BEARING: the abort MUST run after {@link writeResponseGuarded},
 * never before — aborting first would cancel the very write it is meant to
 * follow (a listener on `ctx.signal` could tear down mid-write). This is
 * NOT redundant with the `onClose` listener in {@link runRequest}: that only
 * fires on an early client disconnect, not on ordinary completion, so most
 * requests would otherwise never release the pin.
 */
function finishRequest(inputs: FinishRequestInputs): void {
  writeResponseGuarded(
    inputs.res,
    inputs.response,
    inputs.context,
    inputs.logger,
  );

  inputs.connectionController.abort();

  logOutcome(inputs.logger, {
    method: inputs.context.method,
    path: inputs.context.path,
    status: inputs.response.status,
    durationMs: inputs.now() - inputs.startedAt,
    correlationId: inputs.context.correlationId,
    accessMode: inputs.accessMode,
  });
}

/**
 * Builds the `node:http` request listener for the console server: resolves
 * a request context, dispatches it through the router and middleware
 * chain, writes the response, and logs exactly one *outcome* line — never a
 * query string, headers, a body, or the operator's email. A failure
 * additionally emits one diagnostic line via
 * {@link Core.M3LLogger.errorFrom} (gated so a routine non-fault outcome
 * never doubles up — see {@link isFaultError}), so the real cause of
 * a genuine fault is never lost to the fixed generic envelope message alone
 * (ADR-0070's display-vs-persist split).
 *
 * The listener returns `void` and never lets a rejection escape: every
 * failure — a bad request, an unmatched route, or a handler/middleware
 * throw or rejection — is caught and turned into a well-formed error
 * response.
 *
 * @param options - See {@link CreateConsoleRequestListenerOptions}.
 * @returns The `node:http` request listener.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 *
 * const listener = createConsoleRequestListener({
 *   router: createRouter([]),
 *   middlewares: [],
 *   preRouting: [],
 *   logger,
 *   signal: new AbortController().signal,
 * });
 * createServer(listener);
 * ```
 */
export function createConsoleRequestListener(
  options: CreateConsoleRequestListenerOptions,
): M3LConsoleRequestListener {
  const newCorrelationId = options.newCorrelationId ?? randomUUID;
  const now = options.now ?? Date.now;

  return function requestListener(req, res) {
    void runRequest(req, res, options, newCorrelationId, now).catch(
      (cause: unknown) => {
        // `runRequest` already catches every failure it can reach; this only
        // guards the pathological case where something outside that boundary
        // (e.g. writing the response itself) throws, so a bug there can never
        // surface as an unhandled rejection and kill the daemon.
        options.logger.error("unhandled console request listener failure", {
          cause: Core.getErrorMessage(cause),
        });
      },
    );
  };
}
