import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LRunRecord } from "../api/runs.js";
import { fetchRun as fetchRunDefault } from "../api/runs.js";
import type { M3LRunStreamState } from "../hooks/useRunStream.js";
import { useRunStream as useRunStreamDefault } from "../hooks/useRunStream.js";
import {
  formatNullableTimestampMs,
  formatTimestampMs,
} from "../internal/timestamps.js";
import { RunLogTail } from "./RunLogTail.js";

/**
 * Adapts the real `useRunStream` hook (which takes a single options bag)
 * to the narrower `(id, onResync)` seam {@link RunDetailProps} exposes for
 * injection — that narrower shape is all a test double needs to satisfy,
 * and keeps the injected seam from leaking the hook's full options surface
 * into this component's props.
 */
function useRunStreamAdapter(
  id: string,
  onResync: () => void,
): M3LRunStreamState {
  return useRunStreamDefault(id, { onResync });
}

/**
 * Structural shape {@link RunDetail} actually reads off a live-tail hook's
 * return value: `phase` widened to every phase the real hook can report,
 * `endReason` optional (present only for a well-formed `stream.end`). The
 * real {@link M3LRunStreamState} discriminated union satisfies this shape,
 * and so does a simpler test double that always carries an `endReason`
 * slot — this is deliberately looser than the exact union so either can be
 * injected via {@link RunDetailProps.useRunStream}.
 */
interface RunDetailStreamState {
  readonly lines: readonly string[];
  readonly phase: M3LRunStreamState["phase"];
  // `| undefined` explicitly, not just `?:` — `exactOptionalPropertyTypes`
  // is on, and the real hook's non-"ended" phases carry `endReason` present
  // as `undefined` (not absent) so callers can read it without narrowing.
  readonly endReason?: string | null | undefined;
  readonly gapCount: number;
}

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
  /**
   * Live-tail hook driving {@link RunLogTail}. Defaults to an adapter over
   * the real `useRunStream`; injectable so tests can supply a fake without
   * an `EventSource`.
   */
  readonly useRunStream?: (
    id: string,
    onResync: () => void,
  ) => RunDetailStreamState;
}

type RunDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly run: M3LRunRecord }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Maps a fetch result to the state it settles into once (never) cancelled. */
function toSettledState(
  result: M3LConsoleFetchResult<M3LRunRecord>,
): RunDetailState {
  return result.ok
    ? { kind: "loaded", run: result.data }
    : { kind: "error", message: result.error.message };
}

/** Indentation width for the pretty-printed `parameters` JSON blob below. */
const PARAMETERS_JSON_INDENT = 2;

/** Return shape of {@link useRunDetailFetchState}. */
interface RunDetailFetchState {
  readonly state: RunDetailState;
  /**
   * Re-fetches the run record and, on success, replaces `state` with the
   * fresh copy. Passed to the live-tail hook as its `onResync` — a
   * `stream.gap` means the ring buffer dropped or reordered events, and the
   * authoritative fix is to re-fetch, not to trust the buffered tail alone
   * (ADR-0066: the ring buffer is an accelerator over queryable state,
   * never the only copy).
   */
  readonly handleResync: () => void;
}

/**
 * Owns the run-record fetch lifecycle (initial load plus resync-on-gap),
 * extracted to keep {@link RunDetail} itself short. A single `cancelledRef`
 * guards both the initial fetch and any later resync against updating
 * state after unmount.
 */
function useRunDetailFetchState(
  id: string,
  load: (id: string) => Promise<M3LConsoleFetchResult<M3LRunRecord>>,
): RunDetailFetchState {
  const [state, setState] = useState<RunDetailState>({ kind: "loading" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    // A single two-argument `.then(onFulfilled, onRejected)` call, not a
    // separate chained `.catch()` — the latter (`.then(f).catch(g)`) routes
    // a rejection through an extra derived promise before `g` runs, costing
    // an additional microtask tick a caller polling a side effect (rather
    // than awaiting this promise itself) may not survive.
    void load(id).then(
      (result) => {
        if (cancelledRef.current) {
          return;
        }
        setState(toSettledState(result));
      },
      (caught: unknown) => {
        if (cancelledRef.current) {
          return;
        }
        setState({ kind: "error", message: deriveErrorMessage(caught) });
      },
    );

    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `id` should retrigger the fetch; the fetcher prop is treated as stable
  }, [id]);

  function handleResync(): void {
    // flushSync — unlike the initial-load effect above, this fires from a
    // caller-triggered callback (a `stream.gap` handler, not a React-owned
    // event), so React treats the resulting update as non-urgent and can
    // defer its DOM commit to a later scheduler tick. A caller polling for
    // "has the resync completed" via a side effect (e.g. the fetch call
    // count) rather than the DOM itself needs the commit to have already
    // landed by the time that poll succeeds — flushSync forces it
    // synchronously within this same callback instead. The two-argument
    // `.then(onFulfilled, onRejected)` form (see the initial-load effect's
    // comment above) keeps both paths to exactly one microtask hop.
    void load(id).then(
      (result) => {
        if (cancelledRef.current) {
          return;
        }
        flushSync(() => {
          setState(toSettledState(result));
        });
      },
      (caught: unknown) => {
        if (cancelledRef.current) {
          return;
        }
        flushSync(() => {
          setState({ kind: "error", message: deriveErrorMessage(caught) });
        });
      },
    );
  }

  return { state, handleResync };
}

/**
 * Renders a loaded run's fields plus its live-tail, extracted to keep
 * {@link RunDetail} itself short.
 */
function RunDetailLoaded({
  run,
  stream,
}: {
  readonly run: M3LRunRecord;
  readonly stream: RunDetailStreamState;
}): ReactElement {
  return (
    <>
      <h2>
        {run.script} — {run.id}
      </h2>
      <p>Status: {run.status}</p>
      <p>Queued: {formatTimestampMs(run.queuedAtMs)}</p>
      <p>Started: {formatNullableTimestampMs(run.startedAtMs)}</p>
      <p>Ended: {formatNullableTimestampMs(run.endedAtMs)}</p>
      <p>Outcome: {run.outcome ?? "—"}</p>
      <p>Exit code: {run.exitCode ?? "—"}</p>
      <p>Failure: {run.failureMessage ?? "—"}</p>
      {/*
       * The console server documents `parameters` as echoed back verbatim
       * and warns callers against passing secrets through it. This view has
       * no way to tell which fields (if any) are sensitive, so it
       * intentionally does not mask any part of this blob — pretty-printing
       * it as-is is the whole contract.
       */}
      <pre>{JSON.stringify(run.parameters, null, PARAMETERS_JSON_INDENT)}</pre>
      {/*
       * The tail is mounted for every loaded run, terminal or not — a
       * terminal run still gets one because the server replays its
       * buffered ring-buffer tail before closing the stream.
       */}
      <RunLogTail
        lines={stream.lines}
        gapCount={stream.gapCount}
        phase={stream.phase}
        endReason={stream.endReason ?? null}
      />
    </>
  );
}

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
  const { id } = props;
  const load = props.fetchRun ?? fetchRunDefault;
  const useStream = props.useRunStream ?? useRunStreamAdapter;
  const { state, handleResync } = useRunDetailFetchState(id, load);
  const stream = useStream(id, handleResync);

  return (
    <div data-testid="run-detail">
      {state.kind === "loading" && <p>Loading run…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <RunDetailLoaded run={state.run} stream={stream} />
      )}
    </div>
  );
}
