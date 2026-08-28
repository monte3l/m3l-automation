/**
 * `http/stream-writer` — pumps an {@link M3LConsoleStreamResponse}'s frames
 * onto a real `node:http` `ServerResponse` (X4, ADR-0066, slice 3).
 *
 * `respond.ts`'s `writeResponse` cannot be reused here: it sets
 * `content-length` and calls `res.end()`, both fatal to a stream. This
 * module owns the whole stream lifecycle instead — the head, the initial
 * `retry:` directive, backpressure-aware frame writes, the heartbeat, and
 * client-disconnect detection — behind one function that never throws and
 * never rejects, so a route's failure (or a client going away) degrades the
 * connection instead of crashing the request listener.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from "node:http";

import type { Core } from "@m3l-automation/m3l-common";

import { encodeSseComment, encodeSseFrame, encodeSseRetry } from "./sse.js";
import type { M3LSseFrame } from "./sse.js";
import type {
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "./stream-response.js";

/** The `content-type` every SSE stream is served as. */
const SSE_CONTENT_TYPE = "text/event-stream";
/** A stream is always dynamic; never cache it. */
const CACHE_CONTROL_NO_STORE = "no-store";
/** Keeps the underlying socket open for the life of the stream. */
const CONNECTION_KEEP_ALIVE = "keep-alive";
/** Blocks MIME-sniffing, same hardening `respond.ts` applies. */
const NO_SNIFF_HEADER_VALUE = "nosniff";
/** The fixed comment text every heartbeat frame carries (shape-only per contract). */
const HEARTBEAT_COMMENT_TEXT = "heartbeat";
/** The event name of the re-sync signal emitted after a drop. */
const GAP_EVENT_NAME = "stream.gap";
/** The header name stripped from a route's own headers (see {@link stripContentLength}). */
const CONTENT_LENGTH_HEADER = "content-length";

/**
 * The result of pumping one stream to completion. `frames`/`dropped` count
 * only frames the route itself pushed through {@link M3LStreamSink.emit} —
 * the initial `retry:` frame, any heartbeat comment, and the `stream.gap`
 * frame are transport-internal and are never counted here.
 *
 * @example
 * ```ts
 * function summarize(outcome: M3LStreamWriteOutcome): string {
 *   return `${String(outcome.frames)} frames, ${String(outcome.dropped)} dropped (${outcome.reason})`;
 * }
 * ```
 */
export interface M3LStreamWriteOutcome {
  /** Count of route-emitted frames successfully written to the socket. */
  readonly frames: number;
  /** Count of route-emitted frames dropped for backpressure. */
  readonly dropped: number;
  /** Why the stream stopped. */
  readonly reason: "completed" | "client-disconnected" | "write-failed";
}

/**
 * Inputs to {@link writeStream}.
 *
 * @example
 * ```ts
 * import type { ServerResponse } from "node:http";
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * function buildOptions(
 *   res: ServerResponse,
 *   response: WriteStreamOptions["response"],
 * ): WriteStreamOptions {
 *   return {
 *     res,
 *     response,
 *     correlationId: "corr-1",
 *     logger: new Core.M3LLogger([]),
 *     heartbeatMs: 30_000,
 *     maxPendingBytes: 1_000_000,
 *     retryMs: 2_000,
 *   };
 * }
 * ```
 */
export interface WriteStreamOptions {
  /** The underlying `node:http` response to write onto. */
  readonly res: ServerResponse;
  /** The route's stream result. */
  readonly response: M3LConsoleStreamResponse;
  /** The request's correlation id, echoed as a header and used in log lines. */
  readonly correlationId: string;
  /** The only sanctioned output channel for a failure this module catches. */
  readonly logger: Core.M3LLogger;
  /** Interval, in ms, between heartbeat comment frames while `open()` is pending. */
  readonly heartbeatMs: number;
  /** The unflushed-backlog ceiling (bytes) past which a route frame is dropped. */
  readonly maxPendingBytes: number;
  /** The SSE `retry:` interval, in ms, told to a reconnecting client. */
  readonly retryMs: number;
}

