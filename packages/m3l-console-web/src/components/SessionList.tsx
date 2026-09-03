import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LSessionRecord } from "../api/sessions.js";
import {
  createSession as createSessionDefault,
  fetchSessions as fetchSessionsDefault,
} from "../api/sessions.js";
import { formatTimestampMs } from "../internal/timestamps.js";

/** Props accepted by {@link SessionList}. */
export interface SessionListProps {
  /**
   * Fetcher used to load the session list. Defaults to the real
   * {@link fetchSessions}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchSessions?: () => Promise<
    M3LConsoleFetchResult<readonly M3LSessionRecord[]>
  >;
  /**
   * Creates a new session. Defaults to the real {@link createSession};
   * injectable so tests can supply a fake without mocking a module.
   */
  readonly createSession?: () => Promise<
    M3LConsoleFetchResult<M3LSessionRecord>
  >;
  /** Called with a session's id when its row is activated. */
  readonly onSelectSession?: (id: string) => void;
  /** Called with the newly created session's id once creation succeeds. */
  readonly onSessionCreated?: (id: string) => void;
}

type SessionListState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly sessions: readonly M3LSessionRecord[] }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Owns the "New session" button's own create-request lifecycle, kept as a
 * small piece of local state separate from the list's own loading/loaded/
 * error state — extracted to keep {@link SessionList} itself short. A
 * `cancelledRef` guards `handleCreate`'s async continuation against updating
 * state (or invoking `onSessionCreated`) after unmount — there is no natural
 * "effect" for `handleCreate` to hang a `let cancelled` flag on since it is
 * an event handler, not a mount effect, so the ref is set on a mount-scoped
 * `useEffect`'s cleanup instead, mirroring `RunDetail.tsx`'s
 * `useRunDetailFetchState`.
 */
function useCreateSessionHandler(
  create: () => Promise<M3LConsoleFetchResult<M3LSessionRecord>>,
  onSessionCreated: ((id: string) => void) | undefined,
): { readonly createError: string | null; readonly handleCreate: () => void } {
  const [createError, setCreateError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  function handleCreate(): void {
    create()
      .then((result) => {
        if (cancelledRef.current) {
          return;
        }
        if (result.ok) {
          setCreateError(null);
          onSessionCreated?.(result.data.id);
          return;
        }
        setCreateError(result.error.message);
      })
      .catch((caught: unknown) => {
        if (cancelledRef.current) {
          return;
        }
        setCreateError(deriveErrorMessage(caught));
      });
  }

  return { createError, handleCreate };
}

/**
 * Renders the loaded sessions list, extracted to keep {@link SessionList}
 * itself under the per-function line budget.
 */
function SessionListLoaded({
  sessions,
  onSelectSession,
}: {
  readonly sessions: readonly M3LSessionRecord[];
  readonly onSelectSession: ((id: string) => void) | undefined;
}): ReactElement {
  if (sessions.length === 0) {
    return <p>no sessions yet</p>;
  }
  return (
    <ul>
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            onClick={() => {
              onSelectSession?.(session.id);
            }}
          >
            {session.id}
          </button>
          <span> {session.status}</span>
          <span> Created: {formatTimestampMs(session.createdAtMs)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Loads and renders the list of sessions, once on mount, plus a "New
 * session" button that creates a new session independent of the list's own
 * load state.
 *
 * @example
 * ```tsx
 * import { SessionList } from "@m3l-automation/m3l-console-web/components/SessionList.js";
 *
 * <SessionList
 *   onSelectSession={(id) => console.log(id)}
 *   onSessionCreated={(id) => console.log("created", id)}
 * />;
 * ```
 */
export function SessionList(props: SessionListProps): ReactElement {
  const [state, setState] = useState<SessionListState>({ kind: "loading" });
  const load = props.fetchSessions ?? fetchSessionsDefault;
  const create = props.createSession ?? createSessionDefault;
  const { createError, handleCreate } = useCreateSessionHandler(
    create,
    props.onSessionCreated,
  );

  useEffect(() => {
    let cancelled = false;

    void load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "loaded", sessions: result.data }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch sessions once on mount by design
  }, []);

  return (
    <div data-testid="session-list">
      <button type="button" onClick={handleCreate}>
        New session
      </button>
      {createError !== null && <p>Error: {createError}</p>}
      {state.kind === "loading" && <p>Loading sessions…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <SessionListLoaded
          sessions={state.sessions}
          onSelectSession={props.onSelectSession}
        />
      )}
    </div>
  );
}
