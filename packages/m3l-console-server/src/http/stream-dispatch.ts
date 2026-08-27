/**
 * `http/stream-dispatch` — resolves a dispatched {@link M3LConsoleResult}
 * down to what `http/handler.ts`'s `runRequest` needs at its tail (X4,
 * ADR-0066). Split out from `handler.ts` purely for file-size budget
 * reasons — `handler.ts`'s own header documents that ceiling.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from "node:http";

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleResponse } from "./respond.js";
import { isStreamResponse } from "./stream-response.js";
import type { M3LConsoleResult } from "./stream-response.js";
import { writeStream } from "./stream-writer.js";
import type { M3LStreamWriteOutcome } from "./stream-writer.js";

/** Default heartbeat interval (ms) a stream emits while `open()` is pending. */
const DEFAULT_STREAM_HEARTBEAT_MS = 30_000;
/** Default unflushed-backlog ceiling (bytes) past which a stream frame is dropped. */
const DEFAULT_STREAM_MAX_PENDING_BYTES = 1_000_000;
/** Default SSE `retry:` interval (ms) told to a reconnecting client. */
const DEFAULT_STREAM_RETRY_MS = 2_000;

/**
 * The knobs {@link resolveDispatchedResult} threads through to `writeStream`
 * for a stream result. Every knob is optional because `http` may not import
 * `config/` — a caller (e.g. `main.ts`) supplies its own configured value
 * once one exists; until then the documented defaults apply.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const options: StreamDispatchOptions = { logger: new Core.M3LLogger([]) };
 * ```
 */
export interface StreamDispatchOptions {
  /** The logger `writeStream` reports a write/open failure through. */
  readonly logger: Core.M3LLogger;
  /** Heartbeat interval (ms) while `open()` is pending; defaults to `30_000`. */
  readonly heartbeatMs?: number;
  /** The unflushed-backlog ceiling (bytes); defaults to `1_000_000`. */
  readonly maxPendingBytes?: number;
  /** The SSE `retry:` interval (ms); defaults to `2_000`. */
  readonly retryMs?: number;
}

/** What `runRequest`'s tail needs once a dispatched {@link M3LConsoleResult} is resolved. */
export interface ResolvedDispatch {
  /** A response `finishRequest` can log — and, for a buffered result, still needs to write. */
  readonly response: M3LConsoleResponse;
  /** `true` once the wire write already happened here, so `finishRequest` must skip it. */
  readonly wroteAlready: boolean;
  /** The stream's frame/drop counts and stop reason, present only for a stream result. */
  readonly streamOutcome?: M3LStreamWriteOutcome;
}

/**
 * Resolves a dispatched {@link M3LConsoleResult} down to what `runRequest`'s
 * tail needs. A buffered result passes through untouched — `finishRequest`
 * still writes it, exactly as before streaming existed. A stream result is
 * pumped to completion right here via {@link writeStream}: `runRequest`
 * awaits this call from inside its own `try`, so the close-listener removal
 * and the `finishRequest` tail that follow only run once the stream itself
 * has ended — never at `open()` (X4's Bugs 1 and 2). The returned synthetic
 * response carries only `result.status`; its `headers`/`body` are never
 * written, since `wroteAlready: true` tells `finishRequest` to skip the
 * write (the real head and every frame were already written by
 * `writeStream`).
 *
 * @param res - The underlying `node:http` response.
 * @param result - The dispatched route result, buffered or a stream.
 * @param correlationId - The request's correlation id.
 * @param options - See {@link StreamDispatchOptions}.
 * @returns The resolved dispatch (see {@link ResolvedDispatch}).
 *
 * @example
 * ```ts
 * import type { ServerResponse } from "node:http";
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * import { resolveDispatchedResult } from "@m3l-automation/m3l-console-server/http/stream-dispatch.js";
 * import type { M3LConsoleResult } from "@m3l-automation/m3l-console-server/http/stream-response.js";
 *
 * async function tail(res: ServerResponse, result: M3LConsoleResult): Promise<void> {
 *   const resolved = await resolveDispatchedResult(res, result, "corr-1", {
 *     logger: new Core.M3LLogger([]),
 *   });
 *   if (resolved.wroteAlready) {
 *     // the stream already wrote the head and every frame
 *   }
 * }
 * ```
 */
export async function resolveDispatchedResult(
  res: ServerResponse,
  result: M3LConsoleResult,
  correlationId: string,
  options: StreamDispatchOptions,
): Promise<ResolvedDispatch> {
  if (!isStreamResponse(result)) {
    return { response: result, wroteAlready: false };
  }
  const streamOutcome = await writeStream({
    res,
    response: result,
    correlationId,
    logger: options.logger,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_STREAM_HEARTBEAT_MS,
    maxPendingBytes:
      options.maxPendingBytes ?? DEFAULT_STREAM_MAX_PENDING_BYTES,
    retryMs: options.retryMs ?? DEFAULT_STREAM_RETRY_MS,
  });
  return {
    response: { status: result.status, headers: {}, body: "" },
    wroteAlready: true,
    streamOutcome,
  };
}
