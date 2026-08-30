/**
 * `boot/dispatch-router` — builds the router the console's request listener
 * actually dispatches through.
 *
 * Extracted verbatim from `main.ts`. It is deliberately separate from the
 * router the runtime publishes as `M3LConsoleRuntime.router`: that field
 * reflects the caller's route table verbatim, while this one prepends the
 * built-in health routes so a caller can never shadow `/health` or `/ready`.
 *
 * @packageDocumentation
 */

import { createRouter } from "../http/router.js";
import type { M3LRoute, M3LRouter } from "../http/router.js";
import { createBuiltInRoutes } from "../http/routes/built-in.js";
import type {
  RunsRouteOptions,
  SessionRouteOptions,
} from "../http/routes/built-in.js";
import type { M3LDrainController } from "../lifecycle/drain.js";
import type { M3LConsoleStoreLifecycle } from "../store/store.js";

/**
 * Builds the router the request listener actually dispatches through: the
 * built-in routes (see `createBuiltInRoutes`) ahead of `routes`, so a
 * caller can never accidentally shadow `/health`/`/ready`. Deliberately a
 * SEPARATE router instance from the one exposed as
 * `M3LConsoleRuntime.router` — that field reflects the caller's `routes`
 * verbatim, not an implementation detail of how liveness/readiness are
 * served.
 *
 * This call site is also the compiler-checked proof that
 * {@link M3LConsoleStoreLifecycle} (and the full `M3LConsoleStoreHandle`
 * that satisfies it) structurally conforms to `createBuiltInRoutes`'s
 * store-probe shape, without creating an `http -> store` ESLint zone edge.
 *
 * @param drain - The ADR-0049 drain controller `/ready` reports through.
 * @param routes - The caller's route table, dispatched after the built-ins.
 * @param store - The opened store, when one exists, for the `/ready` probe.
 * @param runs - The X4 run-route options, when the run subsystem is wired.
 * @param sessions - The X6 session-route options, when that subsystem is wired.
 * @returns The compiled dispatch router.
 *
 * @example
 * ```ts
 * const router = buildDispatchRouter(drain, [], undefined, undefined, undefined);
 * ```
 */
export function buildDispatchRouter(
  drain: M3LDrainController,
  routes: readonly M3LRoute[],
  store: M3LConsoleStoreLifecycle | undefined,
  runs: RunsRouteOptions | undefined,
  sessions: SessionRouteOptions | undefined,
): M3LRouter {
  return createRouter(
    createBuiltInRoutes({
      drain,
      startedAt: Date.now(),
      ...(store !== undefined && { store }),
      ...(runs !== undefined && { runs }),
      ...(sessions !== undefined && { sessions }),
      routes,
    }),
  );
}
