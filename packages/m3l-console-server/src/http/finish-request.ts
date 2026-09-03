/**
 * `http/finish-request` — the request-completion tail: writes the response
 * (guarded against a throw from {@link writeResponse}), releases the
 * composite abort signal, and logs the request's outcome line. Extracted
 * from `handler.ts` to stay under `check:file-budget`'s ceiling.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from "node:http";

import type { Core } from "@m3l-automation/m3l-common";

import { logOutcome } from "./access-log.js";
import type { RequestFaultContext } from "./access-log.js";
import { writeResponse } from "./respond.js";
import type { M3LConsoleResponse } from "./respond.js";
import type { M3LRouteAuth } from "./router.js";
import type { M3LStreamWriteOutcome } from "./stream-writer.js";

/** The status the last-resort fallback response writes when {@link writeResponse} itself throws. */
const STATUS_INTERNAL_SERVER_ERROR = 500;

/**
 * Last-resort recovery when {@link writeResponse} itself throws (e.g. an
 * out-of-range status or a header value `res.writeHead` rejects): writes a
 * bare 500 and ends the socket so a request can never finish with an open
 * connection and no log line. Every step is individually best-effort —
 * `res` may already be in a state where even this fails — since the
 * overriding goal is for `handler.ts`'s `runRequest` to reach its
 * `logOutcome` call, not for this recovery path itself to succeed.
 */
function writeFallbackResponse(res: ServerResponse): void {
  try {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(STATUS_INTERNAL_SERVER_ERROR);
    }
  } catch {
    // best-effort: nothing more can be done if even the fallback header
    // write fails; still attempt to end the response below.
  }
  try {
    if (!res.writableEnded) res.end();
  } catch {
    // best-effort: the socket may already be closed.
  }
}

/**
 * Writes `response` to `res`, guarded: a throw from {@link writeResponse}
 * (e.g. an out-of-range status or a header value `res.writeHead` rejects)
 * must never leave the socket open with no log line, so this falls back to
 * a bare 500 rather than letting the throw escape to the outer `.catch`,
 * which only logs and never touches the socket. A failed write is always a
 * genuine fault — never a routine caller-origin outcome — so its
 * {@link Core.M3LLogger.errorFrom} diagnostic line is unconditional, unlike
 * `access-log.ts`'s `logDiagnosticIfFault`.
 */
function writeResponseGuarded(
  res: ServerResponse,
  response: M3LConsoleResponse,
  context: RequestFaultContext,
  logger: Core.M3LLogger,
): void {
  try {
    writeResponse(res, response, context.correlationId);
  } catch (writeError) {
    logger.errorFrom(
      writeError,
      `failed writing response for ${context.method} ${context.path} (correlationId=${context.correlationId})`,
    );
    writeFallbackResponse(res);
  }
}

/** Inputs for {@link finishRequest}. */
export interface FinishRequestInputs {
  readonly res: ServerResponse;
  readonly response: M3LConsoleResponse;
  readonly context: RequestFaultContext;
  readonly connectionController: AbortController;
  readonly startedAt: number;
  readonly now: () => number;
  readonly accessMode: M3LRouteAuth | undefined;
  readonly logger: Core.M3LLogger;
  /**
   * `false` for a stream result: `resolveDispatchedResult` already wrote the
   * head and every frame via `writeStream`, and writing `response` here too
   * (a synthetic, empty-bodied stand-in) would double-write the socket.
   */
  readonly write: boolean;
  /** The stream's frame/drop counts and stop reason, present only for a stream result. */
  readonly streamOutcome?: M3LStreamWriteOutcome;
}

/**
 * Writes `response`, releases the composite abort signal, and logs the
 * request's outcome line — the tail shared by every completion path through
 * `handler.ts`'s `runRequest`.
 *
 * Releasing the composite `signal` — built as
 * `AbortSignal.any([options.signal, connectionController.signal])` and
 * threaded through as `ctx.signal` — is a fix for a MEASURED leak (Node
 * v26.7.0): a composite whose sources are both
 * still open is normally collectable, but the moment anything attaches an
 * `abort` listener to it and never removes it — exactly what `ctx.signal`
 * exists for (pollers, X4's run orchestration) — the still-open long-lived
 * `options.signal` (the drain signal, which lives as long as the server)
 * pins the composite for the rest of the process. Aborting
 * `connectionController` here releases that pin on every completion path
 * (2xx, a thrown/rejected handler, an unmatched 404/405, or a `preRouting`
 * short-circuit).
 *
 * ORDER IS LOAD-BEARING: the abort MUST run after the write — after
 * {@link writeResponseGuarded} for a buffered response (`inputs.write`), or,
 * for a stream, after `resolveDispatchedResult`'s own `writeStream` call has
 * already returned by the time `finishRequest` is even invoked — never
 * before either. Aborting first would cancel the very write/stream it is
 * meant to follow (a listener on `ctx.signal` could tear down mid-write).
 * This is NOT redundant with the `onClose` listener in `handler.ts`'s
 * `runRequest`: that only fires on an early client disconnect, not on
 * ordinary completion, so most requests would otherwise never release the
 * pin.
 */
export function finishRequest(inputs: FinishRequestInputs): void {
  if (inputs.write) {
    writeResponseGuarded(
      inputs.res,
      inputs.response,
      inputs.context,
      inputs.logger,
    );
  }

  inputs.connectionController.abort();

  logOutcome(inputs.logger, {
    method: inputs.context.method,
    path: inputs.context.path,
    status: inputs.response.status,
    durationMs: inputs.now() - inputs.startedAt,
    correlationId: inputs.context.correlationId,
    accessMode: inputs.accessMode,
    ...(inputs.streamOutcome !== undefined && {
      streamOutcome: inputs.streamOutcome,
    }),
  });
}
