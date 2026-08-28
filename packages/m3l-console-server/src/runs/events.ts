/**
 * `runs/events` — `createLoggerRunEventSink`, the run-event vocabulary the
 * SSE channel will carry.
 *
 * The vocabulary lives here, in `runs/`, rather than in `stream/` (slice 1)
 * or `http/`. `stream/` is generic over `TPayload` and never names a
 * run-specific type — it is a transport, not an owner of shapes — and
 * `http/` must never import `runs/` (zone rules). `runs/` is the module that
 * actually knows what a run's lifecycle looks like, so it is the one that
 * declares the events describing it. Slice 7 adds a stream-hub-backed
 * `M3LRunEventSink` alongside this logger-backed one and wires the SSE
 * route.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * The closed set of run-lifecycle events an {@link M3LRunEventSink} carries.
 *
 * @example
 * ```ts
 * function isTerminal(event: M3LRunEvent): boolean {
 *   return event.event === "run.ended";
 * }
 * ```
 */
export type M3LRunEvent =
  | {
      readonly event: "run.queued";
      readonly runId: string;
      readonly scriptName: string;
      readonly dryRun: boolean;
    }
  | {
      readonly event: "run.started";
      readonly runId: string;
      readonly atMs: number;
    }
  | {
      readonly event: "run.line";
      readonly runId: string;
      readonly line: string;
    }
  | {
      readonly event: "run.ended";
      readonly runId: string;
      readonly outcome: Core.M3LRunOutcome;
      readonly exitCode: number | undefined;
    };

/**
 * The run-event publication port.
 *
 * @example
 * ```ts
 * function publishStarted(sink: M3LRunEventSink, runId: string): void {
 *   sink.publish({ event: "run.started", runId, atMs: Date.now() });
 * }
 * ```
 */
export interface M3LRunEventSink {
  /** Publishes `event`. Never throws — an event sink must not become a run failure mode. */
  publish(event: M3LRunEvent): void;
}

/**
 * Creates an {@link M3LRunEventSink} that fans `publish` out to every sink in
 * `sinks`, in order.
 *
 * A member's throw is caught and does not stop the fan-out — the two
 * remaining requirements this reconciles: {@link M3LRunEventSink.publish}'s
 * own contract already promises "never throws", so a throwing member is that
 * member's contract violation, not a legitimate failure this composite must
 * escalate; and this composite's own `publish` must equally never throw (it
 * is itself an {@link M3LRunEventSink}), so re-raising synchronously — or
 * deferring the throw to a microtask/rejection, which would only turn a
 * caught defect into an unhandled one — is not an option either. Isolating a
 * misbehaving member from its siblings is exactly the same responsibility
 * `stream/event-stream.ts` assigns to "the seam that owns a logger" for a
 * subscriber's throw; here, the composite is that seam, and it takes a
 * `logger` for the same reason: containment must not become silence. The
 * failing member's index (its only handle over an anonymous sink list) and
 * the thrown cause are reported at `error` so the defect is surfaced rather
 * than discarded, while every other member still receives the event.
 *
 * @param sinks - The member sinks to fan out to, in order.
 * @param logger - The {@link Core.M3LLogger} a member's throw is reported
 * through, at `error`, identified by the failing member's index in `sinks`.
 * @returns A fresh {@link M3LRunEventSink}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import {
 *   createCompositeRunEventSink,
 *   createLoggerRunEventSink,
 * } from "@m3l-automation/m3l-console-server/runs/events.js";
 *
 * const logger = new Core.M3LLogger([]);
 * const sink = createCompositeRunEventSink(
 *   [createLoggerRunEventSink(logger)],
 *   logger,
 * );
 * sink.publish({ event: "run.started", runId: "run-1", atMs: Date.now() });
 * ```
 */
export function createCompositeRunEventSink(
  sinks: readonly M3LRunEventSink[],
  logger: Core.M3LLogger,
): M3LRunEventSink {
  return {
    publish(event: M3LRunEvent): void {
      sinks.forEach((sink, index) => {
        try {
          sink.publish(event);
        } catch (cause) {
          // Contained: siblings still receive the event. Surfaced: the
          // defect is reported at `error` rather than discarded — see this
          // factory's own TSDoc for why containment and silence are not the
          // same thing. Never logs `event` itself — only the failing
          // member's index and the error's message.
          logger.error("run event sink member threw", {
            index,
            cause: Core.getErrorMessage(cause),
          });
        }
      });
    },
  };
}

/**
 * Creates an {@link M3LRunEventSink} that logs `run.queued`, `run.started`,
 * and `run.ended` through `logger` at `info`, and deliberately drops
 * `run.line`.
 *
 * Dropping `run.line` is an explicit, documented decision, not a silently
 * swallowed event, for two reasons. First, {@link Core.M3LLogger} has no
 * level below rank 1 — `text`/`step`/`info`/`section`/`header` are all tied
 * at the same floor (see `core/logging/M3LLogEventCategory.ts`'s
 * `M3LLogLevelFloor`) — so there is no quiet channel this sink could route
 * one-log-line-per-output-line traffic through without it competing with
 * every other `info` line a deployment already captures. Second, a script's
 * stdout is caller data, and this project does not log caller data by
 * default. Slice 7's stream hub — not this logger sink — is `run.line`'s
 * real destination.
 *
 * @param logger - The {@link Core.M3LLogger} to record lifecycle events through.
 * @returns A fresh {@link M3LRunEventSink}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { createLoggerRunEventSink } from "@m3l-automation/m3l-console-server/runs/events.js";
 *
 * const sink = createLoggerRunEventSink(new Core.M3LLogger([]));
 * sink.publish({ event: "run.started", runId: "run-1", atMs: Date.now() });
 * sink.publish({ event: "run.line", runId: "run-1", line: "ignored" }); // dropped
 * ```
 */
export function createLoggerRunEventSink(
  logger: Core.M3LLogger,
): M3LRunEventSink {
  return {
    publish(event: M3LRunEvent): void {
      switch (event.event) {
        case "run.queued":
          logger.info("run queued", {
            runId: event.runId,
            scriptName: event.scriptName,
            dryRun: event.dryRun,
          });
          return;
        case "run.started":
          logger.info("run started", {
            runId: event.runId,
            atMs: event.atMs,
          });
          return;
        case "run.line":
          // Deliberately dropped — see this function's own TSDoc.
          return;
        case "run.ended":
          logger.info("run ended", {
            runId: event.runId,
            outcome: event.outcome,
            exitCode: event.exitCode,
          });
          return;
        default: {
          const exhaustive: never = event;
          throw new M3LConsoleError(
            "ERR_CONSOLE_INTERNAL",
            `unhandled run event: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    },
  };
}