/**
 * Mutable bookkeeping for one stream's lifetime, encapsulated behind methods
 * so every mutation happens on `this` rather than on a function parameter
 * (`no-param-reassign` forbids the latter) — every helper below reads and
 * mutates a `StreamWriteState` instance exclusively through this API.
 */
class StreamWriteState {
  private pendingBytes = 0;
  private frameCount = 0;
  private droppedCount = 0;
  private isClosed = false;
  private hasWriteFailed = false;
  private lastWrittenFrameId: number | undefined = undefined;
  private gapPending = false;

  /** `true` once the client has disconnected. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** The id of the last route frame successfully written, if any. */
  get lastWrittenId(): number | undefined {
    return this.lastWrittenFrameId;
  }

  /** `true` while writes are still meaningful — neither disconnected nor already broken. */
  canWrite(): boolean {
    return !this.isClosed && !this.hasWriteFailed;
  }

  /**
   * `true` when the backlog left by *earlier* writes has not yet reached
   * `maxPendingBytes`. Checked before writing, never counting a write's own
   * size toward its own admission — see {@link writeSinkFrame}.
   */
  admitsBacklog(maxPendingBytes: number): boolean {
    return this.pendingBytes < maxPendingBytes;
  }

  /** Records that `chunkBytes` more bytes are sitting unflushed. */
  addPending(chunkBytes: number): void {
    this.pendingBytes += chunkBytes;
  }

  /** Resets the unflushed backlog to `0` — the faithful mapping of Node's own `"drain"`. */
  resetPending(): void {
    this.pendingBytes = 0;
  }

  /** Marks the client as gone; further writes become inert. */
  markClosed(): void {
    this.isClosed = true;
  }

  /** Marks a `res.write` as having thrown; further writes become inert. */
  markWriteFailed(): void {
    this.hasWriteFailed = true;
  }

  /** Records one route frame dropped for backpressure, owing a `stream.gap`. */
  recordDrop(): void {
    this.droppedCount += 1;
    this.gapPending = true;
  }

  /** Records one route frame successfully written. */
  recordFrameWritten(id: number | undefined): void {
    this.frameCount += 1;
    if (id !== undefined) this.lastWrittenFrameId = id;
  }

  /** Atomically reads and clears whether a `stream.gap` is owed. */
  consumeGapPending(): boolean {
    const had = this.gapPending;
    this.gapPending = false;
    return had;
  }

  /** Why the stream stopped, per {@link M3LStreamWriteOutcome.reason}. */
  private reason(): M3LStreamWriteOutcome["reason"] {
    if (this.isClosed) return "client-disconnected";
    if (this.hasWriteFailed) return "write-failed";
    return "completed";
  }

  /** The final {@link M3LStreamWriteOutcome} implied by this state. */
  toOutcome(): M3LStreamWriteOutcome {
    return {
      frames: this.frameCount,
      dropped: this.droppedCount,
      reason: this.reason(),
    };
  }
}

/** Omits `content-length` (case-insensitively) — a route must never set it on a stream. */
function stripContentLength(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== CONTENT_LENGTH_HEADER,
    ),
  );
}

/**
 * Writes the SSE-critical status/headers and flushes them, so the client
 * sees the head before the first frame. The status written is
 * `response.status` (PR #718 review, defect 3) — a route's own status is
 * honoured, never silently overridden by a fixed constant, since a stream
 * result is not always 200 (e.g. a resumed stream might reasonably answer
 * `206`). Stream-critical headers are merged in *after* the route's own
 * `response.headers`, so a route cannot accidentally override any of them —
 * and `content-length` is stripped outright, since its absence is what
 * makes the response a stream.
 */
function writeStreamHead(
  res: ServerResponse,
  response: M3LConsoleStreamResponse,
  correlationId: string,
): void {
  res.writeHead(response.status, {
    ...stripContentLength(response.headers),
    "content-type": SSE_CONTENT_TYPE,
    "cache-control": CACHE_CONTROL_NO_STORE,
    connection: CONNECTION_KEEP_ALIVE,
    "x-content-type-options": NO_SNIFF_HEADER_VALUE,
    "x-correlation-id": correlationId,
  });
  res.flushHeaders();
}

