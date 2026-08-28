/**
 * `http/routes/built-in` — composes every route group the console server
 * registers ahead of caller-supplied routes, in the fixed order the built-in
 * groups must be dispatched at.
 *
 * Today that is only the health/readiness pair from {@link createHealthRoutes}.
 * A caller's own routes are appended AFTER the built-in table, never before —
 * `main.ts`'s `buildDispatchRouter` relies on that ordering so a caller can
 * never accidentally shadow `/health`/`/ready` with a route of its own; see
 * {@link createBuiltInRoutes}'s TSDoc for the compiler-checked proof site.
 *
 * @packageDocumentation
 */

import type { M3LDrainController } from "../../lifecycle/drain.js";
import { createHealthRoutes } from "./health.js";
import type { HealthRouteOptions } from "./health.js";
import type { M3LRoute } from "../router.js";

/**
 * Constructor options for {@link createBuiltInRoutes}.
 *
 * @example
 * ```ts
 * const options: BuiltInRouteOptions = {
 *   drain: createDrainController({ timeoutMs: 15_000 }),
 *   startedAt: Date.now(),
 *   routes: [],
 * };
 * ```
 */
export interface BuiltInRouteOptions {
  /** The drain controller `/ready` reads `state` from; see {@link HealthRouteOptions.drain}. */
  readonly drain: M3LDrainController;
  /** The timestamp (`Date.now()`-shaped) the process started at. */
  readonly startedAt: number;
  /** Optional store-health probe, forwarded verbatim to {@link createHealthRoutes}. */
  readonly store?: HealthRouteOptions["store"];
  /**
   * Caller-supplied routes, appended AFTER every built-in route group — see
   * this module's headline TSDoc for why that ordering is never reversed.
   */
  readonly routes: readonly M3LRoute[];
}

/**
 * Builds the console server's full built-in route table — today just the
 * health/readiness pair from {@link createHealthRoutes} — with `options.routes`
 * appended after it, so a caller can never shadow `/health`/`/ready`.
 *
 * `options.store` is threaded through to {@link createHealthRoutes} so
 * `/ready` reflects the real store's health in every deployment; the shape
 * required is {@link HealthRouteOptions.store}'s locally-declared
 * `M3LReadinessProbe`, not an import from `store/`, keeping this module
 * inside the `http` zone's allowed import set.
 *
 * @param options - See {@link BuiltInRouteOptions}.
 * @returns The built-in routes followed by `options.routes`, ready to hand
 *   to `createRouter`.
 *
 * @example
 * ```ts
 * import { createDrainController } from "@m3l-automation/m3l-console-server/lifecycle/drain.js";
 * import { createBuiltInRoutes } from "@m3l-automation/m3l-console-server/http/routes/built-in.js";
 *
 * const drain = createDrainController({ timeoutMs: 15_000 });
 * const routes = createBuiltInRoutes({ drain, startedAt: Date.now(), routes: [] });
 * ```
 */
export function createBuiltInRoutes(
  options: BuiltInRouteOptions,
): readonly M3LRoute[] {
  const healthRoutes = createHealthRoutes({
    drain: options.drain,
    startedAt: options.startedAt,
    ...(options.store !== undefined && { store: options.store }),
  });
  return [...healthRoutes, ...options.routes];
}
