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

import { logDiagnosticIfFault, logOutcome } from "./access-log.js";
import type { RequestFaultContext } from "./access-log.js";
import { readJsonBody } from "./body.js";
import {
  createRequestContext,
  withAccessMode,
  withBody,
  withParams,
} from "./context.js";
import type { M3LRequestContext } from "./context.js";
import { errorResponse } from "./envelope.js";
import { M3LConsoleError } from "../errors/console-error.js";
import { composeMiddleware } from "./middleware.js";
import type { M3LConsoleHandler, M3LConsoleMiddleware } from "./middleware.js";
import { toHeaderMap } from "./request-validation.js";
import { writeResponse } from "./respond.js";
import type { M3LConsoleResponse } from "./respond.js";
import type { M3LRouteAuth, M3LRouteLookup, M3LRouter } from "./router.js";
import { resolveDispatchedResult } from "./stream-dispatch.js";
import type { M3LConsoleResult } from "./stream-response.js";
import { validateStreamOptions } from "./stream-options.js";
import type { M3LStreamWriteOutcome } from "./stream-writer.js";

/** Logged in place of a request's path when it failed to parse — never the raw, unparsed target. */
const PATH_PLACEHOLDER_UNPARSED = "(unparsed)";
/** The status the last-resort fallback response writes when {@link writeResponse} itself throws. */
const STATUS_INTERNAL_SERVER_ERROR = 500;
/** `maxBodyBytes` default when the caller supplies none (mirrors `config/env.ts`'s own default; `http/` cannot import `config/`). */
const DEFAULT_MAX_BODY_BYTES = 65_536;
/** HTTP methods whose request may carry a JSON body worth reading (X4 slice 7-pre). */
const BODY_BEARING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
]);

/** Throws `ERR_CONSOLE_CONFIG_INVALID` unless `value` is a positive integer. */
function assertPositiveInteger(key: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_CONFIG_INVALID",
      `${key} must be a positive integer, got ${String(value)}`,
      { context: { key } },
    );
  }
}

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
  /**
   * Heartbeat interval (ms) a stream response emits while `open()` is
   * pending (X4, ADR-0066); see `stream-writer.ts`. Optional because `http`
   * may not import `config/` — a caller (e.g. `main.ts`) supplies its own
   * configured value once one exists. Defaults to `30_000`.
   */
  readonly heartbeatMs?: number;
  /**
   * The unflushed-backlog ceiling (bytes) past which a stream response drops
   * a route frame rather than writing it. Defaults to `1_000_000`.
   */
  readonly maxPendingBytes?: number;
  /**
   * The SSE `retry:` interval (ms) a stream response tells a reconnecting
   * client. Defaults to `2_000`.
   */
  readonly retryMs?: number;
  /**
   * The request-body byte cap threaded into `http/body.ts`'s `readJsonBody`
   * for a `POST`/`PUT`/`PATCH` request. Optional because `http` may not
   * import `config/` — a caller supplies its own configured value
   * (`M3L_CONSOLE_MAX_BODY_BYTES`). Defaults to `65_536` (64 KiB).
   */
  readonly maxBodyBytes?: number;
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
      res.writeHead(STATUS_INTERNAL_SERVER_ERROR);
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

/** The result of dispatching a request: the route's result (buffered or a stream), and the auth mode of any matched route. */
interface DispatchResult {
  readonly response: M3LConsoleResult;
  readonly accessMode: M3LRouteAuth | undefined;
}

/**
 * Reads and attaches the request body via {@link readJsonBody} for a method
 * that may carry one ({@link BODY_BEARING_METHODS}), else returns `ctx`
 * unchanged. Called from {@link dispatch}'s terminal handler, so it only
 * runs once auth (`middlewares`) has already called `next()`.
 */
async function attachBodyIfApplicable(
  req: IncomingMessage,
  ctx: M3LRequestContext,
  maxBodyBytes: number,
): Promise<M3LRequestContext> {
  if (!BODY_BEARING_METHODS.has(ctx.method.toUpperCase())) return ctx;
  const body = await readJsonBody(req, {
    maxBytes: maxBodyBytes,
    signal: ctx.signal,
  });
  return withBody(ctx, body);
}

/**
 * Resolves the router lookup for `ctx` and dispatches to its handler through
 * the middleware chain. The terminal handler reads the body (see
 * {@link attachBodyIfApplicable}) before the route handler — after auth.
 */
async function dispatch(
  req: IncomingMessage,
  ctx: M3LRequestContext,
  router: M3LRouter,
  middlewares: readonly M3LConsoleMiddleware[],
  maxBodyBytes: number,
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
  const terminal: M3LConsoleHandler = async (routedCtx) => {
    const bodyCtx = await attachBodyIfApplicable(req, routedCtx, maxBodyBytes);
    return lookup.route.handler(bodyCtx);
  };
  const dispatched = composeMiddleware(middlewares)(terminal);
  const response = await dispatched(matchedCtx);
  return { response, accessMode: lookup.route.auth };
}

/**
 * Wraps {@link dispatch} in the `preRouting` middleware chain, so it runs
 * around the whole of dispatch — an unmatched lookup (404/405) included —
 * unlike `middlewares`, which only wraps a matched route's handler.
 *
 * `composeMiddleware` yields an {@link M3LConsoleHandler} returning a plain
 * {@link M3LConsoleResult}, with no room to carry {@link DispatchResult}'s
 * `accessMode` back out without widening every middleware layer to carry
 * routing detail — a leak of routing internals into a seam that should stay
 * result-shaped. So the terminal handler passed to the `preRouting` chain
 * reports `accessMode` to `onDispatched` as a side effect instead;
 * `onDispatched` is only invoked once {@link dispatch} actually runs, never
 * when a `preRouting` member short-circuits before reaching it.
 */