/**
 * Writes one already-encoded chunk. Never throws: a `res.write` failure is
 * caught, logged, and recorded on `state` instead of propagating — the
 * counterpart of `stream/`'s own decision to propagate a listener throw,
 * since this layer (unlike `stream/`) owns a logger and so owns not
 * throwing. Returns whether the write itself succeeded (regardless of the
 * backpressure signal `res.write` returns).
 */
function attemptWrite(
  res: ServerResponse,
  state: StreamWriteState,
  chunk: string,
  logger: Core.M3LLogger,
  correlationId: string,
): boolean {
  try {
    const flushedSynchronously = res.write(chunk);
    if (!flushedSynchronously) {
      state.addPending(Buffer.byteLength(chunk, "utf8"));
    }
    return true;
  } catch (cause) {
    logger.errorFrom(cause, `stream write failed (run ${correlationId})`);
    state.markWriteFailed();
    return false;
  }
}

/**
 * Writes a transport-internal control frame (the initial `retry:`, a
 * heartbeat comment, or a `stream.gap` re-sync signal): gated by the same
 * backpressure ceiling as a route frame, but never touching
 * `frames`/`dropped`/the gap flag — those exist only for what the route
 * itself pushed through {@link M3LStreamSink.emit}.
 */
function writeControlFrame(
  res: ServerResponse,
  state: StreamWriteState,
  maxPendingBytes: number,
  chunk: string,
  logger: Core.M3LLogger,
  correlationId: string,
): void {
  if (!state.canWrite() || !state.admitsBacklog(maxPendingBytes)) return;
  attemptWrite(res, state, chunk, logger, correlationId);
}

/**
 * Encodes `frame`, or `undefined` if it is invalid. `encodeSseFrame` throws
 * on a non-positive-integer `id` or a newline-bearing `event` — its own
 * documented contract for those internal control values — but
 * `M3LStreamSink.emit`'s contract is "never throws" (PR #718 review, defect
 * 4), so a bad frame from a route must be logged and skipped, never let the
 * throw escape mid-stream and abort every later, valid frame from the same
 * route.
 */
function encodeSinkFrame(
  frame: M3LSseFrame,
  logger: Core.M3LLogger,
  correlationId: string,
): string | undefined {
  try {
    return encodeSseFrame(frame);
  } catch (cause) {
    logger.errorFrom(
      cause,
      `dropped an invalid SSE frame (run ${correlationId})`,
    );
    return undefined;
  }
}

/**
 * Writes one route-emitted frame, or drops it. Backpressure is `>=`,
 * checked *before* writing: once the backlog left by earlier frames reaches
 * `maxPendingBytes`, this frame is dropped without ever calling
 * `res.write` — a frame's own size is never counted toward its own
 * admission, so `maxPendingBytes` states a real, reachable ceiling rather
 * than a value every frame overshoots by construction. An invalid frame
 * (see {@link encodeSinkFrame}) is likewise never written, but is not
 * counted as a backpressure drop — it never reached the backlog at all.
 */
function writeSinkFrame(
  res: ServerResponse,
  state: StreamWriteState,
  maxPendingBytes: number,
  frame: M3LSseFrame,
  logger: Core.M3LLogger,
  correlationId: string,
): void {
  if (!state.canWrite()) return;
  if (!state.admitsBacklog(maxPendingBytes)) {
    state.recordDrop();
    return;
  }
  const encoded = encodeSinkFrame(frame, logger, correlationId);
  if (encoded === undefined) return;
  const wrote = attemptWrite(res, state, encoded, logger, correlationId);
  if (!wrote) return;
  state.recordFrameWritten(frame.id);
}

/** Builds the `stream.gap` re-sync frame — no `id:` line (see module docs on {@link attachDrainListener}). */
function buildGapFrame(lastWrittenId: number | undefined): M3LSseFrame {
  return {
    event: GAP_EVENT_NAME,
    data: JSON.stringify({ lastEventId: lastWrittenId }),
  };
}

