import type { ReactElement } from "react";

import { AppShell } from "./components/AppShell.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { HealthBanner } from "./components/HealthBanner.js";
import { RunDetail } from "./components/RunDetail.js";
import { RunList } from "./components/RunList.js";
import { ScriptDetail } from "./components/ScriptDetail.js";
import { ScriptList } from "./components/ScriptList.js";
import { SessionDetail } from "./components/SessionDetail.js";
import { SessionList } from "./components/SessionList.js";
import type { M3LRoute } from "./routing/useHashRoute.js";
import { useHashRoute } from "./routing/useHashRoute.js";

// Wires ScriptList/RunList's onSelectScript/onSelectRun callbacks, plus
// ScriptDetail's onLaunched, to `navigate` so activating a row (or
// launching a run) drives the hash route (`#/scripts/:name`, `#/runs/:id`)
// — without this, clicking a script/run in its list would do nothing, and
// a successful launch would strand the operator on the form with no way to
// reach the run it just created.
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
      return (
        // `key` forces a full remount on a route change (e.g.
        // #/scripts/alpha -> #/scripts/beta) rather than reusing the same
        // mounted instance — without it, ParameterForm's per-instance
        // values/dryRun/confirmed state (and ScriptDetail's own fetch
        // state) would carry the previous script's still-typed values and
        // confirmation forward into a launch for a different script.
        <ScriptDetail
          key={route.name}
          name={route.name}
          onLaunched={(id) => {
            navigate({ kind: "run", id });
          }}
        />
      );
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
    case "sessions":
      return (
        <SessionList
          onSelectSession={(id) => {
            navigate({ kind: "session", id });
          }}
          onSessionCreated={(id) => {
            navigate({ kind: "session", id });
          }}
        />
      );
    case "session":
      return <SessionDetail id={route.id} />;
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
