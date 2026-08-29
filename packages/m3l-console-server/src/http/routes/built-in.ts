/**
 * `http/routes/built-in` — composes every route group the console server
 * registers ahead of caller-supplied routes, in the fixed order the built-in
 * groups must be dispatched at.
 *
 * The health/readiness pair from {@link createHealthRoutes} comes first,
 * followed (X4 slice 7a) by the run-governor REST routes
 * ({@link createRunRoutes}) and the run SSE stream route
 * ({@link createRunStreamRoutes}) — only when `options.runs` is supplied
 * (run orchestration is optional; see `main.ts`'s `buildRunSubsystem`). A
 * caller's own routes are appended AFTER every built-in group, never before —
 * `main.ts`'s `buildDispatchRouter` relies on that ordering so a caller can
 * never accidentally shadow a built-in path with a route of its own; see
 * {@link createBuiltInRoutes}'s TSDoc for the compiler-checked proof site.
 *
 * @packageDocumentation
 */

import type { M3LDrainController } from "../../lifecycle/drain.js";
import { createHealthRoutes } from "./health.js";
import type { HealthRouteOptions } from "./health.js";
import { createRunRoutes } from "./runs.js";
import type { M3LRunLauncherPort, M3LRunReaderPort } from "./runs.js";
import { createRunStreamRoutes } from "./run-stream.js";
import type {
  M3LRunStreamRegistryPort,
  RunStreamRouteOptions,
} from "./run-stream.js";
import type { M3LRoute } from "../router.js";

/**
 * Constructor options for the X4 run-governor route groups
 * ({@link createRunRoutes}, {@link createRunStreamRoutes}), bundled into one
 * object since both groups are wired together or not at all — see
 * {@link BuiltInRouteOptions.runs}.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 *
 * const options: RunsRouteOptions = {
 *   orchestrator: { launch: () => ({ id: "run-1", scriptName: "sqs-etl", status: "running", dryRun: false, executionMode: "spawn" }) },
 *   registry: { list: () => [], get: () => undefined },
 *   hub: createEventStreamHub({ bufferSize: 100 }),
 * };
 * ```
 */
export interface RunsRouteOptions {
  /** The run-launching port; `main.ts` passes the real `M3LRunOrchestrator`. */
  readonly orchestrator: M3LRunLauncherPort;
  /**
   * The run-reading port — satisfies BOTH {@link M3LRunReaderPort} (the REST
   * routes) and {@link M3LRunStreamRegistryPort} (the stream route); `main.ts`
   * passes the real `M3LRunRegistry`, which conforms to both structurally.
   */
  readonly registry: M3LRunReaderPort & M3LRunStreamRegistryPort;
  /** The run-event stream hub; `main.ts` passes the real subsystem's `eventHub`. */
  readonly hub: RunStreamRouteOptions["hub"];
}

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
   * The X4 run-governor route groups' wiring, present only when run
   * orchestration is enabled (see `main.ts`'s `buildRunSubsystem`). Absent
   * entirely means neither `/api/v1/runs*` route is registered — there is no
   * "routes registered but always 404" middle state.
   */
  readonly runs?: RunsRouteOptions;
  /**
   * Caller-supplied routes, appended AFTER every built-in route group — see
   * this module's headline TSDoc for why that ordering is never reversed.
   */
  readonly routes: readonly M3LRoute[];
}

/**
 * Builds {@link RunsRouteOptions} from `main.ts`'s run-persistence port and
 * wired subsystem, or `undefined` when either is absent (run orchestration
 * disabled). Lives here rather than in `main.ts` — this module already owns
 * assembling the built-in routes' options, and `main.ts`'s file budget has no
 * headroom left for composition detail that belongs with its consumer.
 *
 * `registry`/`subsystem` are typed as the SAME structural ports this module
 * already declares (`M3LRunReaderPort & M3LRunStreamRegistryPort`, and the
 * `orchestrator`/`eventHub` shape `RunsRouteOptions` needs) rather than
 * imported from `runs/` — `main.ts`'s real `M3LRunRegistry`/`M3LRunSubsystem`
 * conform structurally, and importing the nominal types here would cross the
 * `http` zone's `runs/` boundary for no reason: this function throws them
 * away as soon as it reads the two fields it needs.
 *
 * @example
 * ```ts
 * import { toRunsRouteOptions } from "@m3l-automation/m3l-console-server/http/routes/built-in.js";
 *
 * const options = toRunsRouteOptions(undefined, undefined); // undefined
 * ```
 */
export function toRunsRouteOptions(
  registry: (M3LRunReaderPort & M3LRunStreamRegistryPort) | undefined,
  subsystem:
    | {
        readonly orchestrator: M3LRunLauncherPort;
        readonly eventHub: RunStreamRouteOptions["hub"];
      }
    | undefined,
): RunsRouteOptions | undefined {
  if (subsystem === undefined || registry === undefined) return undefined;
  return {
    orchestrator: subsystem.orchestrator,
    registry,
    hub: subsystem.eventHub,
  };
}

/**
 * Builds the run-governor route groups from `options.runs`, or an empty
 * table when run orchestration is disabled.
 */
function buildRunRoutes(
  runs: RunsRouteOptions | undefined,
): readonly M3LRoute[] {
  if (runs === undefined) return [];
  return [
    ...createRunRoutes({
      orchestrator: runs.orchestrator,
      registry: runs.registry,
    }),
    ...createRunStreamRoutes({ hub: runs.hub, registry: runs.registry }),
  ];
}

/**
 * Builds the console server's full built-in route table: the
 * health/readiness pair from {@link createHealthRoutes}, then (X4 slice 7a)
 * the run-governor routes when `options.runs` is supplied, then
 * `options.routes` — so a caller can never shadow a built-in path.
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
  return [...healthRoutes, ...buildRunRoutes(options.runs), ...options.routes];
}