function dispatchThroughPreRouting(
  req: IncomingMessage,
  ctx: M3LRequestContext,
  router: M3LRouter,
  middlewares: readonly M3LConsoleMiddleware[],
  preRouting: readonly M3LConsoleMiddleware[],
  maxBodyBytes: number,
  onDispatched: (accessMode: M3LRouteAuth | undefined) => void,
): Promise<M3LConsoleResult> {
  const terminal: M3LConsoleHandler = async (routedCtx) => {
    const result = await dispatch(
      req,
      routedCtx,
      router,
      middlewares,
      maxBodyBytes,
    );
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

/** What dispatching and resolving one already-built request context produces. */
interface DispatchOutcome {
  readonly accessMode: M3LRouteAuth | undefined;
  readonly response: M3LConsoleResponse;
  readonly wroteAlready: boolean;
  readonly streamOutcome?: M3LStreamWriteOutcome;
}

/**
 * Dispatches `ctx` through pre-routing/routing/middleware and resolves the
 * result via {@link resolveDispatchedResult} — split out of `runRequest`'s
 * own `try` purely to stay under this file's `max-lines-per-function`
 * budget. `ctx` (and therefore `runRequest`'s `method`/`path`/
 * `correlationId`) MUST already be resolved by the caller before this runs:
 * a throw from dispatch must still let `runRequest`'s `catch` log the real
 * method/path, not the pre-parse placeholder. Left to throw on any failure;
 * `runRequest`'s `catch` is what turns a rejection into an error response.
 */
async function dispatchAndResolve(
  req: IncomingMessage,
  ctx: M3LRequestContext,
  res: ServerResponse,
  options: CreateConsoleRequestListenerOptions,
): Promise<DispatchOutcome> {
  let accessMode: M3LRouteAuth | undefined;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const result = await dispatchThroughPreRouting(
    req,
    ctx,
    options.router,
    options.middlewares,
    options.preRouting,
    maxBodyBytes,
    (mode) => {
      accessMode = mode;
    },
  );
  // Awaited HERE, inside the same `try` `runRequest` wraps this call in: for
  // a stream result this only settles once the stream itself ends, not at
  // `open()` — fixing Bugs 1 and 2 without scattering `isStreamResponse`
  // checks through the rest of the pipeline.
  const resolved = await resolveDispatchedResult(
    res,
    result,
    ctx.correlationId,
    options,
  );
  return {
    accessMode,
    response: resolved.response,
    wroteAlready: resolved.wroteAlready,
    ...(resolved.streamOutcome !== undefined && {
      streamOutcome: resolved.streamOutcome,
    }),
  };
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
  let wroteAlready = false;
  let streamOutcome: M3LStreamWriteOutcome | undefined;

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

    const outcome = await dispatchAndResolve(req, ctx, res, options);
    accessMode = outcome.accessMode;
    response = outcome.response;
    wroteAlready = outcome.wroteAlready;
    streamOutcome = outcome.streamOutcome;
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
    write: !wroteAlready,
    ...(streamOutcome !== undefined && { streamOutcome }),
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
  /**
   * `false` for a stream result: `resolveDispatchedResult` already wrote the
   * head and every frame via `writeStream`, and writing `response` here too
   * (a synthetic, empty-bodied stand-in) would double-write the socket.
   */
  readonly write: boolean;
  /** The stream's frame/drop counts and stop reason, present only for a stream result. */
  readonly streamOutcome?: M3LStreamWriteOutcome;
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
 * ORDER IS LOAD-BEARING: the abort MUST run after the write — after
 * {@link writeResponseGuarded} for a buffered response (`inputs.write`), or,
 * for a stream, after `resolveDispatchedResult`'s own {@link writeStream}
 * call has already returned by the time `finishRequest` is even invoked —
 * never before either. Aborting first would cancel the very write/stream it
 * is meant to follow (a listener on `ctx.signal` could tear down mid-write).
 * This is NOT redundant with the `onClose` listener in {@link runRequest}:
 * that only fires on an early client disconnect, not on ordinary completion,
 * so most requests would otherwise never release the pin.
 */
function finishRequest(inputs: FinishRequestInputs): void {
  if (inputs.write) {
    writeResponseGuarded(
      inputs.res,
      inputs.response,
      inputs.context,
      inputs.logger,
    );
  }

  inputs.connectionController.abort();

  logOutcome(inputs.logger, {
    method: inputs.context.method,
    path: inputs.context.path,
    status: inputs.response.status,
    durationMs: inputs.now() - inputs.startedAt,
    correlationId: inputs.context.correlationId,
    accessMode: inputs.accessMode,
    ...(inputs.streamOutcome !== undefined && {
      streamOutcome: inputs.streamOutcome,
    }),
  });
}

/**
 * Builds the `node:http` request listener for the console server: resolves
 * a request context, dispatches it through the router and middleware
 * chain, writes the response, and logs exactly one *outcome* line — never a
 * query string, headers, a body, or the operator's email. A failure
 * additionally emits one diagnostic line via
 * {@link Core.M3LLogger.errorFrom} (gated by {@link logDiagnosticIfFault} so
 * a routine non-fault outcome never doubles up), so the real cause of
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
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when a supplied `heartbeatMs`, `maxPendingBytes`, or `retryMs` is not a
 *   non-negative integer — checked synchronously here, before any request is
 *   accepted (PR #718 review, defect 1), rather than left to surface much
 *   later out of `stream-writer.ts`'s `writeStream`.
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
  validateStreamOptions(options);
  if (options.maxBodyBytes !== undefined) {
    assertPositiveInteger("maxBodyBytes", options.maxBodyBytes);
  }
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
