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

import { createRequestContext, withParams } from "./context.js";
import type { M3LRequestContext } from "./context.js";
import { errorResponse } from "./envelope.js";
import { M3LConsoleError } from "../errors/console-error.js";
import { composeMiddleware } from "./middleware.js";
import type { M3LConsoleMiddleware } from "./middleware.js";
import { writeResponse } from "./respond.js";
import type { M3LConsoleResponse } from "./respond.js";
import type { M3LRouteAuth, M3LRouteLookup, M3LRouter } from "./router.js";

/** The status below which a response is logged at `info`. */
const STATUS_CLIENT_ERROR_THRESHOLD = 400;
/** The status at and above which a response is logged at `error`. */
const STATUS_SERVER_ERROR_THRESHOLD = 500;

/**
 * Constructor options for {@link createConsoleRequestListener}.
 *
 * @example
 * ```ts
 * const options: CreateConsoleRequestListenerOptions = {
 *   router: createRouter([]),
 *   middlewares: [],
 *   logger,
 *   signal: new AbortController().signal,
 * };
 * ```
 */
export interface CreateConsoleRequestListenerOptions {
  /** The compiled router dispatching each request. */
  readonly router: M3LRouter;
  /** The middleware chain wrapping every matched route's handler. */
  readonly middlewares: readonly M3LConsoleMiddleware[];
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

/** Coerces Node's header map to the plain string map `createRequestContext` expects. */
function toHeaderMap(
  headers: IncomingMessage["headers"],
): Readonly<Record<string, string | undefined>> {
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

  const matchedCtx = withParams(ctx, lookup.params);
  const dispatched = composeMiddleware(middlewares)(lookup.route.handler);
  const response = await dispatched(matchedCtx);
  return { response, accessMode: lookup.route.auth };
}

/** Runs one request end-to-end: context, dispatch, response, and its single log line. */
async function runRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateConsoleRequestListenerOptions,
  newCorrelationId: () => string,
  now: () => number,
): Promise<void> {
  const startedAt = now();
  const fallbackCorrelationId = newCorrelationId();
  const connectionController = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) connectionController.abort();
  };
  req.once("close", onClose);
  const signal = AbortSignal.any([options.signal, connectionController.signal]);

  let method = req.method ?? "";
  let path = req.url ?? "/";
  let correlationId = fallbackCorrelationId;
  let accessMode: M3LRouteAuth | undefined;
  let response: M3LConsoleResponse;

  try {
    const ctx = createRequestContext({
      method,
      url: path,
      headers: toHeaderMap(req.headers),
      signal,
      now,
      newCorrelationId: () => fallbackCorrelationId,
    });
    correlationId = ctx.correlationId;
    method = ctx.method;
    path = ctx.path;

    const result = await dispatch(ctx, options.router, options.middlewares);
    response = result.response;
    accessMode = result.accessMode;
  } catch (error) {
    response = errorResponse(error, correlationId);
  } finally {
    req.removeListener("close", onClose);
  }

  writeResponse(res, response, correlationId);
  logOutcome(options.logger, {
    method,
    path,
    status: response.status,
    durationMs: now() - startedAt,
    correlationId,
    accessMode,
  });
}

/**
 * Builds the `node:http` request listener for the console server: resolves
 * a request context, dispatches it through the router and middleware
 * chain, writes the response, and logs exactly one outcome line — never a
 * query string, headers, a body, or the operator's email.
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
