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
import { withStreamCompletion } from "./stream-response.js";
import type { M3LConsoleResult } from "./stream-response.js";

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
 * Once tracking succeeds, `next` runs. Releasing the tracked unit is NOT a
 * plain `finally { release(); }` (Bug 3, X4 ADR-0066): for a streaming
 * result, `next()` resolves at the point the route calls `open()`, not at
 * the point the stream actually finishes — a `finally` there would let
 * `inFlight` reach 0 while a watcher is still attached, so a shutdown would
 * hand every open stream an abrupt `ECONNRESET` instead of a clean end.
 * Release is instead deferred via {@link withStreamCompletion}: for a
 * buffered result it fires immediately (unchanged behavior), and for a
 * stream it is wrapped into the result's own `open()`, firing exactly once
 * whether `open()` resolves or rejects. `release` is called directly on both
 * the `next(ctx)` throw path and the `withStreamCompletion` path below —
 * this is NOT a double-release risk: the two paths are mutually exclusive
 * (a throw from `next(ctx)` means `withStreamCompletion` never runs at all).
 * The exactly-once guarantee for the surviving path belongs to
 * `withStreamCompletion`'s own internal `once()` guard, pinned by its
 * dedicated coverage in `stream-response.test.ts` (the case asserting that
 * `onComplete` fires exactly once even when `open()` settles more than
 * once) — not to this middleware. Do not re-add a local once-guard here: it
 * would guard a state this code cannot reach, since the two call sites are
 * mutually exclusive by construction. A double release would silently
 * decrement {@link M3LDrainController.inFlight} below its true value, after
 * which it never reaches `0` and every future shutdown times out into a
 * non-graceful drain.
 *
 * KNOWN INVARIANT the caller must preserve: `release` only ever fires once
 * a stream result's `open()` is actually invoked (via
 * {@link withStreamCompletion}'s wrapping). If some future outer layer ever
 * discarded a stream result without calling `open()` on it, the tracked
 * unit would leak and `inFlight` would never return to `0`. Today
 * `http/handler.ts`'s `resolveDispatchedResult` always calls `writeStream`,
 * which always calls `open()`, so this cannot happen — but the coupling is
 * implicit, not mechanically enforced here.
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
  ): Promise<M3LConsoleResult> => {
    if (ctx.accessMode === "exempt") return next(ctx);

    const release = controller.track();
    try {
      // `release` is passed straight through, unguarded: the exactly-once
      // guarantee is `withStreamCompletion`'s own `once()`, not this
      // middleware's — see the TSDoc above for why a local guard here would
      // be unreachable, not merely untested.
      return withStreamCompletion(await next(ctx), release);
    } catch (error) {
      release();
      throw error;
    }
  };
}
