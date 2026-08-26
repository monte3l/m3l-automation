/**
 * `http/router` — the internal request router (ADR-0065): construction-time
 * conflict detection plus per-request path matching, with static segments
 * always winning over a `:param` segment at the same position.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LConsoleHandler } from "./middleware.js";

/** The placeholder every `:param` segment normalizes to for conflict detection. */
const PARAM_PLACEHOLDER = ":param";

/**
 * Whether a request must be authenticated to reach a route. Route data, not
 * a hard-coded path list — this is how a future exempt path (e.g. a health
 * check) becomes the only source of truth for "which paths skip auth".
 *
 * @example
 * ```ts
 * const auth: M3LRouteAuth = "exempt";
 * ```
 */
export type M3LRouteAuth = "required" | "exempt";

/**
 * A single registered route: an upper-case HTTP method, an Express-style
 * path pattern (`:name` segments capture), whether it requires
 * authentication, and its terminal handler.
 *
 * @example
 * ```ts
 * const route: M3LRoute = {
 *   method: "GET",
 *   path: "/api/v1/runs/:id",
 *   auth: "required",
 *   handler: (ctx) => ({ status: 200, headers: {}, body: ctx.params["id"] ?? "" }),
 * };
 * ```
 */
export interface M3LRoute {
  /** The HTTP method this route matches, upper-case. */
  readonly method: string;
  /** The path pattern, e.g. `"/api/v1/runs/:id"`. */
  readonly path: string;
  /** Whether a request must be authenticated to reach this route. */
  readonly auth: M3LRouteAuth;
  /** The route's terminal handler. */
  readonly handler: M3LConsoleHandler;
}

/**
 * The outcome of {@link M3LRouter.lookup}: either a matched route with its
 * captured params, a method mismatch on an otherwise-known path (carrying
 * the allowed method set for an `Allow` header), or no match at all.
 *
 * @example
 * ```ts
 * function describe(result: M3LRouteLookup): string {
 *   return result.outcome;
 * }
 * ```
 */
export type M3LRouteLookup =
  | {
      readonly outcome: "matched";
      readonly route: M3LRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly outcome: "method-not-allowed";
      readonly allowed: readonly string[];
    }
  | { readonly outcome: "not-found" };

/**
 * The compiled router built by {@link createRouter}: the registered routes
 * verbatim, plus a `lookup` that resolves a method/path pair to a
 * {@link M3LRouteLookup}.
 *
 * @example
 * ```ts
 * function countRoutes(router: M3LRouter): number {
 *   return router.routes.length;
 * }
 * ```
 */
export interface M3LRouter {
  /** The routes this router was constructed with, verbatim. */
  readonly routes: readonly M3LRoute[];
  /**
   * Resolves `method`/`path` to a {@link M3LRouteLookup}.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `path` contains a malformed percent-escape.
   */
  lookup(method: string, path: string): M3LRouteLookup;
}

/** A route compiled into its path pattern's segments, for matching. */
interface CompiledRoute {
  readonly route: M3LRoute;
  readonly segments: readonly string[];
}

/** Splits a path into its non-empty segments. */
function splitPath(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Normalizes a pattern's segments to their conflict-detection signature. */
function toPatternSignature(segments: readonly string[]): string {
  return segments
    .map((segment) => (segment.startsWith(":") ? PARAM_PLACEHOLDER : segment))
    .join("/");
}

/**
 * Throws `ERR_CONSOLE_ROUTE_CONFLICT` when `segments` declares the same
 * `:name` parameter more than once.
 */
function assertNoDuplicateParamNames(
  route: M3LRoute,
  segments: readonly string[],
): void {
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!segment.startsWith(":")) continue;
    const name = segment.slice(1);
    if (seen.has(name)) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_ROUTE_CONFLICT",
        `route '${route.path}' declares the parameter ':${name}' more than once`,
      );
    }
    seen.add(name);
  }
}

/**
 * Throws `ERR_CONSOLE_ROUTE_CONFLICT` when two routes in `compiled` share a
 * method and a normalized pattern signature (every `:param` collapsed to a
 * single placeholder).
 */
