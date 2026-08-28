import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import { fetchHealth } from "../api/health.js";
import type { M3LHealthPayload } from "../api/health.js";

/** Props accepted by {@link HealthBanner}. */
export interface HealthBannerProps {
  readonly fetchHealth?: () => Promise<M3LConsoleFetchResult<M3LHealthPayload>>;
}

type HealthState =
  | { readonly kind: "checking" }
  | { readonly kind: "ok"; readonly uptimeMs: number }
  | { readonly kind: "unreachable"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Fetches the console server's health once on mount and reports the
 * result: checking, reachable (with uptime), or unreachable (with the
 * failure message).
 *
 * @example
 * ```tsx
 * import { HealthBanner } from "@m3l-automation/m3l-console-web/components/HealthBanner.js";
 *
 * <HealthBanner />;
 * ```
 */
export function HealthBanner(props: HealthBannerProps): ReactElement {
  const [state, setState] = useState<HealthState>({ kind: "checking" });
  const load = props.fetchHealth ?? fetchHealth;

  useEffect(() => {
    let cancelled = false;

    void load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "ok", uptimeMs: result.data.uptimeMs }
            : { kind: "unreachable", message: result.error.message },
        );
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setState({ kind: "unreachable", message: deriveErrorMessage(caught) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch runs once on mount by design
  }, []);

  return (
    <div data-testid="health-banner">
      {state.kind === "checking" && <span>Checking console health…</span>}
      {state.kind === "ok" && (
        <span>Console server: ok (uptime {state.uptimeMs}ms)</span>
      )}
      {state.kind === "unreachable" && (
        <span>Console server: unreachable ({state.message})</span>
      )}
    </div>
  );
}
