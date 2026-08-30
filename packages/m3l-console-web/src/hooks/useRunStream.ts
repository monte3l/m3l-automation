import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

import { encodePathSegment } from "../internal/path-segment.js";

/**
 * Bounded tail length for {@link M3LRunStreamState.lines}. A chatty script
 * can emit an unbounded number of `run.line` events over the lifetime of a
 * run; the hook drops the oldest buffered line once this cap is exceeded so
 * the browser tab's memory usage stays bounded.
 */
export const MAX_TAIL_LINES: number = 500;

/**
 * Mirrors the native `EventSource.CLOSED` static constant (`2`) as a
 * literal rather than reading it off the global constructor — jsdom does
 * not implement `EventSource` at all, so referencing `EventSource.CLOSED`
 * directly would throw under every test that exercises the `error`
 * listener via an injected fake.
 */
const EVENT_SOURCE_READY_STATE_CLOSED = 2;

/**
 * The `stream.end` frame's closed reason vocabulary
 * (`packages/m3l-console-server/src/stream/event-stream.ts`), plus
 * `"unknown"` for a `stream.end` whose payload is malformed or lacks a
 * string `reason` — that malformed case must never share the `null` slot
 * with "hasn't ended yet", or an unparseable reason renders as if the
 * stream were still healthy.
 */
export type M3LRunStreamEndReason = "completed" | "draining" | "unknown";

/**
 * Live state accumulated from a run's `GET /api/v1/runs/:id/stream` SSE
 * connection, as produced by {@link useRunStream}. A discriminated union on
 * `phase` rather than a flat `endReason: string | null` — that flat shape
 * conflated three meanings ("not ended yet", "ended with an unparseable
 * reason", and a synthetic "no EventSource available" sentinel) in the same
 * slot, which could leak a client-only sentinel into text rendered for an
 * operator as if it were the server's own wire vocabulary.
 */
export type M3LRunStreamState = {
  /** Buffered `run.line` text, oldest first, capped at {@link MAX_TAIL_LINES}. */
  readonly lines: readonly string[];
  /** Count of `stream.gap` control frames observed so far. */
  readonly gapCount: number;
} & (
  | {
      /** Still connecting, or connected and streaming normally. */
      readonly phase: "connecting" | "open";
      /**
       * Kept present (but `undefined`) on every non-`"ended"` member rather
       * than omitted entirely, so a caller can read `.endReason` without
       * first narrowing on `.phase` — a plain `expect(...).toBe(...)`
       * assertion is not a type guard, and this hook's own callers read
       * `endReason` immediately after asserting `phase` that way.
       */
      readonly endReason?: undefined;
    }
  | {
      /** The server sent a well-formed `stream.end`. */
      readonly phase: "ended";
      /** The `stream.end` frame's `reason`. */
      readonly endReason: M3LRunStreamEndReason;
    }
  | {
      /**
       * The connection died with no well-formed `stream.end` (TLS reset, LB
       * idle timeout, server crash mid-run) — distinct from `"ended"` since
       * no reason from the server exists for this case.
       */
      readonly phase: "lost";
      readonly endReason?: undefined;
    }
  | {
      /** No `EventSource` constructor is available at all (e.g. jsdom). */
      readonly phase: "unavailable";
      readonly endReason?: undefined;
    }
);

