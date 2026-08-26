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
  /**
   * The HTTP method this route matches. Must be upper-case (`"GET"`, not
   * `"get"`) — {@link createRouter} rejects a lower/mixed-case method at
   * construction time with `ERR_CONSOLE_CONFIG_INVALID` rather than
   * normalizing it, since {@link M3LRouter.lookup} compares case-sensitively
   * and a silently-normalized method would let a typo'd registration match
   * requests its author never intended.
   */
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
 * Throws `ERR_CONSOLE_CONFIG_INVALID` when `route.method` is not already
 * upper-case. {@link M3LRouter.lookup} compares methods case-sensitively, so
 * a lower/mixed-case registration would otherwise silently never match any
 * request and report 405 for every attempt (see {@link M3LRoute.method}).
 */
function assertUpperCaseMethod(route: M3LRoute): void {
  if (route.method === route.method.toUpperCase()) return;
  throw new M3LConsoleError(
    "ERR_CONSOLE_CONFIG_INVALID",
    `route '${route.path}' declares method '${route.method}', which is not upper-case`,
  );
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
 * Whether same-length pattern segment lists `a` and `b` could both match some
 * concrete request path: at every position, either segment is a `:param`
 * (which matches anything) or the two literal segments are identical.
 */
function segmentsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const [aHead, ...aRest] = a;
  const [bHead, ...bRest] = b;
  if (aHead === undefined || bHead === undefined) return true;
  const positionCompatible =
    aHead.startsWith(":") || bHead.startsWith(":") || aHead === bHead;
  return positionCompatible && segmentsOverlap(aRest, bRest);
}

/**
 * Throws `ERR_CONSOLE_ROUTE_CONFLICT` when two routes in `compiled` share a
 * method and a normalized pattern signature (every `:param` collapsed to a
 * single placeholder) — a literal duplicate registration regardless of
 * `auth`.
 */
function detectDuplicateSignatures(compiled: readonly CompiledRoute[]): void {
  const seenSignatures = new Map<string, string>();
  for (const { route, segments } of compiled) {
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

/**
 * Whether compiled routes `a` and `b` share a method and segment count,
 * could both match some concrete request path (see {@link segmentsOverlap}),
 * and declare different {@link M3LRouteAuth} modes.
 */
function overlapsWithDifferentAuth(
  a: CompiledRoute,
  b: CompiledRoute,
): boolean {
  if (a.route.method !== b.route.method) return false;
  if (a.route.auth === b.route.auth) return false;
  if (a.segments.length !== b.segments.length) return false;
  return segmentsOverlap(a.segments, b.segments);
}

/**
 * Throws `ERR_CONSOLE_ROUTE_CONFLICT` for the first pair in `compiled`
 * flagged by {@link overlapsWithDifferentAuth}. Left unresolved, a
 * per-position specificity tie-break would still pick a winner
 * deterministically, but which route's `auth` a given request ends up under
 * would depend on the two patterns' shapes rather than on any declared
 * intent — so this ambiguity class is rejected at construction time instead.
 */
function detectCrossAuthOverlaps(compiled: readonly CompiledRoute[]): void {
  for (let i = 0; i < compiled.length; i += 1) {
    const a = compiled[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < compiled.length; j += 1) {
      const b = compiled[j];
      if (b === undefined || !overlapsWithDifferentAuth(a, b)) continue;
      throw new M3LConsoleError(
        "ERR_CONSOLE_ROUTE_CONFLICT",
        `route '${a.route.path}' and route '${b.route.path}' both match some request path for method ${a.route.method} but declare different auth modes`,
      );
    }
  }
}

/**
 * Throws `ERR_CONSOLE_ROUTE_CONFLICT` for a literal duplicate pattern, a
 * duplicated `:param` name within one pattern, or an overlap between two
 * differently-`auth`ed routes.
 */
function detectConflicts(compiled: readonly CompiledRoute[]): void {
  for (const { route, segments } of compiled) {
    assertUpperCaseMethod(route);
    assertNoDuplicateParamNames(route, segments);
  }
  detectDuplicateSignatures(compiled);
  detectCrossAuthOverlaps(compiled);
}

/** Decodes every segment, surfacing a malformed percent-escape as a typed error. */
function decodeSegments(segments: readonly string[]): readonly string[] {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch (cause) {
      // Deliberately does not echo `segment`: this message reaches the
      // response body via the error envelope, and the offending path
      // segment is untrusted input on a surface a browser frontend shares
      // an origin with.
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "malformed percent-escape in request path",
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

/**
 * Compares two same-length segment lists position by position: negative when
 * `a` is more specific than `b` (a static segment beats a `:param` segment
 * at the first position where they differ), positive when `b` is more
 * specific, zero when every position ties.
 */
function compareSpecificity(
  a: readonly string[],
  b: readonly string[],
): number {
  const [aHead, ...aRest] = a;
  const [bHead, ...bRest] = b;
  if (aHead === undefined || bHead === undefined) return 0;
  const aIsParam = aHead.startsWith(":");
  const bIsParam = bHead.startsWith(":");
  if (aIsParam !== bIsParam) return aIsParam ? 1 : -1;
  return compareSpecificity(aRest, bRest);
}

/**
 * Picks the most specific candidate among structural matches: static beats
 * param at the first differing position (see {@link compareSpecificity}),
 * not by total param count — two patterns with a static segment at
 * different positions (`/a/:x/c` vs `/a/b/:y`) are resolved deterministically
 * rather than falling back to registration order.
 */
function pickBestMatch(candidates: readonly CompiledRoute[]): CompiledRoute {
  return candidates.reduce((best, candidate) =>
    compareSpecificity(candidate.segments, best.segments) < 0
      ? candidate
      : best,
  );
}

/** Collects `[name, value]` pairs for every `:param` segment in `patternSegments`, positionally decoded from `requestSegments`. */
function collectParamEntries(
  patternSegments: readonly string[],
  requestSegments: readonly string[],
): readonly (readonly [string, string])[] {
  const [patternHead, ...patternRest] = patternSegments;
  const [requestHead, ...requestRest] = requestSegments;
  if (patternHead === undefined || requestHead === undefined) return [];
  const rest = collectParamEntries(patternRest, requestRest);
  if (!patternHead.startsWith(":")) return rest;
  return [[patternHead.slice(1), requestHead], ...rest];
}

/**
 * Extracts captured `:param` values, decoded, keyed by param name, into a
 * frozen, `null`-prototype object — so a handler indexing `params` by a
 * request-derived key (e.g. `params[untrustedKey]`) can never read an
 * inherited `Object.prototype` property.
 */
function extractParams(
  patternSegments: readonly string[],
  requestSegments: readonly string[],
): Readonly<Record<string, string>> {
  const params: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of collectParamEntries(
    patternSegments,
    requestSegments,
  )) {
    params[name] = value;
  }
  return Object.freeze(params);
}

/**
 * Builds an {@link M3LRouter} over `routes`, detecting conflicts at
 * construction time.
 *
 * @param routes - The routes to register.
 * @returns The compiled router.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when a route's `method` is not upper-case, or with code
 *   `"ERR_CONSOLE_ROUTE_CONFLICT"` when two routes with the same method
 *   normalize to the same pattern, or a single route declares the same
 *   `:param` name more than once.
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