/**
 * Wires the sink a route writes through: `emit` routes each frame through
 * {@link writeSinkFrame}; `closed` mirrors `state.closed` so a polling
 * route can stop producing once the client is gone.
 */
function createSink(
  res: ServerResponse,
  state: StreamWriteState,
  options: WriteStreamOptions,
): M3LStreamSink {
  return {
    emit: (frame) => {
      writeSinkFrame(
        res,
        state,
        options.maxPendingBytes,
        frame,
        options.logger,
        options.correlationId,
      );
    },
    get closed() {
      return state.closed;
    },
  };
}

/**
 * Attaches the `"drain"` listener for the lifetime of `res`: Node emits
 * `"drain"` once the socket buffer has fully emptied, so resetting `pending`
 * to `0` (rather than decrementing) is the faithful mapping. When a drop
 * happened since the last gap, exactly one `stream.gap` frame is sent,
 * naming the *last id successfully written* — never the last attempted,
 * since only a written id is a safe re-sync pointer for a reconnecting
 * client, and the frame carries no `id:` line of its own (one would move
 * the client's `Last-Event-ID` cursor to a synthetic value that never
 * corresponded to a real event). Deliberately never removed: a drain can
 * still arrive after the route has finished producing, and a queued gap
 * must still reach the client.
 */
function attachDrainListener(
  res: ServerResponse,
  state: StreamWriteState,
  options: WriteStreamOptions,
): void {
  res.on("drain", () => {
    state.resetPending();
    if (!state.consumeGapPending()) return;
    writeControlFrame(
      res,
      state,
      options.maxPendingBytes,
      encodeSseFrame(buildGapFrame(state.lastWrittenId)),
      options.logger,
      options.correlationId,
    );
  });
}

/**
 * Starts the heartbeat: a `setInterval` emitting a comment-shaped control
 * frame every `heartbeatMs` while `open()` is still pending. `unref()`'d so
 * it can never hold the process open on its own. Returns a `stop` callable
 * that clears the timer once `open()` settles.
 */
function startHeartbeat(
  res: ServerResponse,
  state: StreamWriteState,
  options: WriteStreamOptions,
): () => void {
  const timer = setInterval(() => {
    writeControlFrame(
      res,
      state,
      options.maxPendingBytes,
      encodeSseComment(HEARTBEAT_COMMENT_TEXT),
      options.logger,
      options.correlationId,
    );
  }, options.heartbeatMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/**
 * Owns the independent `"close"` disconnect detector: a listener directly
 * on `res`, deliberately separate from any request-level one, since a
 * request-level listener removed once a handler *returns* (which for a
 * stream is at *open*) would leave a mid-stream disconnect undetected.
 * `promise` resolves the moment `"close"` fires, letting `writeStream` race
 * it against the route's own `open()`.
 */
function createCloseSignal(
  res: ServerResponse,
  state: StreamWriteState,
): { readonly promise: Promise<void>; readonly dispose: () => void } {
  let handler: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    handler = () => {
      state.markClosed();
      resolve();
    };
    res.on("close", handler);
  });
  return {
    promise,
    dispose: () => {
      res.off("close", handler);
    },
  };
}

/** Best-effort ends the response exactly once, never letting a failing `end()` shadow the outcome already computed from `state`. */
function finishStream(res: ServerResponse, options: WriteStreamOptions): void {
  try {
    res.end();
  } catch (cause) {
    options.logger.errorFrom(
      cause,
      `stream end() failed (run ${options.correlationId})`,
    );
  }
}

/**
 * Encodes the initial `retry:` directive, or `undefined` if `retryMs` is
 * invalid. `encodeSseRetry` throws on a non-negative-integer violation of
 * `retryMs` — its own documented contract for that internal control value —
 * but
 * `writeStream`'s own contract is "never throws and never rejects" (PR #718
 * review, defect 1), so an invalid value reaching it directly must be
 * logged and skipped, never thrown after {@link writeStreamHead} has
 * already written the head (which would leave a caller with no way to send
 * a fallback error response).
 */
function encodeRetryFrame(
  retryMs: number,
  logger: Core.M3LLogger,
  correlationId: string,
): string | undefined {
  try {
    return encodeSseRetry(retryMs);
  } catch (cause) {
    logger.errorFrom(
      cause,
      `skipped an invalid retry: directive (run ${correlationId})`,
    );
    return undefined;
  }
}

