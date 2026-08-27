/**
 * `http/auth-middleware` — resolves the operator for a request via an
 * injected {@link M3LOperatorProvider}, gated by the matched route's
 * `accessMode` (ADR-0071).
 *
 * @packageDocumentation
 */

import type { M3LOperatorProvider } from "../auth/identity.js";
import { M3LConsoleError } from "../errors/console-error.js";
import { withOperator } from "./context.js";
import type { M3LRequestContext } from "./context.js";
import type { M3LConsoleHandler, M3LConsoleMiddleware } from "./middleware.js";
import type { M3LConsoleResponse } from "./respond.js";

/**
 * Resolves `ctx`'s operator via `provider.resolve(ctx.headers)`, throwing
 * `ERR_CONSOLE_UNAUTHENTICATED` when nothing resolves, and otherwise
 * returning the context extended with the resolved profile via
 * {@link withOperator}.
 */
function resolveAuthenticated(
  provider: M3LOperatorProvider,
  ctx: M3LRequestContext,
): M3LRequestContext {
  const profile = provider.resolve(ctx.headers);
  if (profile === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_UNAUTHENTICATED",
      "no operator could be resolved for this request",
    );
  }
  return withOperator(ctx, profile);
}

/**
 * Builds the middleware that gates a request on `ctx.accessMode`:
 *
 * - `"exempt"` — passes through without calling `provider.resolve` at all,
 *   since a liveness probe must not require a session.
 * - `"required"` — calls `provider.resolve(ctx.headers)`; `undefined` throws
 *   `ERR_CONSOLE_UNAUTHENTICATED` and `next` is never called; otherwise
 *   `next` runs against a context carrying the resolved operator (see
 *   {@link withOperator}).
 * - `undefined` (routing has not matched yet, or a route table declared
 *   neither mode) — fails closed, treated exactly like `"required"`. An
 *   unset access mode must never be read as "exempt": that would let an
 *   unmatched/pre-routing request bypass authentication entirely.
 *
 * @param provider - The ADR-0071 auth seam this middleware resolves against.
 * @returns The resulting {@link M3LConsoleMiddleware}.
 *
 * @example
 * ```ts
 * import { createSingleOperatorProvider } from "@m3l-automation/m3l-console-server/auth/identity.js";
 * import { createAuthMiddleware } from "@m3l-automation/m3l-console-server/http/auth-middleware.js";
 *
 * const provider = createSingleOperatorProvider({ name: "ada", email: undefined });
 * const middleware = createAuthMiddleware(provider);
 * ```
 */
export function createAuthMiddleware(
  provider: M3LOperatorProvider,
): M3LConsoleMiddleware {
  return (
    ctx: M3LRequestContext,
    next: M3LConsoleHandler,
  ): Promise<M3LConsoleResponse> | M3LConsoleResponse => {
    if (ctx.accessMode === "exempt") return next(ctx);
    return next(resolveAuthenticated(provider, ctx));
  };
}
