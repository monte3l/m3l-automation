/**
 * `http/routes/run-stream` — `GET /api/v1/runs/:id/stream`, the SSE channel a
 * console watches one run's lifecycle through (X4 slice 7a).
 *
 * `http/` may never import `runs/` (zone rules), so the run-existence/status
 * check depends on a narrow local port ({@link M3LRunStreamRegistryPort}),
 * following the same declared-not-imported trick `http/routes/health.ts`'s
 * `M3LReadinessProbe` uses. `stream/` IS a legal `http/` import, so this
 * module reads the real {@link M3LEventStreamHub} directly.
 *
 * A still-active run (`status` `"queued"`/`"running"`) gets its stream opened
 * lazily, on this route's first watcher (`hub.get(id) ?? hub.open(id)`) — no
 * other file in this slice opens a per-run stream. A run that is already
 * terminal at subscribe time never gets a NEW stream opened for it; it only
 * replays whatever the hub happens to have retained, and resolves `open()`
 * immediately without waiting on a live `onEnd`. That is deliberate even
 * though `runs/stream-events.ts`'s sink DOES call `stream.end()` on
 * `run.ended` (addendum Correction 2): this route has no way to know whether
 * that `end()` has already fired by the time its handler runs (a watcher may
 * arrive in the narrow window before the sink ends the stream, or after), so
 * it must resolve promptly either way rather than betting on the ordering.
 *
 * Both paths emit a terminal `stream.end` frame (see {@link buildEndFrame})
 * BEFORE the response ends, whenever `onEnd` fires with `!sink.closed` —
 * live, when the stream this watcher is subscribed to ends (a run completing,
 * or the server draining); synchronously during `subscribe()`, on the replay
 * path, for a stream that was already ended by the time this route's handler
 * ran. A watcher can therefore always distinguish "the run finished" from
 * "the server is shutting down" from "the network just died" (no frame at
 * all reaches it in that last case).
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../../errors/console-error.js";
import type {
  M3LEventStream,
  M3LEventStreamHub,
  M3LStreamEndReason,
  M3LStreamEvent,
  M3LStreamSubscription,
} from "../../stream/event-stream.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import type { M3LRoute } from "../router.js";
import type { M3LSseFrame } from "../sse.js";
import type {
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "../stream-response.js";

/** The status this route's stream response always opens with. */
const STATUS_OK = 200;
/** The `content-type` an SSE response always carries. */
const SSE_CONTENT_TYPE = "text/event-stream";
/** The event name a resume gap is surfaced under (see this module's own TSDoc). */
const GAP_EVENT_NAME = "stream.gap";
/** The event name a stream's terminal frame is surfaced under (see {@link buildEndFrame}). */
const END_EVENT_NAME = "stream.end";
/** The (lower-cased, per Node's own header normalization) resume header this route reads. */
const LAST_EVENT_ID_HEADER = "last-event-id";

/** The minimal event shape this route needs: an `event` name to carry as the SSE event. */
interface M3LRunStreamEvent {
  readonly event: string;
}

/**
 * The local reader port this module depends on — mirrors `runs/registry.ts`'s
 * `M3LRunRegistry.get`, narrowed to the one field this route reads.
 *
 * @example
 * ```ts
 * const registry: M3LRunStreamRegistryPort = { get: () => undefined };
 * ```
 */
export interface M3LRunStreamRegistryPort {
  /** Reads one run's status by id, or `undefined` when no such run exists. */
  get(id: string): { readonly status: string } | undefined;
}

/**
 * Constructor options for {@link createRunStreamRoutes}.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 *
 * const options: RunStreamRouteOptions = {
 *   hub: createEventStreamHub({ bufferSize: 100 }),
 *   registry: { get: () => undefined },
 * };
 * ```
 */
