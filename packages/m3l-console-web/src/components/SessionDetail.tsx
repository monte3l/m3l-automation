import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type {
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepSummary,
} from "../api/sessions.js";
import {
  fetchSession as fetchSessionDefault,
  fetchSessionDecisions as fetchSessionDecisionsDefault,
  fetchSessionSteps as fetchSessionStepsDefault,
} from "../api/sessions.js";
import { formatTimestampMs } from "../internal/timestamps.js";

/** Props accepted by {@link SessionDetail}. */
export interface SessionDetailProps {
  /** Id of the session to load. */
  readonly id: string;
  /**
   * Fetcher used to load the session record. Defaults to the real
   * {@link fetchSession}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchSession?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<M3LSessionRecord>>;
  /**
   * Fetcher used to load the session's steps. Defaults to the real
   * {@link fetchSessionSteps}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchSessionSteps?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>>;
  /**
   * Fetcher used to load the session's decisions. Defaults to the real
   * {@link fetchSessionDecisions}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly fetchSessionDecisions?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>>;
}

type SessionDetailState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "loaded";
      readonly session: M3LSessionRecord;
      readonly steps: readonly M3LSessionStepSummary[];
      readonly decisions: readonly M3LSessionDecisionRecord[];
    }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Combines the three parallel fetch results into a single settled state.
 * Error priority — session, then steps, then decisions — matches the order
 * this function checks them in, so a caller reading top-to-bottom sees the
 * same precedence the tests assert.
 */
function toSettledState(
  sessionResult: M3LConsoleFetchResult<M3LSessionRecord>,
  stepsResult: M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>,
  decisionsResult: M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>,
): SessionDetailState {
  if (!sessionResult.ok) {
    return { kind: "error", message: sessionResult.error.message };
  }
  if (!stepsResult.ok) {
    return { kind: "error", message: stepsResult.error.message };
  }
  if (!decisionsResult.ok) {
    return { kind: "error", message: decisionsResult.error.message };
  }
  return {
    kind: "loaded",
    session: sessionResult.data,
    steps: stepsResult.data,
    decisions: decisionsResult.data,
  };
}

/** The three fetchers {@link useSessionDetailFetchState} loads in parallel. */
interface SessionDetailFetchers {
  readonly fetchSession: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<M3LSessionRecord>>;
  readonly fetchSessionSteps: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>>;
  readonly fetchSessionDecisions: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>>;
}

/**
 * Owns the combined session/steps/decisions fetch lifecycle — initial load
 * on mount and re-load whenever `id` changes — extracted to keep
 * {@link SessionDetail} itself short. A single `cancelled` flag guards
 * against updating state after unmount or after a newer `id` has superseded
 * this effect run.
 */
function useSessionDetailFetchState(
  id: string,
  fetchers: SessionDetailFetchers,
): SessionDetailState {
  const [state, setState] = useState<SessionDetailState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    Promise.all([
      fetchers.fetchSession(id),
      fetchers.fetchSessionSteps(id),
      fetchers.fetchSessionDecisions(id),
    ])
      .then(([sessionResult, stepsResult, decisionsResult]) => {
        if (cancelled) {
          return;
        }
        setState(toSettledState(sessionResult, stepsResult, decisionsResult));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `id` should retrigger the fetch; the fetcher props are treated as stable
  }, [id]);

  return state;
}

/** Renders the `Steps` section, extracted to keep {@link SessionDetailLoaded} short. */
function SessionSteps({
  steps,
}: {
  readonly steps: readonly M3LSessionStepSummary[];
}): ReactElement {
  return (
    <section>
      <h3>Steps</h3>
      {steps.length === 0 ? (
        <p>no steps yet</p>
      ) : (
        <ul>
          {steps.map((step) => (
            // The leading "#" guarantees a non-word character precedes the
            // ordinal regardless of adjacent sibling text — without it, an
            // ordinal immediately following the "Steps" heading's own text
            // node (e.g. "Steps1 — ...") loses its `\b` word boundary.
            <li key={step.id}>
              #{step.ordinal} — {step.operation} — {step.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Renders the `Decisions` section, extracted to keep {@link SessionDetailLoaded} short. */
function SessionDecisions({
  decisions,
}: {
  readonly decisions: readonly M3LSessionDecisionRecord[];
}): ReactElement {
  return (
    <section>
      <h3>Decisions</h3>
      {decisions.length === 0 ? (
        <p>no decisions yet</p>
      ) : (
        <ul>
          {decisions.map((decision) => (
            <li key={decision.id}>
              {decision.prompt} — {decision.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Renders a loaded session's fields, steps, and decisions, extracted to
 * keep {@link SessionDetail} itself short.
 */
function SessionDetailLoaded({
  session,
  steps,
  decisions,
}: {
  readonly session: M3LSessionRecord;
  readonly steps: readonly M3LSessionStepSummary[];
  readonly decisions: readonly M3LSessionDecisionRecord[];
}): ReactElement {
  return (
    <>
      <h2>{session.id}</h2>
      <p>Status: {session.status}</p>
      <p>Operator: {session.operator}</p>
      <p>Created: {formatTimestampMs(session.createdAtMs)}</p>
      <p>Updated: {formatTimestampMs(session.updatedAtMs)}</p>
      {session.status === "closed" && (
        <p>Closed: {formatTimestampMs(session.closedAtMs)}</p>
      )}
      <SessionSteps steps={steps} />
      <SessionDecisions decisions={decisions} />
    </>
  );
}

/**
 * Loads and renders a single session's detail: id, status, operator,
 * timing, its steps, and its decisions. Reloads all three whenever `id`
 * changes.
 *
 * @example
 * ```tsx
 * import { SessionDetail } from "@m3l-automation/m3l-console-web/components/SessionDetail.js";
 *
 * <SessionDetail id="session-123" />;
 * ```
 */
export function SessionDetail(props: SessionDetailProps): ReactElement {
  const { id } = props;
  const fetchers: SessionDetailFetchers = {
    fetchSession: props.fetchSession ?? fetchSessionDefault,
    fetchSessionSteps: props.fetchSessionSteps ?? fetchSessionStepsDefault,
    fetchSessionDecisions:
      props.fetchSessionDecisions ?? fetchSessionDecisionsDefault,
  };
  const state = useSessionDetailFetchState(id, fetchers);

  return (
    <div data-testid="session-detail">
      {state.kind === "loading" && <p>Loading session…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <SessionDetailLoaded
          session={state.session}
          steps={state.steps}
          decisions={state.decisions}
        />
      )}
    </div>
  );
}
