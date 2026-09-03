import type { ReactElement, ReactNode } from "react";

import type { M3LRoute } from "../routing/useHashRoute.js";

/** Props accepted by {@link AppShell}. */
export interface AppShellProps {
  /** The currently active route, used to highlight the matching nav link. */
  readonly route: M3LRoute;
  /** Navigates to a new route, typically via {@link useHashRoute}'s `navigate`. */
  readonly navigate: (route: M3LRoute) => void;
  /** The page content to render inside the shell. */
  readonly children: ReactNode;
}

function isScriptsRoute(route: M3LRoute): boolean {
  return route.kind === "scripts" || route.kind === "script";
}

function isRunsRoute(route: M3LRoute): boolean {
  return route.kind === "runs" || route.kind === "run";
}

function isSessionsRoute(route: M3LRoute): boolean {
  return route.kind === "sessions" || route.kind === "session";
}

/**
 * The console's page shell: a top nav (Scripts / Runs / Sessions) plus the
 * routed page content. The active nav link carries `aria-current="page"`, derived from
 * `route` rather than tracked separately, so it can never drift out of sync
 * with the route the app is actually displaying.
 *
 * @example
 * ```tsx
 * import { AppShell } from "@m3l-automation/m3l-console-web/components/AppShell.js";
 *
 * <AppShell route={{ kind: "scripts" }} navigate={(route) => console.log(route)}>
 *   <p>routed content</p>
 * </AppShell>;
 * ```
 */
export function AppShell(props: AppShellProps): ReactElement {
  const scriptsActive = isScriptsRoute(props.route);
  const runsActive = isRunsRoute(props.route);
  const sessionsActive = isSessionsRoute(props.route);

  return (
    <div data-testid="app-shell">
      <nav>
        <button
          type="button"
          data-testid="nav-scripts"
          onClick={() => {
            props.navigate({ kind: "scripts" });
          }}
          {...(scriptsActive ? { "aria-current": "page" as const } : {})}
        >
          Scripts
        </button>
        <button
          type="button"
          data-testid="nav-runs"
          onClick={() => {
            props.navigate({ kind: "runs" });
          }}
          {...(runsActive ? { "aria-current": "page" as const } : {})}
        >
          Runs
        </button>
        <button
          type="button"
          data-testid="nav-sessions"
          onClick={() => {
            props.navigate({ kind: "sessions" });
          }}
          {...(sessionsActive ? { "aria-current": "page" as const } : {})}
        >
          Sessions
        </button>
      </nav>
      <div>{props.children}</div>
    </div>
  );
}
