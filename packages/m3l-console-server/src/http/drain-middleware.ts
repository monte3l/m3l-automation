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
 * `controller` for the lifetime of a request.
 *
 * `controller.track()` is called first and outside any `try`: while the
 * controller is `"draining"` it throws `ERR_CONSOLE_UNAVAILABLE`
 * (`lifecycle/drain.ts`), and that throw is left to propagate as-is — never
 * caught here, and `next` is never called. `http/handler.ts` maps the
 * propagated error to its response envelope, and the code's `fault: false`
 * classification (`http/envelope.ts`) keeps a routine drain refusal out of
 * the error-level diagnostic log.
 *
 * Once tracking succeeds, `next` runs and the release function returned by
 * `track()` is called in a `finally`, so it runs on both the resolve and the
 * throw path — a rejected `next` still releases the tracked unit before its
 * error propagates unchanged.
 *
 * @param controller - The drain controller every request is tracked against.
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
    const release = controller.track();
    try {
      return await next(ctx);
    } finally {
      release();
    }
  };
}
