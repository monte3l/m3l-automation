/**
 * `http/routes/scripts` — X10b's console-server script-discovery REST
 * surface: `GET /api/v1/scripts` to list every launchable script, and
 * `GET /api/v1/scripts/:name` to read one script's full descriptor detail.
 *
 * `http/` may never import `runs/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this
 * module declares its own narrow local port ({@link M3LScriptCatalogPort}),
 * mirroring `runs/descriptors.ts`'s `M3LScriptCatalog.list`/`.describe`
 * field for field — the same declared-not-imported trick
 * `http/routes/runs.ts`'s `M3LRunLauncherPort`/`M3LRunReaderPort` use.
 * `http/routes/built-in.ts` wiring the real `M3LScriptCatalog` in is the
 * compiler-checked proof that it conforms structurally.
 *
 * `:name`'s validation is a THIRD verbatim duplication of
 * `runs/parameters.ts`'s `SCRIPT_NAME_PATTERN`, for the same zone reason
 * `http/routes/runs.ts` documents for its own (second) copy — see this
 * module's own {@link SCRIPT_ROUTE_NAME_PATTERN}.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status both routes in this module return on success. */
const STATUS_OK = 200;

/** The longest caller-supplied `:name` value ever echoed into a rejection message. */
const MAX_ECHOED_NAME_LENGTH = 32;

/**
 * The pattern a valid script `:name` must match — duplicated verbatim from
 * `runs/parameters.ts`'s `SCRIPT_NAME_PATTERN` (`http/` may not import
 * `runs/`; see this module's own TSDoc). Exported so
 * `tests/routes-scripts.test.ts` can drift-guard all three copies
 * (`runs/parameters.ts`, `http/routes/runs.ts`'s own `SCRIPT_NAME_PATTERN`,
 * and this one) against each other.
 *
 * @example
 * ```ts
 * import { SCRIPT_ROUTE_NAME_PATTERN } from "@m3l-automation/m3l-console-server/http/routes/scripts.js";
 *
 * SCRIPT_ROUTE_NAME_PATTERN.test("sqs-etl"); // true
 * ```
 */
export const SCRIPT_ROUTE_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]*$/;

/**
 * The local catalog port this module depends on — mirrors
 * `runs/descriptors.ts`'s `M3LScriptCatalog.list`/`.describe` field for
 * field, so the real catalog satisfies it structurally without an
 * `http -> runs` import.
 *
 * @example
 * ```ts
 * const catalog: M3LScriptCatalogPort = {
 *   list: () => [],
 *   describe: (name) => Promise.resolve({ name }),
 * };
 * ```
 */
export interface M3LScriptCatalogPort {
  /** Lists every launchable script's summary. */
  list(): readonly unknown[];
  /** Reads one script's full descriptor detail by name. */
  describe(name: string): Promise<unknown>;
}

/**
 * Constructor options for {@link createScriptRoutes}.
 *
 * @example
 * ```ts
 * const options: ScriptRouteOptions = {
 *   catalog: { list: () => [], describe: (name) => Promise.resolve({ name }) },
 * };
 * ```
 */
export interface ScriptRouteOptions {
  /** The script-catalog port; `http/routes/built-in.ts` passes the real `M3LScriptCatalog`. */
  readonly catalog: M3LScriptCatalogPort;
}

/** Truncates `name` to {@link MAX_ECHOED_NAME_LENGTH} characters before it is echoed into a message. */
function truncateForEcho(name: string): string {
  return name.slice(0, MAX_ECHOED_NAME_LENGTH);
}

/**
 * Validates `ctx.params["name"]` at the HTTP boundary, before the catalog
 * port is ever called — a traversal attempt, an absolute path, or a NUL
 * byte is rejected here, even if the catalog implementation were swapped.
 */
function readScriptName(ctx: M3LRequestContext): string {
  const name = ctx.params["name"];
  if (name === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "missing ':name' route parameter",
    );
  }
  if (!SCRIPT_ROUTE_NAME_PATTERN.test(name)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid script name: '${truncateForEcho(name)}' must be a kebab-case identifier`,
    );
  }
  return name;
}

/** Builds the `GET /api/v1/scripts` handler: `catalog.list()`'s result, verbatim, as a bare JSON array. */
function buildListHandler(catalog: M3LScriptCatalogPort): M3LConsoleHandler {
  return () => jsonResponse(STATUS_OK, catalog.list());
}

/**
 * Builds the `GET /api/v1/scripts/:name` handler: validates `:name` before
 * ever calling `catalog.describe`, then returns its awaited result.
 */
function buildDescribeHandler(
  catalog: M3LScriptCatalogPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const name = readScriptName(ctx);
    const detail = await catalog.describe(name);
    return jsonResponse(STATUS_OK, detail);
  };
}

/**
 * Builds X10b's console-server script-discovery REST route table:
 * `GET /api/v1/scripts` and `GET /api/v1/scripts/:name`, both
 * `auth: "required"` — a console operator only, never an unauthenticated
 * caller.
 *
 * @param options - See {@link ScriptRouteOptions}.
 * @returns The two-route table.
 *
 * @example
 * ```ts
 * import { createScriptRoutes } from "@m3l-automation/m3l-console-server/http/routes/scripts.js";
 *
 * const routes = createScriptRoutes({
 *   catalog: { list: () => [], describe: (name) => Promise.resolve({ name }) },
 * });
 * ```
 */
export function createScriptRoutes(
  options: ScriptRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/scripts",
      auth: "required",
      handler: buildListHandler(options.catalog),
    },
    {
      method: "GET",
      path: "/api/v1/scripts/:name",
      auth: "required",
      handler: buildDescribeHandler(options.catalog),
    },
  ];
}