export interface RunStreamRouteOptions {
  /** The run-event stream hub this route subscribes to; `main.ts` passes the real one the run subsystem owns. */
  readonly hub: M3LEventStreamHub<M3LRunStreamEvent>;
  /** The run-reading port; `main.ts` passes the real `M3LRunRegistry`. */
  readonly registry: M3LRunStreamRegistryPort;
}

/** `true` for a run whose stream may still receive live events. */
function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

/** Builds the SSE data frame for one delivered run event. */
function frameForEvent(event: M3LStreamEvent<M3LRunStreamEvent>): M3LSseFrame {
  return {
    id: event.id,
    event: event.payload.event,
    data: JSON.stringify(event.payload),
  };
}

/** Builds the `stream.gap` re-sync frame — no `id:` line, since it names no real event. */
function buildGapFrame(oldestRetainedId: number): M3LSseFrame {
  return {
    event: GAP_EVENT_NAME,
    data: JSON.stringify({ oldestRetainedId }),
  };
}

/**
 * Builds the `stream.end` terminal frame — no `id:` line, since (like
 * {@link buildGapFrame}) it names no real published event. Carries `reason`
 * so a watcher can distinguish a run that finished (`"completed"`) from the
 * server shutting down with the watcher still attached (`"draining"`).
 */
function buildEndFrame(reason: M3LStreamEndReason): M3LSseFrame {
  return {
    event: END_EVENT_NAME,
    data: JSON.stringify({ reason }),
  };
}

/** Parses the `Last-Event-ID` header into a non-negative integer, or `undefined` when absent/malformed. */
function parseLastEventId(
  headers: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = headers[LAST_EVENT_ID_HEADER];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Ensures `onDone` runs at most once, guarding against both the abort listener and `onEnd` firing. */
function once(onDone: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    onDone();
  };
}

/**
 * Opens a live subscription against `stream`, forwarding every delivered
 * event (and any resume gap) to `sink`, and resolves once `signal` aborts or
 * the stream itself ends.
 */
function openActiveStream(
  stream: M3LEventStream<M3LRunStreamEvent>,
  sink: M3LStreamSink,
  lastEventId: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Declared and assigned as two separate statements, deliberately: a
    // combined `const subscription = stream.subscribe(...)` would leave
    // `subscription` in its temporal dead zone for the duration of the
    // `subscribe` call — and `subscribe`'s own `onEnd` can fire
    // *synchronously*, inside that call, for a stream that is already ended
    // when subscribed to. `finish` (called from `onEnd`) reads `subscription`,
    // so it must already be a defined (if still `undefined`) binding by then.
    let subscription: M3LStreamSubscription | undefined = undefined;
    const finish = once(() => {
      subscription?.unsubscribe();
      resolve();
    });
    subscription = stream.subscribe({
      onEvent: (event) => {
        if (!sink.closed) sink.emit(frameForEvent(event));
      },
      onGap: (oldestRetainedId) => {
        if (!sink.closed) sink.emit(buildGapFrame(oldestRetainedId));
      },
      onEnd: (reason) => {
        if (!sink.closed) sink.emit(buildEndFrame(reason));
        finish();
      },
      ...(lastEventId !== undefined && { lastEventId }),
    });
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", () => finish(), { once: true });
  });
}

/**
 * Replays whatever `hub` has retained for `id` (if any) and resolves
 * immediately — the terminal-run path (see this module's own TSDoc for why
 * it never subscribes live). Honours `lastEventId` exactly as the active path
 * does: `subscribe` on an already-ended stream runs `dispatchResume`
 * synchronously, so the backlog (or a single `onGap` frame, when the
 * requested id has fallen off retention) is fully delivered to `sink` before
 * `subscribe` returns — `unsubscribe()` immediately after is safe and needed
 * only to release the subscription, not to wait for delivery.
 *
 * A header-less watcher defaults to `0` (full retained replay) explicitly,
 * rather than relying on `subscribe`'s own "omitted `lastEventId` on an
 * already-ended stream substitutes `0`" behaviour: that substitution keys off
 * whether the *hub stream itself* has had `.end()` called on it, which is not
 * the same moment as this route's registry-status "terminal" check — a
 * watcher can arrive in the narrow window where the run is registry-terminal
 * but `runs/stream-events.ts`'s sink has not yet called `stream.end()`. In
 * that window an omitted `lastEventId` would leave `subscribe`'s own default
 * as `undefined`, and `dispatchResume` no-ops on `undefined` — silently
 * dropping the entire backlog instead of replaying it.
 */
