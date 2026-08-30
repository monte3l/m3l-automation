import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LRunRecord } from "../api/runs.js";
import { fetchRuns as fetchRunsDefault } from "../api/runs.js";
import {
  formatNullableTimestampMs,
  formatTimestampMs,
} from "../internal/timestamps.js";

/** Props accepted by {@link RunList}. */
export interface RunListProps {
  /**
   * Fetcher used to load the run list. Defaults to the real
   * {@link fetchRuns}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchRuns?: () => Promise<
    M3LConsoleFetchResult<readonly M3LRunRecord[]>
  >;
  /** Called with a run's id when its row is activated. */
  readonly onSelectRun?: (id: string) => void;
}

type RunListState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly runs: readonly M3LRunRecord[] }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Loads and renders the list of runs, once on mount. Timing fields
 * (`startedAtMs`) are nullable — a run that hasn't started yet renders an
 * em dash rather than throwing.
 *
 * @example
 * ```tsx
 * import { RunList } from "@m3l-automation/m3l-console-web/components/RunList.js";
 *
 * <RunList onSelectRun={(id) => console.log(id)} />;
 * ```
 */
export function RunList(props: RunListProps): ReactElement {
  const [state, setState] = useState<RunListState>({ kind: "loading" });
  const load = props.fetchRuns ?? fetchRunsDefault;

  useEffect(() => {
    let cancelled = false;

    void load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "loaded", runs: result.data }
            : { kind: "error", message: result.error.message },
        );
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setState({ kind: "error", message: deriveErrorMessage(caught) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch runs once on mount by design
  }, []);

  return (
    <div data-testid="run-list">
      {state.kind === "loading" && <p>Loading runs…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" &&
        (state.runs.length === 0 ? (
          <p>no runs yet</p>
        ) : (
          <ul>
            {state.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectRun?.(run.id);
                  }}
                >
                  {run.script} — {run.id}
                </button>
                <span> {run.status}</span>
                <span> Queued: {formatTimestampMs(run.queuedAtMs)}</span>
                <span>
                  {" "}
                  Started: {formatNullableTimestampMs(run.startedAtMs)}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
