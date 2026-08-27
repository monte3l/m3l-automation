/**
 * `http/drain-middleware` — wraps every request in the ADR-0049 drain
 * controller's `track()`/release lifecycle, so an in-flight response is
 * never abandoned mid-write once a shutdown begins.
 *
 * @packageDocumentation
 */

import type { M3LDrainController } from "../lifecycle/drain.js";
import type { M3LConsoleHandler, M3LConsoleMiddleware } from "./middleware.js";
import type { M3LRequestContext } from "./context.js";
import type { M3LConsoleResponse } from "./respond.js";

/**
 * Builds the middleware that tracks one unit of in-flight work against
 * `controller` for the lifetime of a request — SKIPPING that tracking
 * entirely for a route whose {@link M3LRequestContext.accessMode} is
 * `"exempt"` (an infrastructure liveness/readiness probe; today the only
 * `"exempt"` routes are `http/routes/health.ts`'s `/health` and `/ready`).
 *
 * This middleware belongs in `main.ts`'s `middlewares` chain, NOT its
 * `preRouting` chain, and that placement is load-bearing, not
 * interchangeable: `preRouting` runs before routing has resolved, so
 * `ctx.accessMode` is always `undefined` there — the exempt check below
 * could never fire, and a liveness probe would be refused right alongside
 * real work during a drain. `middlewares` only wraps a matched route's
 * handler, by which point `ctx.accessMode` reflects the matched route's
 * declared {@link M3LRouteAuth} (see `http/handler.ts`'s `dispatch`), which
 * is exactly what makes the skip possible at all. `preRouting` is reserved
 * for a control that must not be bypassable by requesting an unknown path
 * (e.g. the origin guard) — the drain refusal is the opposite: it is
 * per-route policy, like auth, and a liveness probe must keep answering
 * *during* a drain.
 *
 * CAVEAT worth flagging for the next reader: `accessMode === "exempt"`
 * already means "no auth required" (see `http/auth-middleware.ts`), and this
 * middleware now ALSO reads it as "is an infrastructure probe that must
 * survive a drain". Those two meanings happen to coincide today because the
 * health routes are the only exempt ones, but they are not the same
 * question — if a future exempt-but-not-a-probe route ever appears (e.g. a
 * public, unauthenticated endpoint that should still be refused while
 * draining), this conflation breaks and the fix is a dedicated route flag
 * (e.g. `M3LRoute.survivesDrain`), not another overload of `accessMode`.
 *
 * For a non-exempt route, `controller.track()` is called first and outside
 * any `try`: while the controller is `"draining"` it throws
 * `ERR_CONSOLE_UNAVAILABLE` (`lifecycle/drain.ts`), and that throw is left
 * to propagate as-is — never caught here, and `next` is never called.
 * `http/handler.ts` maps the propagated error to its response envelope, and
 * the code's `fault: false` classification (`http/envelope.ts`) keeps a
 * routine drain refusal out of the error-level diagnostic log.
 *
 * Once tracking succeeds, `next` runs and the release function returned by
 * `track()` is called in a `finally`, so it runs on both the resolve and the
 * throw path — a rejected `next` still releases the tracked unit before its
 * error propagates unchanged.
 *
 * @param controller - The drain controller every non-exempt request is
 *   tracked against.
 * @returns The resulting {@link M3LConsoleMiddleware}.
 *
 * @example
 * ```ts
 * import { createDrainController } from "@m3l-automation/m3l-console-server/lifecycle/drain.js";
 * import { createDrainMiddleware } from "@m3l-automation/m3l-console-server/http/drain-middleware.js";
 *
 * const controller = createDrainController({ timeoutMs: 5_000 });
 * const middleware = createDrainMiddleware(controller);
 * ```
 */
export function createDrainMiddleware(
  controller: M3LDrainController,
): M3LConsoleMiddleware {
  return async (
    ctx: M3LRequestContext,
    next: M3LConsoleHandler,
  ): Promise<M3LConsoleResponse> => {
    if (ctx.accessMode === "exempt") return next(ctx);

    const release = controller.track();
    try {
      return await next(ctx);
    } finally {
      release();
    }
  };
}
