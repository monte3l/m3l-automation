/**
 * `http/routes/session-artifacts` — X7d's step-output read surface:
 * `GET /api/v1/sessions/:id/steps/:stepId/artifact`.
 *
 * Its own module rather than another handler in `http/routes/sessions.ts`:
 * that file sits near `check:file-budget`'s 25,000-char ceiling, and this
 * route has a distinct collaborator (the artifact read port) that the nine
 * session-lifecycle routes do not share.
 *
 * `http/` may never import `sessions/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this module
 * declares its own narrow {@link SessionArtifactReaderPort}, mirroring
 * `sessions/service-reads.ts`'s `readStepArtifact` field for field; `main.ts`
 * passing the real service is the compiler-checked proof it conforms. Same
 * declared-not-imported trick every other route module here uses.
 *
 * **The route returns the artifact's VALUE, and nothing about where it is
 * stored.** An inline artifact and a file-backed one are indistinguishable to
 * a caller, which is the point: the placement decision is
 * `sessions/artifacts.ts`'s, driven by size, and a client that could tell
 * them apart would start depending on it.
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
 * The local artifact-read port this module depends on — mirrors
 * `sessions/service-reads.ts`'s `readStepArtifact`, so the real session
 * service satisfies it structurally without an `http -> sessions` import.
 *
 * Deliberately NOT exported: knip flags an exported type with no consumer
 * outside its own module, and every caller reaches it through
 * {@link SessionArtifactRouteOptions.reader} without ever naming it.
 *
 * @example
 * ```ts
 * const reader: SessionArtifactReaderPort = {
 *   readStepArtifact: () => Promise.resolve({ ok: true }),
 * };
 * ```
 */
interface SessionArtifactReaderPort {
  /** Resolves one step's recorded output artifact; throws for an unknown session/step. */
  readStepArtifact(sessionId: string, stepId: string): Promise<unknown>;
}

/**
 * Constructor options for {@link createSessionArtifactRoutes}.
 *
 * @example
 * ```ts
 * const options: SessionArtifactRouteOptions = {
 *   reader: { readStepArtifact: () => Promise.resolve({ ok: true }) },
 * };
 * ```
 */
export interface SessionArtifactRouteOptions {
  /** The artifact-read port; `main.ts` passes the real session service. */
  readonly reader: SessionArtifactReaderPort;
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
 * Builds the `GET /api/v1/sessions/:id/steps/:stepId/artifact` handler.
 *
 * Every 404 — unknown session, unknown step, a step belonging to another
 * session, a step with no recorded output yet — is raised by the SERVICE, not
 * here. That is deliberate: the ownership check and the not-found check must
 * be indistinguishable to a caller probing step ids, and keeping both on one
 * side of the boundary is what stops a later edit here from splitting them.
 */
function buildReadArtifactHandler(
  reader: SessionArtifactReaderPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const sessionId = requireParam(ctx, "id");
    const stepId = requireParam(ctx, "stepId");
    const value = await reader.readStepArtifact(sessionId, stepId);
    return jsonResponse(STATUS_OK, value);
  };
}

/**
 * Builds X7d's session-artifact route table: the single
 * `GET /api/v1/sessions/:id/steps/:stepId/artifact` route, `auth: "required"`
 * — a console operator only, never an unauthenticated caller.
 *
 * @param options - See {@link SessionArtifactRouteOptions}.
 * @returns The one-route table.
 *
 * @example
 * ```ts
 * import { createSessionArtifactRoutes } from "@m3l-automation/m3l-console-server/http/routes/session-artifacts.js";
 *
 * const routes = createSessionArtifactRoutes({
 *   reader: { readStepArtifact: () => Promise.resolve({ ok: true }) },
 * });
 * ```
 */
export function createSessionArtifactRoutes(
  options: SessionArtifactRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/sessions/:id/steps/:stepId/artifact",
      auth: "required",
      handler: buildReadArtifactHandler(options.reader),
    },
  ];
}
