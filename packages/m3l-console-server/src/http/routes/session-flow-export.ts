/**
 * `http/routes/session-flow-export` — `POST /api/v1/sessions/:id/flow-export`
 * (X13 session-flow-export module, issue #561, PR 5/6, Round B): validates
 * the caller's requested flow name/description/overwrite flag, then
 * delegates to the session service's `exportFlow`.
 *
 * Its own file, mirroring `http/routes/session-bindings.ts`'s own precedent
 * for a single-resource write route: `http/routes/sessions.ts` has no
 * headroom left under ADR-0072's file-budget ceiling for a new route's full
 * case matrix.
 *
 * `http/` may never import `sessions/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this
 * module declares its own narrow local port ({@link SessionFlowExportWriterPort})
 * mirroring `sessions/service-flow-export.ts`'s `SessionFlowExportMethods`
 * field for field, the same declared-not-imported trick every sibling route
 * module uses.
 *
 * Every reference/name/collision decision belongs to the writer, propagated
 * unchanged: an unknown session, an empty session, a secret parameter, an
 * existing target file. This handler validates only the body's shape.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

import {
  readOptionalBoolean,
  readOptionalNonEmptyString,
  readRequiredNonEmptyString,
  rejectBody,
} from "./session-body.js";

/** The status this route returns on a successful export — it creates a flow file, like every other creating POST in this package. */
const STATUS_CREATED = 201;

/** One validated `POST …/flow-export` request body. */
interface M3LSessionFlowExportRequestBody {
  readonly name: string;
  readonly description?: string;
  readonly overwrite: boolean;
}

/**
 * The local writer port this module depends on — mirrors
 * `sessions/service-flow-export.ts`'s `SessionFlowExportMethods.exportFlow`
 * field for field, so the real session service satisfies it structurally
 * without an `http -> sessions` import.
 *
 * @example
 * ```ts
 * const writer: SessionFlowExportWriterPort = {
 *   exportFlow: () =>
 *     Promise.resolve({
 *       name: "dlq-reconcile",
 *       yaml: "name: dlq-reconcile\nsteps: []\n",
 *       steps: [],
 *       decisionsDropped: 0,
 *       path: "/data/config/flows/dlq-reconcile.yaml",
 *     }),
 * };
 * ```
 */
interface SessionFlowExportWriterPort {
  /** Composes and writes `sessionId`'s exported flow document; throws propagated unchanged from the real session service. */
  exportFlow(sessionId: string, request: unknown): Promise<unknown>;
}

/**
 * Constructor options for {@link createSessionFlowExportRoutes}.
 *
 * @example
 * ```ts
 * const options: SessionFlowExportRouteOptions = {
 *   writer: {
 *     exportFlow: () =>
 *       Promise.resolve({
 *         name: "dlq-reconcile",
 *         yaml: "name: dlq-reconcile\nsteps: []\n",
 *         steps: [],
 *         decisionsDropped: 0,
 *         path: "/data/config/flows/dlq-reconcile.yaml",
 *       }),
 *   },
 * };
 * ```
 */
export interface SessionFlowExportRouteOptions {
  /** The flow-export-writing port; `main.ts` passes the real session service. */
  readonly writer: SessionFlowExportWriterPort;
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
 * Validates an untrusted `rawBody` into a closed
 * {@link M3LSessionFlowExportRequestBody}. `description` is omitted from the
 * result entirely when absent — never set to `undefined` — matching
 * `sessions/flow-export.ts`'s own `buildSessionFlowExport` conditional-spread
 * convention, so the writer sees the identical "was a description supplied"
 * shape whether the request reaches it through this route or directly.
 */
function parseFlowExportBody(
  rawBody: unknown,
): M3LSessionFlowExportRequestBody {
  if (!Core.isPlainObject(rawBody)) {
    rejectBody("body", "must be a JSON object");
  }
  const name = readRequiredNonEmptyString(rawBody, "name");
  const description = readOptionalNonEmptyString(rawBody, "description");
  const overwrite = readOptionalBoolean(rawBody, "overwrite") ?? false;
  return {
    name,
    ...(description !== undefined && { description }),
    overwrite,
  };
}

/**
 * Builds the `POST /api/v1/sessions/:id/flow-export` handler: validates the
 * body at the boundary (before the writer is ever called), then awaits the
 * write.
 */
function buildExportFlowHandler(
  writer: SessionFlowExportWriterPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const sessionId = requireParam(ctx, "id");
    const body = parseFlowExportBody(ctx.body);
    const result = await writer.exportFlow(sessionId, body);
    return jsonResponse(STATUS_CREATED, result);
  };
}

/**
 * Builds the X13 session-flow-export route table: the single
 * `POST /api/v1/sessions/:id/flow-export` route, `auth: "required"` — a
 * console operator only, never an unauthenticated caller.
 *
 * @param options - See {@link SessionFlowExportRouteOptions}.
 * @returns The one-route table.
 *
 * @example
 * ```ts
 * import { createSessionFlowExportRoutes } from "@m3l-automation/m3l-console-server/http/routes/session-flow-export.js";
 *
 * const routes = createSessionFlowExportRoutes({
 *   writer: {
 *     exportFlow: () =>
 *       Promise.resolve({
 *         name: "dlq-reconcile",
 *         yaml: "name: dlq-reconcile\nsteps: []\n",
 *         steps: [],
 *         decisionsDropped: 0,
 *         path: "/data/config/flows/dlq-reconcile.yaml",
 *       }),
 *   },
 * });
 * ```
 */
export function createSessionFlowExportRoutes(
  options: SessionFlowExportRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "POST",
      path: "/api/v1/sessions/:id/flow-export",
      auth: "required",
      handler: buildExportFlowHandler(options.writer),
    },
  ];
}
