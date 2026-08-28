import type { ReactElement } from "react";

import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { HealthBanner } from "./components/HealthBanner.js";

/**
 * Root component of the m3l console web app.
 *
 * @example
 * ```tsx
 * import { App } from "@m3l-automation/m3l-console-web/App.js";
 *
 * <App />;
 * ```
 */
export function App(): ReactElement {
  return (
    <ErrorBoundary>
      <main>
        <h1>m3l console</h1>
        <HealthBanner />
      </main>
    </ErrorBoundary>
  );
}
