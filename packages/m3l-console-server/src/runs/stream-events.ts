/**
 * `runs/stream-events` — `createStreamRunEventSink`, the stream-hub-backed
 * {@link M3LRunEventSink} that slice 7's SSE route reads from.
 *
 * `runs/` may import `stream/` (zone rules), and `stream/` never names a
 * run-specific shape — it is generic over `TPayload`. This module is the
 * bridge: it knows both the run-event vocabulary (`../runs/events.js`) and
 * the transport (`M3LEventStreamHub<M3LRunEvent>`), and publishes every
 * event onto the stream open at `event.runId`. Unlike
 * `createLoggerRunEventSink`, it never drops `run.line` — the stream is
 * `run.line`'s real destination (see `events.ts`'s own TSDoc).
 *
 * @packageDocumentation
 */

import type { M3LEventStreamHub } from "../stream/event-stream.js";

import type { M3LRunEvent, M3LRunEventSink } from "./events.js";

/**
 * Creates an {@link M3LRunEventSink} that publishes each {@link M3LRunEvent}
 * into the stream open at `event.runId` on `hub`.
 *
 * A run with no live SSE watcher never had a stream opened for it, so
 * `hub.get(event.runId)` returns `undefined` in the common case — most runs
 * complete without anyone ever subscribing. That is not a failure: the sink
 * must be a silent no-op then, exactly as this factory's own contract
 * promises ("never throws — an event sink must not become a run failure
 * mode", `events.ts`'s {@link M3LRunEventSink} TSDoc). Only when a stream IS
 * open — and has not already ended — does this sink forward the event onto
 * it; publishing on an already-ended stream would otherwise throw
 * `ERR_CONSOLE_STREAM_CLOSED` (`stream/event-stream.ts`), which this sink's
 * own "never throws" contract forbids.
 *
 * @param hub - The run-keyed event stream hub to publish into.
 * @returns A fresh {@link M3LRunEventSink}.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 * import { createStreamRunEventSink } from "@m3l-automation/m3l-console-server/runs/stream-events.js";
 *
 * const hub = createEventStreamHub<import("./events.js").M3LRunEvent>({
 *   bufferSize: 100,
 * });
 * const sink = createStreamRunEventSink(hub);
 * hub.open("run-1");
 * sink.publish({ event: "run.started", runId: "run-1", atMs: Date.now() });
 * ```
 */
export function createStreamRunEventSink(
  hub: M3LEventStreamHub<M3LRunEvent>,
): M3LRunEventSink {
  return {
    publish(event: M3LRunEvent): void {
      const stream = hub.get(event.runId);
      if (stream === undefined || stream.ended) return;
      stream.publish(event);
    },
  };
}
