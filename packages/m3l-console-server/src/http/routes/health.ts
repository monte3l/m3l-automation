/**
 * `http/routes/health` — the liveness/readiness routes every deployment
 * orchestrator (ADR-0071 runs the console behind Docker Compose) polls
 * before trusting the process.
 *
 * `/health` and `/ready` answer two DIFFERENT questions, and conflating
 * them breaks graceful shutdown: `/health` is liveness — "is the process
 * still alive and able to answer at all" — and stays 200 for the entire
 * life of the process, including while draining. An orchestrator that sees
 * liveness fail assumes the process is wedged and kills it immediately,
 * which is the exact opposite of what a graceful drain is trying to
 * achieve. `/ready` is readiness — "should traffic still be routed here" —
 * and flips to a 503 `{ status: "draining" }` once `drain.state` leaves
 * `"serving"`.
 *
 * The "stays 200 while draining" guarantee holds through the FULL composed
 * request listener, not merely at this module's own handler: `main.ts`
 * places `createDrainMiddleware` in its `middlewares` chain (which skips an
 * `auth: "exempt"` route) rather than `preRouting` (which runs before
 * routing and cannot tell an exempt route from any other), specifically so
 * a drain refusal can never intercept this route ahead of its handler. See
 * `http/drain-middleware.ts`'s TSDoc for the full rationale.
 *
 * With today's shutdown ordering — `drain()` then `server.close()`, run
 * back to back in `main.ts`'s `runShutdownSequence` — a client normally
 * does not see that 503 body. `close()` sweeps idle connections at the
 * moment it is called, so a request racing the drain gets a connection
 * error instead of a response: measured on Node v26.7.0, both a brand-new
 * connection and an idle keep-alive socket are reset during drain rather
 * than answered. An orchestrator treats a connection error as not-ready
 * anyway, so the operational outcome — stop routing here — is unchanged;
 * only the wire-level signal differs from what this handler returns.
 * Making the 503 itself observable needs a readiness grace period between
 * the drain starting and the listener closing. That belongs to X12's
 * compose health wiring (ADR-0071), not here — this module deliberately
 * does not implement it, so a future reader does not "fix" the shutdown
 * ordering without understanding the trade-off.
 *
 * Both routes are `auth: "exempt"`: a liveness/readiness probe has no
 * operator session and must never be gated on one.
 *
 * @packageDocumentation
 */

import type { M3LDrainController } from "../../lifecycle/drain.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status {@link createHealthRoutes}'s `/ready` route returns while draining. */
const STATUS_SERVICE_UNAVAILABLE = 503;
/** The status both routes return whenever they are not reporting `"draining"`. */
const STATUS_OK = 200;

/**
 * Constructor options for {@link createHealthRoutes}.
 *
 * @example
 * ```ts
 * const options: HealthRouteOptions = {
 *   drain: createDrainController({ timeoutMs: 15_000 }),
 *   startedAt: Date.now(),
 * };
 * ```
 */
export interface HealthRouteOptions {
  /** The drain controller `/ready` reads `state` from. */
  readonly drain: M3LDrainController;
  /** The timestamp (`Date.now()`-shaped) the process started at. */
  readonly startedAt: number;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Builds the `GET /health` handler: always 200 `{ status: "ok", uptimeMs }`,
 * regardless of {@link M3LDrainController.state} — see this module's doc for
 * why liveness must never flip during a drain.
 */
function buildHealthHandler(options: HealthRouteOptions): M3LConsoleHandler {
  const now = options.now ?? Date.now;
  return () =>
    jsonResponse(STATUS_OK, {
      status: "ok",
      uptimeMs: now() - options.startedAt,
    });
}

/**
 * Builds the `GET /ready` handler: 200 `{ status: "ready", uptimeMs }` while
 * `drain.state === "serving"`, otherwise a plain 503 `{ status: "draining" }`
 * response — never a thrown `ERR_CONSOLE_UNAVAILABLE`. A readiness signal is
 * a normal, expected outcome once a shutdown has begun, not an error
 * condition; throwing here would put an error envelope where a status
 * document belongs, and would emit a spurious fault diagnostic for every
 * readiness poll during an ordinary drain.
 */
function buildReadyHandler(options: HealthRouteOptions): M3LConsoleHandler {
  const now = options.now ?? Date.now;
  return () => {
    if (options.drain.state === "serving") {
      return jsonResponse(STATUS_OK, {
        status: "ready",
        uptimeMs: now() - options.startedAt,
      });
    }
    return jsonResponse(STATUS_SERVICE_UNAVAILABLE, { status: "draining" });
  };
}

/**
 * Builds the console server's health-check route table: `GET /health`
 * (liveness) and `GET /ready` (readiness), both `auth: "exempt"`.
 *
 * Neither response body ever carries the operator's name or email, the
 * bind host or port, or a version string — a pre-auth endpoint reachable by
 * anything that can open a TCP connection is not a posture-disclosure
 * surface, and every field beyond a bare status/uptime would leak
 * information to an unauthenticated caller for no operational benefit.
 *
 * @param options - See {@link HealthRouteOptions}.
 * @returns The two-route table, ready to register ahead of every other
 *   route (see `main.ts`'s composition).
 *
 * @example
 * ```ts
 * import { createDrainController } from "@m3l-automation/m3l-console-server/lifecycle/drain.js";
 * import { createHealthRoutes } from "@m3l-automation/m3l-console-server/http/routes/health.js";
 *
 * const drain = createDrainController({ timeoutMs: 15_000 });
 * const routes = createHealthRoutes({ drain, startedAt: Date.now() });
 * ```
 */
export function createHealthRoutes(
  options: HealthRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/health",
      auth: "exempt",
      handler: buildHealthHandler(options),
    },
    {
      method: "GET",
      path: "/ready",
      auth: "exempt",
      handler: buildReadyHandler(options),
    },
  ];
}