function replayTerminalStream(
  hub: M3LEventStreamHub<M3LRunStreamEvent>,
  id: string,
  sink: M3LStreamSink,
  lastEventId: number | undefined,
): Promise<void> {
  const stream = hub.get(id);
  if (stream === undefined) return Promise.resolve();
  const subscription = stream.subscribe({
    onEvent: (event) => {
      if (!sink.closed) sink.emit(frameForEvent(event));
    },
    onGap: (oldestRetainedId) => {
      if (!sink.closed) sink.emit(buildGapFrame(oldestRetainedId));
    },
    // Fires synchronously, inside this very `subscribe()` call, when `stream`
    // has already been ended (the common case here — see this function's own
    // TSDoc) — so the terminal frame lands before this function returns.
    onEnd: (reason) => {
      if (!sink.closed) sink.emit(buildEndFrame(reason));
    },
    lastEventId: lastEventId ?? 0,
  });
  subscription.unsubscribe();
  return Promise.resolve();
}

/** Builds the stream response for an active (`queued`/`running`) run. */
function buildActiveStreamResponse(
  hub: M3LEventStreamHub<M3LRunStreamEvent>,
  id: string,
  ctx: M3LRequestContext,
): M3LConsoleStreamResponse {
  const stream = hub.get(id) ?? hub.open(id);
  const lastEventId = parseLastEventId(ctx.headers);
  return {
    kind: "stream",
    status: STATUS_OK,
    headers: { "content-type": SSE_CONTENT_TYPE },
    open: (sink) => openActiveStream(stream, sink, lastEventId, ctx.signal),
  };
}

/** Builds the stream response for an already-terminal run. */
function buildTerminalStreamResponse(
  hub: M3LEventStreamHub<M3LRunStreamEvent>,
  id: string,
  ctx: M3LRequestContext,
): M3LConsoleStreamResponse {
  const lastEventId = parseLastEventId(ctx.headers);
  return {
    kind: "stream",
    status: STATUS_OK,
    headers: { "content-type": SSE_CONTENT_TYPE },
    open: (sink) => replayTerminalStream(hub, id, sink, lastEventId),
  };
}

/** Builds the `GET /api/v1/runs/:id/stream` handler. */
function buildStreamHandler(options: RunStreamRouteOptions): M3LConsoleHandler {
  return (ctx) => {
    const id = ctx.params["id"];
    if (id === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "missing ':id' route parameter",
      );
    }
    const row = options.registry.get(id);
    if (row === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_NOT_FOUND",
        `no run found with id '${id}'`,
      );
    }
    return isActiveStatus(row.status)
      ? buildActiveStreamResponse(options.hub, id, ctx)
      : buildTerminalStreamResponse(options.hub, id, ctx);
  };
}

/**
 * Builds the single-route table for `GET /api/v1/runs/:id/stream`,
 * `auth: "required"`.
 *
 * @param options - See {@link RunStreamRouteOptions}.
 * @returns The one-route table.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 * import { createRunStreamRoutes } from "@m3l-automation/m3l-console-server/http/routes/run-stream.js";
 *
 * const routes = createRunStreamRoutes({
 *   hub: createEventStreamHub({ bufferSize: 100 }),
 *   registry: { get: () => ({ status: "running" }) },
 * });
 * ```
 */
export function createRunStreamRoutes(
  options: RunStreamRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/runs/:id/stream",
      auth: "required",
      handler: buildStreamHandler(options),
    },
  ];
}
