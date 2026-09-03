/**
 * `http/routes/session-steps` — the read route X11's drill-down UI needs to
 * enumerate a session's plan: `GET /api/v1/sessions/:id/steps`.
 *
 * Its own module rather than another handler in `http/routes/sessions.ts`:
 * that file has limited file-budget headroom and this route's port
 * (`listStepsForSession`) is a distinct collaborator the other nine routes
 * there do not share — same rationale `session-artifacts.ts` and
 * `session-bindings.ts` already state for their own splits.
 *
 * `http/` may never import `sessions/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this module
 * declares its own narrow {@link SessionStepsReaderPort}, mirroring
 * `sessions/service-reads.ts`'s `listStepsForSession` field for field;
 * `main.ts` (via `built-in.ts`) passing the real session service is the
 * compiler-checked proof it conforms.
 *
 * **The route returns each step WITHOUT its `resultRef`** — the real
 * service's `listStepsForSession` already redacts it (a step's `resultRef`
 * can embed the resolved artifact VALUE for an inline artifact), so this
 * route adds no redaction of its own; it just serves what the reader hands
 * back, verbatim, exactly like `session-bindings.ts`'s list route.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status this route returns on success. */
const STATUS_OK = 200;

/**
 * The local step-reading port this module depends on — mirrors
 * `sessions/service-reads.ts`'s `listStepsForSession`, so the real session
 * service satisfies it structurally without an `http -> sessions` import.
 *
 * Deliberately NOT exported: knip flags an exported type with no consumer
 * outside its own module, and every caller reaches it through
 * {@link SessionStepsRouteOptions.reader} without ever naming it.
 *
 * @example
 * ```ts
 * const reader: SessionStepsReaderPort = { listStepsForSession: () => [] };
 * ```
 */
interface SessionStepsReaderPort {
  /** Lists every step recorded for `sessionId`, redacted for a list response; throws for an unknown session. */
  listStepsForSession(sessionId: string): readonly unknown[];
}

/**
 * Constructor options for {@link createSessionStepsRoutes}.
 *
 * @example
 * ```ts
 * const options: SessionStepsRouteOptions = {
 *   reader: { listStepsForSession: () => [] },
 * };
 * ```
 */
export interface SessionStepsRouteOptions {
  /** The step-reading port; `main.ts` passes the real session service. */
  readonly reader: SessionStepsReaderPort;
}

/** Reads `ctx.params[name]`, throwing `ERR_CONSOLE_BAD_REQUEST` when absent. */
function requireParam(ctx: M3LRequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `missing ':${name}' route parameter`,
    );
  }
  return value;
}

/**
 * Builds the `GET /api/v1/sessions/:id/steps` handler: the bare step-summary
 * row array; 404s via the service's own session guard for an unknown id.
 *
 * Synchronous, unlike `session-artifacts.ts`'s handler — the underlying
 * `listStepsForSession` is a plain lookup, never awaited.
 */
function buildListStepsHandler(
  reader: SessionStepsReaderPort,
): M3LConsoleHandler {
  return (ctx) => {
    const id = requireParam(ctx, "id");
    return jsonResponse(STATUS_OK, reader.listStepsForSession(id));
  };
}

/**
 * Builds X11's session-steps route table: the single
 * `GET /api/v1/sessions/:id/steps` route, `auth: "required"` — a console
 * operator only, never an unauthenticated caller.
 *
 * @param options - See {@link SessionStepsRouteOptions}.
 * @returns The one-route table.
 *
 * @example
 * ```ts
 * import { createSessionStepsRoutes } from "@m3l-automation/m3l-console-server/http/routes/session-steps.js";
 *
 * const routes = createSessionStepsRoutes({
 *   reader: { listStepsForSession: () => [] },
 * });
 * ```
 */
export function createSessionStepsRoutes(
  options: SessionStepsRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/sessions/:id/steps",
      auth: "required",
      handler: buildListStepsHandler(options.reader),
    },
  ];
}