/** Options accepted by {@link useRunStream}. */
export interface M3LRunStreamOptions {
  /**
   * `EventSource` constructor to use. Defaults to the global
   * `EventSource`, which jsdom does not implement — tests inject a fake
   * here so the hook never touches a real network connection under jsdom.
   */
  readonly eventSource?: typeof EventSource;
  /**
   * Invoked once per `stream.gap` control frame. A gap means the ring
   * buffer dropped or reordered events; the caller is expected to
   * re-fetch authoritative run state (`GET /api/v1/runs/:id`) in response.
   * The hook deliberately never reads a field off the gap payload — it has
   * two different shapes on the wire (`{ oldestRetainedId }` for a
   * retention gap, `{ lastEventId }` for a backpressure gap) and a gap
   * means exactly one thing regardless of which shape arrived.
   */
  readonly onResync?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses an SSE `data` string as JSON, returning `undefined` (never
 * throwing) on anything that isn't valid JSON.
 */
function parseEventData(data: unknown): unknown {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function resolveEventSourceCtor(
  injected: typeof EventSource | undefined,
): typeof EventSource | undefined {
  if (injected !== undefined) {
    return injected;
  }
  return (globalThis as { readonly EventSource?: typeof EventSource })
    .EventSource;
}

/**
 * Resolves a `stream.end` frame's `reason` field to the closed
 * {@link M3LRunStreamEndReason} vocabulary — a malformed payload, or a
 * well-formed one lacking a recognised string `reason`, maps to
 * `"unknown"` rather than `null`.
 */
function resolveEndReason(event: MessageEvent<unknown>): M3LRunStreamEndReason {
  const payload = parseEventData(event.data);
  const reason =
    isRecord(payload) && typeof payload["reason"] === "string"
      ? payload["reason"]
      : undefined;
  return reason === "completed" || reason === "draining" ? reason : "unknown";
}

/** The `useState` setter {@link createRunStreamHandlers} closes over. */
type RunStreamPhaseState =
  | { readonly phase: "connecting" | "open"; readonly endReason?: undefined }
  | { readonly phase: "ended"; readonly endReason: M3LRunStreamEndReason }
  | { readonly phase: "lost"; readonly endReason?: undefined }
  | { readonly phase: "unavailable"; readonly endReason?: undefined };

interface RunStreamSetters {
  readonly setLines: Dispatch<SetStateAction<readonly string[]>>;
  readonly setState: Dispatch<SetStateAction<RunStreamPhaseState>>;
  readonly setGapCount: Dispatch<SetStateAction<number>>;
}

/** One handler per SSE event type {@link attachRunStreamListeners} wires up. */
interface RunStreamHandlers {
  readonly handleOpen: () => void;
  readonly handleRunLifecycleEvent: () => void;
  readonly handleLine: (event: MessageEvent<unknown>) => void;
  readonly handleGap: () => void;
  readonly handleStreamEnd: (event: MessageEvent<unknown>) => void;
  readonly handleError: () => void;
}

/**
 * Builds the per-connection event handlers. Split out of
 * {@link useRunStream} purely to keep that function (and this one) under
 * the project's max-lines-per-function budget.
 */
function createRunStreamHandlers(
  source: EventSource,
  setters: RunStreamSetters,
  onResync: (() => void) | undefined,
): RunStreamHandlers {
  const handleOpen = (): void => {
    setters.setState({ phase: "open" });
  };

  // `run.queued`/`run.started`/`run.ended` are listened for per the stream
  // contract but carry no state this hook exposes — `run.ended` in
  // particular must be a deliberate no-op: the server always follows it
  // with `stream.end`, which is the sole close signal.
  const handleRunLifecycleEvent = (): void => {
    // intentionally inert
  };

  const handleLine = (event: MessageEvent<unknown>): void => {
    const payload = parseEventData(event.data);
    if (!isRecord(payload) || typeof payload["line"] !== "string") {
      return;
    }
    const line = payload["line"];
    setters.setLines((previous) => {
      const next = [...previous, line];
      return next.length > MAX_TAIL_LINES
        ? next.slice(next.length - MAX_TAIL_LINES)
        : next;
    });
  };

  const handleGap = (): void => {
    // Never parse the `stream.gap` payload — it has two shapes on the wire
    // and a gap means exactly one thing regardless of which arrived.
    setters.setGapCount((count) => count + 1);
    onResync?.();
  };

  const handleStreamEnd = (event: MessageEvent<unknown>): void => {
    setters.setState({ phase: "ended", endReason: resolveEndReason(event) });
    source.close();
  };

  // Native EventSource auto-reconnects on a transient drop, flipping
  // readyState to CONNECTING (0, not CLOSED's 2) while it retries — only
  // CLOSED means the connection is truly dead with no further retry in
  // flight. The literal `2` (not `EventSource.CLOSED`) is deliberate: jsdom
  // does not implement `EventSource` at all, so referencing the global
  // constructor's static property here would throw under every test that
  // exercises this listener via an injected fake.
  // Treating a CONNECTING error as fatal would freeze the operator's view
  // of "lost" on a stream that is about to recover on its own, which is a
  // worse bug than the frozen-tail one this listener fixes.
  const handleError = (): void => {
    if (source.readyState === EVENT_SOURCE_READY_STATE_CLOSED) {
      setters.setState({ phase: "lost" });
    }
  };

  return {
    handleOpen,
    handleRunLifecycleEvent,
    handleLine,
    handleGap,
    handleStreamEnd,
    handleError,
  };
}

/**
 * Registers every SSE listener on `source` and returns the matching cleanup
 * (removes each listener, then closes `source`). Split out of
 * {@link useRunStream} purely to keep that function under the project's
 * max-lines-per-function budget.
 */
function attachRunStreamListeners(
  source: EventSource,
  handlers: RunStreamHandlers,
): () => void {
  source.addEventListener("open", handlers.handleOpen);
  source.addEventListener("run.queued", handlers.handleRunLifecycleEvent);
  source.addEventListener("run.started", handlers.handleRunLifecycleEvent);
  source.addEventListener("run.line", handlers.handleLine as EventListener);
  source.addEventListener("run.ended", handlers.handleRunLifecycleEvent);
  source.addEventListener("stream.gap", handlers.handleGap);
  source.addEventListener(
    "stream.end",
    handlers.handleStreamEnd as EventListener,
  );
  source.addEventListener("error", handlers.handleError);

  return () => {
    source.removeEventListener("open", handlers.handleOpen);
    source.removeEventListener("run.queued", handlers.handleRunLifecycleEvent);
    source.removeEventListener("run.started", handlers.handleRunLifecycleEvent);
    source.removeEventListener(
      "run.line",
      handlers.handleLine as EventListener,
    );
    source.removeEventListener("run.ended", handlers.handleRunLifecycleEvent);
    source.removeEventListener("stream.gap", handlers.handleGap);
    source.removeEventListener(
      "stream.end",
      handlers.handleStreamEnd as EventListener,
    );
    source.removeEventListener("error", handlers.handleError);
    source.close();
  };
}

/**
 * Subscribes to a run's live SSE stream at
 * `/api/v1/runs/:id/stream`, tailing `run.line` output into a bounded
 * buffer and tracking connection phase, gap count, and end reason.
 *
 * Four run events (`run.queued`, `run.started`, `run.line`, `run.ended`)
 * and three control/lifecycle frames (`stream.gap`, `stream.end`, `error`)
 * are all listened for. `run.ended` alone never closes the connection — the
 * server always follows it with `stream.end`, which is the sole
 * well-formed close signal — because the server also replays the buffered
 * tail for an already-terminal run before closing. An `error` event only
 * drives `phase` to `"lost"` when `readyState === CLOSED`; the browser's
 * native `EventSource` auto-reconnects and fires `error` at `CONNECTING`
 * for a transient drop, which must not be treated as fatal.
 *
 * @example
 * ```tsx
 * import { useRunStream } from "@m3l-automation/m3l-console-web/hooks/useRunStream.js";
 *
 * function RunTail({ runId }: { readonly runId: string }): React.ReactElement {
 *   const stream = useRunStream(runId, {
 *     onResync: () => {
 *       // re-fetch GET /api/v1/runs/:id here
 *     },
 *   });
 *   return (
 *     <pre>
 *       {stream.lines.join("\n")}
 *     </pre>
 *   );
 * }
 * ```
 */
export function useRunStream(
  runId: string,
  options?: M3LRunStreamOptions,
): M3LRunStreamState {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [state, setState] = useState<RunStreamPhaseState>({
    phase: "connecting",
  });
  const [gapCount, setGapCount] = useState(0);

  useEffect(() => {
    const Ctor = resolveEventSourceCtor(options?.eventSource);
    if (Ctor === undefined) {
      // No EventSource available (e.g. jsdom without an injected fake) —
      // degrade to a terminal state rather than throwing.
      setState({ phase: "unavailable" });
      return;
    }

    const source = new Ctor(`/api/v1/runs/${encodePathSegment(runId)}/stream`);
    const handlers = createRunStreamHandlers(
      source,
      { setLines, setState, setGapCount },
      options?.onResync,
    );
    return attachRunStreamListeners(source, handlers);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `eventSource`/`onResync` are treated as stable injected dependencies, mirroring ScriptDetail's `fetchScript` prop; only `runId` should reopen the connection
  }, [runId]);

  return { lines, gapCount, ...state };
}
