import { useCallback, useEffect, useState } from "react";

/**
 * The console SPA's routes, addressed purely through `location.hash` — no
 * router dependency (ADR-0067's thin-stack policy).
 */
export type M3LRoute =
  | { readonly kind: "scripts" }
  | { readonly kind: "script"; readonly name: string }
  | { readonly kind: "runs" }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "session"; readonly id: string };

const SCRIPTS_ROUTE: M3LRoute = { kind: "scripts" };

/** Anchored kebab-case pattern the console server enforces for script names. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Segments a route like `#/scripts/:name` or `#/runs/:id` splits into once
 * the leading "#/" is stripped: `[resource, subject]`. A third segment
 * (e.g. "#/runs/abc/def") is never a valid `:id`/`:name` path.
 */
const MAX_ROUTE_SEGMENTS = 2;

function decodeSegmentOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape (e.g. "%ZZ") throws in decodeURIComponent — treat
    // it the same as any other unrecognised route rather than propagating.
    return null;
  }
}

function parseScriptRoute(rawName: string): M3LRoute {
  const name = decodeSegmentOrNull(rawName);
  if (name === null || !NAME_PATTERN.test(name)) {
    return SCRIPTS_ROUTE;
  }
  return { kind: "script", name };
}

function parseRunRoute(rawId: string): M3LRoute {
  const id = decodeSegmentOrNull(rawId);
  if (id === null || id.length === 0 || id.includes("/")) {
    return SCRIPTS_ROUTE;
  }
  return { kind: "run", id };
}

function parseSessionRoute(rawId: string): M3LRoute {
  const id = decodeSegmentOrNull(rawId);
  if (id === null || id.length === 0 || id.includes("/")) {
    return SCRIPTS_ROUTE;
  }
  return { kind: "session", id };
}

/**
 * Resolves a `:id`-style resource (`runs`/`sessions`) once `resource` has
 * already been matched — shared by both branches in {@link parseHashRoute}
 * purely to keep that function's cyclomatic/cognitive complexity down, since
 * `runs` and `sessions` follow the identical list-vs-item shape.
 */
function parseIdResourceRoute(
  listRoute: M3LRoute,
  segments: readonly string[],
  subject: string | undefined,
  parseItemRoute: (rawId: string) => M3LRoute,
): M3LRoute {
  if (subject === undefined) {
    return listRoute;
  }
  if (segments.length > MAX_ROUTE_SEGMENTS) {
    // An extra segment (e.g. "#/runs/abc/def") is not a valid :id path.
    return SCRIPTS_ROUTE;
  }
  return parseItemRoute(subject);
}

/**
 * Parses a `location.hash` value into a {@link M3LRoute}, pure and exported
 * separately from {@link useHashRoute} so it is testable without a DOM.
 *
 * Grammar: `#/scripts`, `#/scripts/:name`, `#/runs`, `#/runs/:id`,
 * `#/sessions`, `#/sessions/:id`. Anything else — an empty hash, `#`, `#/`,
 * an unrecognised path, or a segment that fails validation — falls back to
 * the scripts route rather than throwing.
 *
 * @example
 * ```ts
 * import { parseHashRoute } from "@m3l-automation/m3l-console-web/routing/useHashRoute.js";
 *
 * parseHashRoute("#/scripts/json-etl");
 * // => { kind: "script", name: "json-etl" }
 * ```
 */
export function parseHashRoute(hash: string): M3LRoute {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!withoutHash.startsWith("/")) {
    // Covers "" and "#" (which strip down to ""), and anything not shaped
    // like a path at all (e.g. "#nope").
    return SCRIPTS_ROUTE;
  }

  // Deliberately NOT filtering empty segments: "#/runs/" must parse
  // differently from "#/runs" (an empty :id segment is invalid and falls
  // back, whereas a bare "#/runs" is the valid list route).
  const segments = withoutHash.slice(1).split("/");
  const [resource, subject] = segments;

  if (resource === "scripts") {
    if (subject === undefined) {
      return SCRIPTS_ROUTE;
    }
    if (segments.length > MAX_ROUTE_SEGMENTS) {
      return SCRIPTS_ROUTE;
    }
    return parseScriptRoute(subject);
  }
  if (resource === "runs") {
    return parseIdResourceRoute(
      { kind: "runs" },
      segments,
      subject,
      parseRunRoute,
    );
  }
  if (resource === "sessions") {
    return parseIdResourceRoute(
      { kind: "sessions" },
      segments,
      subject,
      parseSessionRoute,
    );
  }

  return SCRIPTS_ROUTE;
}

/**
 * Serialises a {@link M3LRoute} back into a `location.hash` value.
 *
 * @example
 * ```ts
 * import { routeToHash } from "@m3l-automation/m3l-console-web/routing/useHashRoute.js";
 *
 * routeToHash({ kind: "run", id: "abc-123" }); // => "#/runs/abc-123"
 * ```
 */
export function routeToHash(route: M3LRoute): string {
  switch (route.kind) {
    case "scripts":
      return "#/scripts";
    case "script":
      return `#/scripts/${encodeURIComponent(route.name)}`;
    case "runs":
      return "#/runs";
    case "run":
      return `#/runs/${encodeURIComponent(route.id)}`;
    case "sessions":
      return "#/sessions";
    case "session":
      return `#/sessions/${encodeURIComponent(route.id)}`;
  }
}

/**
 * Subscribes to `location.hash` and exposes the parsed {@link M3LRoute}
 * alongside a `navigate` function. The `hashchange` listener is the single
 * source of truth for `route` — `navigate` only sets `location.hash` (via
 * {@link routeToHash}) and never touches state directly, so every route
 * change (whether from `navigate`, the browser back/forward buttons, or a
 * hand-edited URL) flows through the same code path.
 *
 * @example
 * ```tsx
 * import { useHashRoute } from "@m3l-automation/m3l-console-web/routing/useHashRoute.js";
 *
 * function App(): JSX.Element {
 *   const { route, navigate } = useHashRoute();
 *   return (
 *     <button onClick={() => navigate({ kind: "runs" })}>
 *       Current: {route.kind}
 *     </button>
 *   );
 * }
 * ```
 */
export function useHashRoute(): {
  readonly route: M3LRoute;
  readonly navigate: (route: M3LRoute) => void;
} {
  const [route, setRoute] = useState<M3LRoute>(() =>
    parseHashRoute(window.location.hash),
  );

  useEffect(() => {
    const handleHashChange = (): void => {
      setRoute(parseHashRoute(window.location.hash));
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const navigate = useCallback((next: M3LRoute): void => {
    window.location.hash = routeToHash(next);
  }, []);

  return { route, navigate };
}