function detectConflicts(compiled: readonly CompiledRoute[]): void {
  const seenSignatures = new Map<string, string>();
  for (const { route, segments } of compiled) {
    assertNoDuplicateParamNames(route, segments);
    const signature = `${route.method} ${toPatternSignature(segments)}`;
    const existingPath = seenSignatures.get(signature);
    if (existingPath !== undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_ROUTE_CONFLICT",
        `route '${route.path}' conflicts with existing route '${existingPath}' for method ${route.method}`,
      );
    }
    seenSignatures.set(signature, route.path);
  }
}

/** Decodes every segment, surfacing a malformed percent-escape as a typed error. */
function decodeSegments(segments: readonly string[]): readonly string[] {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch (cause) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        `malformed percent-escape in path segment '${segment}'`,
        { cause },
      );
    }
  });
}

/**
 * Whether `patternSegments` structurally matches `requestSegments` of the
 * same length: a `:param` segment matches anything, a literal segment must
 * match case-sensitively.
 */
function matchesStructure(
  patternSegments: readonly string[],
  requestSegments: readonly string[],
): boolean {
  const [patternHead, ...patternRest] = patternSegments;
  if (patternHead === undefined) return true;
  const [requestHead, ...requestRest] = requestSegments;
  return (
    (patternHead.startsWith(":") || patternHead === requestHead) &&
    matchesStructure(patternRest, requestRest)
  );
}

/** Counts the `:param` segments in `segments` — fewer wins a match (static beats param). */
function paramCount(segments: readonly string[]): number {
  return segments.filter((segment) => segment.startsWith(":")).length;
}

/** Picks the most specific (fewest params) candidate among structural matches. */
function pickBestMatch(candidates: readonly CompiledRoute[]): CompiledRoute {
  return candidates.reduce((best, candidate) =>
    paramCount(candidate.segments) < paramCount(best.segments)
      ? candidate
      : best,
  );
}

/** Extracts captured `:param` values, decoded, keyed by param name. */
function extractParams(
  patternSegments: readonly string[],
  requestSegments: readonly string[],
): Readonly<Record<string, string>> {
  const [patternHead, ...patternRest] = patternSegments;
  const [requestHead, ...requestRest] = requestSegments;
  if (patternHead === undefined || requestHead === undefined) return {};
  const rest = extractParams(patternRest, requestRest);
  if (!patternHead.startsWith(":")) return rest;
  return { ...rest, [patternHead.slice(1)]: requestHead };
}

/**
 * Builds an {@link M3LRouter} over `routes`, detecting conflicts at
 * construction time.
 *
 * @param routes - The routes to register.
 * @returns The compiled router.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_ROUTE_CONFLICT"`
 *   when two routes with the same method normalize to the same pattern, or
 *   a single route declares the same `:param` name more than once.
 *
 * @example
 * ```ts
 * const router = createRouter([
 *   {
 *     method: "GET",
 *     path: "/api/v1/runs/:id",
 *     auth: "required",
 *     handler: (ctx) => ({ status: 200, headers: {}, body: ctx.params["id"] ?? "" }),
 *   },
 * ]);
 * router.lookup("GET", "/api/v1/runs/42");
 * ```
 */
export function createRouter(routes: readonly M3LRoute[]): M3LRouter {
  const compiled: readonly CompiledRoute[] = routes.map((route) => ({
    route,
    segments: splitPath(route.path),
  }));
  detectConflicts(compiled);

  function lookup(method: string, path: string): M3LRouteLookup {
    const requestSegments = decodeSegments(splitPath(path));
    const structuralMatches = compiled.filter(
      (candidate) =>
        candidate.segments.length === requestSegments.length &&
        matchesStructure(candidate.segments, requestSegments),
    );
    if (structuralMatches.length === 0) {
      return { outcome: "not-found" };
    }

    const methodMatches = structuralMatches.filter(
      (candidate) => candidate.route.method === method,
    );
    if (methodMatches.length === 0) {
      const allowed = [
        ...new Set(
          structuralMatches.map((candidate) => candidate.route.method),
        ),
      ].sort();
      return { outcome: "method-not-allowed", allowed };
    }

    const best = pickBestMatch(methodMatches);
    return {
      outcome: "matched",
      route: best.route,
      params: extractParams(best.segments, requestSegments),
    };
  }

  return { routes, lookup };
}
