/**
 * `http/middleware` — the onion-composition seam every request runs through
 * between the router's dispatch and the matched route's own handler
 * (ADR-0065).
 *
 * @packageDocumentation
 */

import type { M3LRequestContext } from "./context.js";
import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LConsoleResponse } from "./respond.js";

/**
 * A route's terminal request handler: builds the {@link M3LConsoleResponse}
 * for a request context. May be synchronous or asynchronous.
 *
 * @example
 * ```ts
 * const handler: M3LConsoleHandler = (ctx) => ({
 *   status: 200,
 *   headers: {},
 *   body: ctx.path,
 * });
 * ```
 */
export type M3LConsoleHandler = (
  ctx: M3LRequestContext,
) => Promise<M3LConsoleResponse> | M3LConsoleResponse;

/**
 * One layer of the request pipeline's onion: receives the context and the
 * next handler in the chain (either the next middleware or, at the
 * innermost layer, the matched route's own handler), and either calls
 * `next` to continue the chain or short-circuits by returning its own
 * response.
 *
 * @example
 * ```ts
 * const logging: M3LConsoleMiddleware = async (ctx, next) => {
 *   const response = await next(ctx);
 *   return response;
 * };
 * ```
 */
export type M3LConsoleMiddleware = (
  ctx: M3LRequestContext,
  next: M3LConsoleHandler,
) => Promise<M3LConsoleResponse> | M3LConsoleResponse;

/**
 * Wraps `handler` in a single middleware layer, guarding against `next`
 * being invoked more than once from within that layer.
 */
function wrapLayer(
  middleware: M3LConsoleMiddleware,
  handler: M3LConsoleHandler,
): M3LConsoleHandler {
  return async (ctx) => {
    let called = false;
    const next: M3LConsoleHandler = async (nextCtx) => {
      if (called) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          "middleware called next() more than once",
        );
      }
      called = true;
      return handler(nextCtx);
    };
    return middleware(ctx, next);
  };
}

/**
 * Folds `middlewares` around `handler`, outermost-first, building the
 * `next` seen by each layer from the layers still inside it.
 */
function foldMiddlewares(
  middlewares: readonly M3LConsoleMiddleware[],
  handler: M3LConsoleHandler,
): M3LConsoleHandler {
  const [first, ...rest] = middlewares;
  if (first === undefined) return handler;
  return wrapLayer(first, foldMiddlewares(rest, handler));
}

/**
 * Builds the onion composition of `middlewares` around a terminal handler:
 * the first entry in `middlewares` is outermost, running before every other
 * layer and unwinding after every other layer. Calling `next()` more than
 * once from within a single layer throws {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_INTERNAL"` rather than silently re-running the rest of the
 * chain.
 *
 * @param middlewares - The middleware chain, outermost first. An empty list
 *   returns the handler unchanged.
 * @returns A function that wraps a terminal {@link M3LConsoleHandler} in the
 *   composed chain.
 *
 * @example
 * ```ts
 * const pipeline = composeMiddleware([loggingMiddleware, authMiddleware]);
 * const wrapped = pipeline((ctx) => ({ status: 200, headers: {}, body: ctx.path }));
 * ```
 */
export function composeMiddleware(
  middlewares: readonly M3LConsoleMiddleware[],
): (handler: M3LConsoleHandler) => M3LConsoleHandler {
  return (handler) => {
    if (middlewares.length === 0) return handler;
    return foldMiddlewares(middlewares, handler);
  };
}
