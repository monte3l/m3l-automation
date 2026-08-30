import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LRunRecord } from "../api/runs.js";
import { fetchRun as fetchRunDefault } from "../api/runs.js";
import {
  formatNullableTimestampMs,
  formatTimestampMs,
} from "../internal/timestamps.js";

/** Props accepted by {@link RunDetail}. */
export interface RunDetailProps {
  /** Id of the run to load. */
  readonly id: string;
  /**
   * Fetcher used to load the run's detail. Defaults to the real
   * {@link fetchRun}; injectable so tests can supply a fake without mocking
   * a module.
   */
  readonly fetchRun?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<M3LRunRecord>>;
}

type RunDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly run: M3LRunRecord }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Indentation width for the pretty-printed `parameters` JSON blob below. */
const PARAMETERS_JSON_INDENT = 2;

/**
 * Loads and renders a single run's detail: script, status, timing, outcome,
 * and the parameters it was launched with.
 *
 * @example
 * ```tsx
 * import { RunDetail } from "@m3l-automation/m3l-console-web/components/RunDetail.js";
 *
 * <RunDetail id="run-123" />;
 * ```
 */
export function RunDetail(props: RunDetailProps): ReactElement {
  const [state, setState] = useState<RunDetailState>({ kind: "loading" });
  const { id } = props;
  const load = props.fetchRun ?? fetchRunDefault;

  useEffect(() => {
    let cancelled = false;

    void load(id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "loaded", run: result.data }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `id` should retrigger the fetch; the fetcher prop is treated as stable
  }, [id]);

  return (
    <div data-testid="run-detail">
      {state.kind === "loading" && <p>Loading run…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <>
          <h2>
            {state.run.script} — {state.run.id}
          </h2>
          <p>Status: {state.run.status}</p>
          <p>Queued: {formatTimestampMs(state.run.queuedAtMs)}</p>
          <p>Started: {formatNullableTimestampMs(state.run.startedAtMs)}</p>
          <p>Ended: {formatNullableTimestampMs(state.run.endedAtMs)}</p>
          <p>Outcome: {state.run.outcome ?? "—"}</p>
          <p>Exit code: {state.run.exitCode ?? "—"}</p>
          <p>Failure: {state.run.failureMessage ?? "—"}</p>
          {/*
           * The console server documents `parameters` as echoed back
           * verbatim and warns callers against passing secrets through it.
           * This view has no way to tell which fields (if any) are
           * sensitive, so it intentionally does not mask any part of this
           * blob — pretty-printing it as-is is the whole contract.
           */}
          <pre>
            {JSON.stringify(state.run.parameters, null, PARAMETERS_JSON_INDENT)}
          </pre>
        </>
      )}
    </div>
  );
}
