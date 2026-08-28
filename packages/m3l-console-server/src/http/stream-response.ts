/**
 * `http/stream-response` — widens a route's result type to allow a
 * streaming response alongside the existing buffered
 * {@link M3LConsoleResponse} (X4, ADR-0066, slice 2).
 *
 * {@link M3LConsoleResponse} deliberately carries no `kind` field — that
 * omission is load-bearing, not an oversight. It is what lets every
 * existing buffered call site (every handler and middleware written before
 * streaming existed) keep compiling unchanged against the widened
 * {@link M3LConsoleResult}, and it is why `respond.ts`'s `writeResponse`
 * signature does not need to change: `writeResponse` only ever receives an
 * `M3LConsoleResponse`, never a stream, so its parameter type is untouched.
 * A stream is instead recognized by the presence of `kind: "stream"`
 * ({@link isStreamResponse}), a discriminant only the new variant has.
 *
 * @packageDocumentation
 */

import type { M3LSseFrame } from "./sse.js";
import type { M3LConsoleResponse } from "./respond.js";

/**
 * The write side of a stream a route hands frames to. A route calls
 * `emit()` as output becomes available and reads `closed` to stop producing
 * once the client is gone; it never touches `node:http` directly.
 *
 * @example
 * ```ts
 * function forward(sink: M3LStreamSink, frame: M3LSseFrame): void {
 *   if (!sink.closed) sink.emit(frame);
 * }
 * ```
 */
export interface M3LStreamSink {
  /**
   * Hands one frame to the underlying transport. Never throws — a write
   * failure (e.g. the client disconnected) is the sink's own concern, not
   * the emitting route's.
   *
   * @param frame - The frame to write.
   */
  emit(frame: M3LSseFrame): void;
  /** `true` once the client has gone away; further `emit` calls are inert. */
  readonly closed: boolean;
}

/**
 * A streaming route result: after the transport writes `status`/`headers`,
 * it calls `open(sink)` and keeps the connection alive until that promise
 * settles.
 *
 * @example
 * ```ts
 * const stream: M3LConsoleStreamResponse = {
 *   kind: "stream",
 *   status: 200,
 *   headers: { "content-type": "text/event-stream" },
 *   open: async (sink) => {
 *     sink.emit({ event: "run.output", data: "hello" });
 *   },
 * };
 * ```
 */
export interface M3LConsoleStreamResponse {
  /** Discriminant distinguishing a stream from a buffered `M3LConsoleResponse`. */
  readonly kind: "stream";
  /** The HTTP status code to write before opening the stream. */
  readonly status: number;
  /** Response headers to write before opening the stream. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Opens the stream against `sink`. The connection stays alive until this
   * promise settles.
   *
   * @param sink - The write side of the stream.
   */
  readonly open: (sink: M3LStreamSink) => Promise<void>;
}

/**
 * A route's result: either a fully-buffered {@link M3LConsoleResponse} or a
 * {@link M3LConsoleStreamResponse}. Every existing handler already returns
 * an `M3LConsoleResponse`, which is assignable to `M3LConsoleResult`
 * unchanged.
 */
export type M3LConsoleResult = M3LConsoleResponse | M3LConsoleStreamResponse;

/**
 * Narrows `result` to {@link M3LConsoleStreamResponse}.
 *
 * @param result - The route result to test.
 * @returns `true` when `result` is a stream response.
 *
 * @example
 * ```ts
 * import { isStreamResponse } from "@m3l-automation/m3l-console-server/http/stream-response.js";
 *
 * function describe(result: M3LConsoleResult): string {
 *   return isStreamResponse(result) ? "stream" : "buffered";
 * }
 * ```
 */
export function isStreamResponse(
  result: M3LConsoleResult,
): result is M3LConsoleStreamResponse {
  return "kind" in result && result.kind === "stream";
}

/**
 * Ensures `onComplete` fires exactly once no matter how many times the
 * returned function is invoked. Guards against a double release corrupting
 * the drain controller's `inFlight` count if `open()`'s settlement is
 * observed from more than one path.
 *
 * @param onComplete - The callback to guard.
 * @returns A function that calls `onComplete` on its first invocation only.
 */
function once(onComplete: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    onComplete();
  };
}

/**
 * Wraps `open` so `release` fires exactly once when the returned promise
 * settles, on both the resolve and the reject path, with a rejection
 * propagating unchanged.
 *
 * @param open - The stream's own `open` function.
 * @param release - The guarded, at-most-once completion callback.
 * @returns The wrapped `open` function.
 */
function wrapOpenWithCompletion(
  open: M3LConsoleStreamResponse["open"],
  release: () => void,
): M3LConsoleStreamResponse["open"] {
  return async (sink) => {
    try {
      await open(sink);
    } finally {
      release();
    }
  };
}

/**
 * Defers `onComplete` until a route's result is fully done, fixing a
 * drain-release gap: `http/drain-middleware.ts` releases its tracked drain
 * unit in a `finally` once `next()` resolves, which for a streaming route
 * is at *open*, not at stream completion. Without this wrapper, an open
 * stream would be invisible to the drain controller's `inFlight` count,
 * letting it reach zero while watchers are still attached — so a shutdown
 * would hand every watcher an abrupt `ECONNRESET` instead of a clean end.
 *
 * For a buffered {@link M3LConsoleResponse}, `onComplete` fires immediately
 * and `result` is returned unchanged by identity (no existing buffered call
 * site is affected). For a {@link M3LConsoleStreamResponse}, `onComplete` is
 * deferred: it is not called at wrap time, only when the returned result's
 * `open()` promise settles — exactly once, whether `open()` resolves or
 * rejects, with a rejection propagating unchanged. `status`, `headers`, and
 * `kind` are preserved; only `open` is replaced.
 *
 * @param result - The route result to wrap.
 * @param onComplete - Called exactly once when `result` is fully done.
 * @returns `result` unchanged for a buffered response, or a new stream
 *   response with a wrapped `open` for a streaming one.
 *
 * @example
 * ```ts
 * import { withStreamCompletion } from "@m3l-automation/m3l-console-server/http/stream-response.js";
 *
 * const wrapped = withStreamCompletion(result, () => release());
 * ```
 */
export function withStreamCompletion(
  result: M3LConsoleResult,
  onComplete: () => void,
): M3LConsoleResult {
  if (!isStreamResponse(result)) {
    onComplete();
    return result;
  }

  const release = once(onComplete);
  return {
    kind: result.kind,
    status: result.status,
    headers: result.headers,
    open: wrapOpenWithCompletion(result.open, release),
  };
}
