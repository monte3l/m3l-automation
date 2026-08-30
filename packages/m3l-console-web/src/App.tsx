import type { ReactElement } from "react";

import { AppShell } from "./components/AppShell.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { HealthBanner } from "./components/HealthBanner.js";
import { RunDetail } from "./components/RunDetail.js";
import { RunList } from "./components/RunList.js";
import { ScriptDetail } from "./components/ScriptDetail.js";
import { ScriptList } from "./components/ScriptList.js";
import type { M3LRoute } from "./routing/useHashRoute.js";
import { useHashRoute } from "./routing/useHashRoute.js";

// Wires ScriptList/RunList's onSelectScript/onSelectRun callbacks to
// `navigate` so activating a row drives the hash route (`#/scripts/:name`,
// `#/runs/:id`) — without this, clicking a script/run in its list would do
// nothing, and the detail routes would only be reachable by hand-typing a
// URL hash.
function renderRoute(
  route: M3LRoute,
  navigate: (route: M3LRoute) => void,
): ReactElement {
  switch (route.kind) {
    case "scripts":
      return (
        <ScriptList
          onSelectScript={(name) => {
            navigate({ kind: "script", name });
          }}
        />
      );
    case "script":
      return <ScriptDetail name={route.name} />;
    case "runs":
      return (
        <RunList
          onSelectRun={(id) => {
            navigate({ kind: "run", id });
          }}
        />
      );
    case "run":
      return <RunDetail id={route.id} />;
  }
}

/**
 * Root component of the m3l console web app: switches on the current hash
 * route and renders the matching read view inside the shared shell.
 *
 * @example
 * ```tsx
 * import { App } from "@m3l-automation/m3l-console-web/App.js";
 *
 * <App />;
 * ```
 */
export function App(): ReactElement {
  const { route, navigate } = useHashRoute();

  return (
    <ErrorBoundary>
      <main>
        <h1>m3l console</h1>
        <HealthBanner />
        <AppShell route={route} navigate={navigate}>
          {renderRoute(route, navigate)}
        </AppShell>
      </main>
    </ErrorBoundary>
  );
}
