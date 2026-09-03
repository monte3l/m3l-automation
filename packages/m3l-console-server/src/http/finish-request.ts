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
import type { M3LTelemetryRecorder } from "../telemetry/port.js";

/** The status the last-resort fallback response writes when {@link writeResponse} itself throws. */
const STATUS_INTERNAL_SERVER_ERROR = 500;

/** The lowest valid HTTP status; anything below this maps to `"other"`. */
const STATUS_CLASS_MIN = 100;
/** One past the highest valid HTTP status; anything at or above this maps to `"other"`. */
const STATUS_CLASS_MAX_EXCLUSIVE = 600;
/** Divides a status by its hundreds digit to find its outcome bucket. */
const STATUS_CLASS_DIVISOR = 100;
/** `outcome` bucket for each hundreds digit 1-5, indexed by `digit - 1`. */
const STATUS_CLASS_BUCKETS = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

/**
 * Maps an HTTP status to its telemetry outcome bucket. Total and never
 * throws — `M3LTelemetryRecorder`'s own contract is never-throws (see
 * `telemetry/port.ts`), so the mapping feeding it must be equally total:
 * `"other"` for anything below 100, at/above 600, or non-integer.
 */
function statusClassOf(status: number): string {
  if (
    !Number.isInteger(status) ||
    status < STATUS_CLASS_MIN ||
    status >= STATUS_CLASS_MAX_EXCLUSIVE
  ) {
    return "other";
  }
  const digit = Math.floor(status / STATUS_CLASS_DIVISOR);
  return STATUS_CLASS_BUCKETS[digit - 1] ?? "other";
}

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

/**
 * The floor a normalised elapsed-time sample is clamped to — `port.ts`
 * documents `latencyMs` as a non-negative safe integer, and the repository
 * rejects anything else with `ERR_CONSOLE_BAD_REQUEST`.
 */
const LATENCY_MS_FLOOR = 0;

/**
 * Turns a raw elapsed-milliseconds reading into a value `telemetry.httpRequest`
 * can never reject. `Date.now()` (or an injected clock) can step BACKWARDS —
 * NTP correction, VM resume, a suspended laptop — producing a negative or
 * non-integer `rawElapsedMs`. The port's contract is never-throws (see
 * `telemetry/port.ts`), so an invalid value isn't rejected loudly at the call
 * site; it is rejected internally by the repository and swallowed by the
 * store-backed recorder as a logged warning, silently dropping the sample
 * with no other symptom. Normalising here — total, no throw — keeps that
 * sample alive: non-finite collapses to the floor, a fractional value rounds
 * to the nearest integer, and anything still negative clamps to the floor.
 */
function toValidLatencyMs(rawElapsedMs: number): number {
  if (!Number.isFinite(rawElapsedMs)) {
    return LATENCY_MS_FLOOR;
  }
  return Math.max(LATENCY_MS_FLOOR, Math.round(rawElapsedMs));
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
  /** Where the request's single `httpRequest` telemetry sample is recorded (X8 slice 2b). */
  readonly telemetry: M3LTelemetryRecorder;
  /**
   * The route attribution for the telemetry sample — the matched route
   * PATTERN, or a bounded placeholder for an unmatched/unrouted request. See
   * `handler.ts`'s `ROUTE_NOT_FOUND`/`ROUTE_METHOD_NOT_ALLOWED`/
   * `ROUTE_UNROUTED`.
   */
  readonly route: string;
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
 *
 * The trailing `telemetry.httpRequest` call (X8 slice 2b) reads the SAME
 * `durationMs` the access-log line below it does, hoisted to one call to
 * `inputs.now()` so the two can never disagree. It runs LAST, after the
 * write and the abort, and deliberately unguarded: `M3LTelemetryRecorder`'s
 * contract is never-throws, and `telemetry` is caller-supplied, so wrapping
 * it here would only duplicate a guarantee the port itself already makes. A
 * rogue implementation that throws anyway can only surface as a spurious
 * "unhandled console request listener failure" line in `handler.ts` — by
 * then the response is already written and the signal already released, so
 * nothing downstream is left exposed.
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

  // Single clock read, shared by logOutcome and telemetry.httpRequest below
  // so the two can never disagree; normalised once so a backward clock step
  // can't silently drop the telemetry sample (see toValidLatencyMs).
  const durationMs = toValidLatencyMs(inputs.now() - inputs.startedAt);

  logOutcome(inputs.logger, {
    method: inputs.context.method,
    path: inputs.context.path,
    status: inputs.response.status,
    durationMs,
    correlationId: inputs.context.correlationId,
    accessMode: inputs.accessMode,
    ...(inputs.streamOutcome !== undefined && {
      streamOutcome: inputs.streamOutcome,
    }),
  });

  inputs.telemetry.httpRequest({
    route: inputs.route,
    outcome: statusClassOf(inputs.response.status),
    latencyMs: durationMs,
  });
}