/**
 * Writes an SSE stream response to completion: the head, the trailing
 * `retry:` directive, every route-emitted frame (backpressure-aware), a
 * heartbeat while the route is producing, and independent client-disconnect
 * detection. Never throws and never rejects — an invalid `retryMs`/frame, a
 * route's `open()` rejecting, or a `res.write` throwing, is caught, logged
 * via `options.logger`, and reflected in the returned outcome instead of
 * propagating.
 *
 * @param options - See {@link WriteStreamOptions}.
 * @returns The outcome once the stream is done (see {@link M3LStreamWriteOutcome}).
 *
 * @example
 * ```ts
 * import type { ServerResponse } from "node:http";
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * import { writeStream } from "@m3l-automation/m3l-console-server/http/stream-writer.js";
 * import type { M3LConsoleStreamResponse } from "@m3l-automation/m3l-console-server/http/stream-response.js";
 *
 * async function serve(
 *   res: ServerResponse,
 *   response: M3LConsoleStreamResponse,
 * ): Promise<void> {
 *   const outcome = await writeStream({
 *     res,
 *     response,
 *     correlationId: "corr-1",
 *     logger: new Core.M3LLogger([]),
 *     heartbeatMs: 30_000,
 *     maxPendingBytes: 1_000_000,
 *     retryMs: 2_000,
 *   });
 *   if (outcome.reason === "write-failed") {
 *     // already logged by writeStream itself
 *   }
 * }
 * ```
 */
export async function writeStream(
  options: WriteStreamOptions,
): Promise<M3LStreamWriteOutcome> {
  const state = new StreamWriteState();
  writeStreamHead(options.res, options.response, options.correlationId);
  // A client's EventSource can only honor a retry: value it has already
  // received, so this must go out before any route frame — an abrupt
  // disconnect (network drop, SIGKILL) never gives a trailing write a
  // chance to run, and that is exactly the failure mode retry: exists for.
  // The encode is guarded (see encodeRetryFrame) rather than evaluated as a
  // bare argument, so an invalid retryMs is logged and skipped instead of
  // throwing out of writeStream after the head is already written.
  const retryFrame = encodeRetryFrame(
    options.retryMs,
    options.logger,
    options.correlationId,
  );
  if (retryFrame !== undefined) {
    writeControlFrame(
      options.res,
      state,
      options.maxPendingBytes,
      retryFrame,
      options.logger,
      options.correlationId,
    );
  }
  attachDrainListener(options.res, state, options);
  const closeSignal = createCloseSignal(options.res, state);
  const sink = createSink(options.res, state, options);
  const stopHeartbeat = startHeartbeat(options.res, state, options);

  // Raced by literal-tagged branch rather than racing options.response.open(sink)
  // directly: that would make it impossible to tell, once the race settles,
  // whether openPromise itself was the winner (a rejection already handled
  // by the catch below) or closeSignal won while openPromise is still
  // pending — the latter is exactly the case a late .catch() must be
  // attached for (PR #718 review, defect 2), and attaching it unconditionally
  // would double-log a rejection that already settled the race itself.
  const openPromise = options.response.open(sink);
  try {
    const winner = await Promise.race([
      openPromise.then(() => "open" as const),
      closeSignal.promise.then(() => "closed" as const),
    ]);
    if (winner === "closed") {
      // The client disconnected first; open() is still pending. Without
      // this, a later rejection would be silently absorbed by the
      // already-settled race and never surface anywhere.
      void openPromise.catch((cause) => {
        options.logger.errorFrom(
          cause,
          `stream open() rejected after client disconnected (run ${options.correlationId})`,
        );
      });
    }
  } catch (cause) {
    options.logger.errorFrom(
      cause,
      `stream open() failed (run ${options.correlationId})`,
    );
    state.markWriteFailed();
  } finally {
    stopHeartbeat();
    closeSignal.dispose();
  }

  finishStream(options.res, options);

  return state.toOutcome();
}
