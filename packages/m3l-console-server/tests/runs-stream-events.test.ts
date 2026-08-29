/**
 * Tests for the stream-backed run-event sink and its fan-out composite (X4
 * slice 7a):
 * - `src/runs/stream-events.ts` — `createStreamRunEventSink`, which does not
 *   exist yet.
 * - `src/runs/events.ts` — a new composite/fan-out sink factory, which does
 *   not exist yet either. This suite assumes it is named
 *   `createCompositeRunEventSink` (the contract names the behavior but not
 *   the export — confirm the name with the hub before GREEN).
 *
 * `createCompositeRunEventSink` is being changed to take a `Core.M3LLogger`
 * as a second parameter, so a member's throw is reported (at `error`) rather
 * than silently swallowed (the repo's "never swallow errors silently" rule).
 * `Core.M3LLogger` has private fields and cannot be duck-typed, so every test
 * that must observe a logged event builds a real instance over a local
 * `RecordingHandler` (mirrors `runs-orchestrator.test.ts`'s `buildLogger`
 * pattern) rather than a bare `new Core.M3LLogger([])`.
 *
 * Both are RED until their implementations land.
 */
import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  createCompositeRunEventSink,
  createLoggerRunEventSink,
} from "../src/runs/events.js";
import type { M3LRunEvent, M3LRunEventSink } from "../src/runs/events.js";
import { createStreamRunEventSink } from "../src/runs/stream-events.js";
import { createEventStreamHub } from "../src/stream/event-stream.js";

/** A recording `M3LLoggerHandler` fake (mirrors `runs-orchestrator.test.ts`'s pattern). */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Builds a real `Core.M3LLogger` over a fresh `RecordingHandler`. */
function buildLogger(): { logger: Core.M3LLogger; handler: RecordingHandler } {
  const handler = new RecordingHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

const RUN_STARTED: M3LRunEvent = {
  event: "run.started",
  runId: "run-1",
  atMs: 1_000,
};

const RUN_LINE: M3LRunEvent = {
  event: "run.line",
  runId: "run-1",
  line: "hello from stdout",
};

describe("createStreamRunEventSink", () => {
  test("publishes an event into the open stream at event.runId", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const stream = hub.open("run-1");
    const sink = createStreamRunEventSink(hub);

    sink.publish(RUN_STARTED);

    expect(stream.lastEventId).toBe(1);
    expect(stream.retained).toBe(1);
  });

  test("delivers the event unchanged to a live subscriber", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const stream = hub.open("run-1");
    const sink = createStreamRunEventSink(hub);
    const received: M3LRunEvent[] = [];
    stream.subscribe({
      onEvent: (event) => received.push(event.payload),
      onEnd: () => {},
      onGap: () => {},
    });

    sink.publish(RUN_STARTED);

    expect(received).toEqual([RUN_STARTED]);
  });

  test("is a silent no-op when no stream is open for that run id — a run with no watcher must not throw", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const sink = createStreamRunEventSink(hub);

    expect(() => {
      sink.publish(RUN_STARTED);
    }).not.toThrow();
    expect(hub.openCount).toBe(0);
  });

  test("run.line DOES reach the stream sink — the logger sink deliberately drops it, this sink is run.line's real destination", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const stream = hub.open("run-1");
    const sink = createStreamRunEventSink(hub);
    const received: M3LRunEvent[] = [];
    stream.subscribe({
      onEvent: (event) => received.push(event.payload),
      onEnd: () => {},
      onGap: () => {},
    });

    sink.publish(RUN_LINE);

    expect(received).toEqual([RUN_LINE]);
  });
});

/** Builds a bare `M3LRunEventSink` fixture recording every published event. */
function buildRecordingSink(): M3LRunEventSink & {
  readonly seen: M3LRunEvent[];
} {
  const seen: M3LRunEvent[] = [];
  return {
    seen,
    publish(event) {
      seen.push(event);
    },
  };
}

describe("createCompositeRunEventSink — fan-out", () => {
  test("publishes to every member sink, in order", () => {
    const first = buildRecordingSink();
    const second = buildRecordingSink();
    const third = buildRecordingSink();
    const { logger } = buildLogger();
    const composite = createCompositeRunEventSink(
      [first, second, third],
      logger,
    );

    composite.publish(RUN_STARTED);

    expect(first.seen).toEqual([RUN_STARTED]);
    expect(second.seen).toEqual([RUN_STARTED]);
    expect(third.seen).toEqual([RUN_STARTED]);
  });

  test("one member throwing does not prevent the others from receiving the event — every arm reachable from this test's own setup", () => {
    const before = buildRecordingSink();
    // Named separately (not `throwing.publish`) so the assertion below
    // references the standalone mock rather than a detached method access
    // off `throwing` (`@typescript-eslint/unbound-method`).
    const throwingPublish = vi.fn(() => {
      throw new Error("member sink boom");
    });
    const throwing: M3LRunEventSink = { publish: throwingPublish };
    const after = buildRecordingSink();
    const { logger } = buildLogger();
    const composite = createCompositeRunEventSink(
      [before, throwing, after],
      logger,
    );

    expect(() => {
      composite.publish(RUN_STARTED);
    }).not.toThrow();

    expect(before.seen).toEqual([RUN_STARTED]);
    expect(throwingPublish).toHaveBeenCalledWith(RUN_STARTED);
    expect(after.seen).toEqual([RUN_STARTED]);
  });

  test("an empty member list is a safe no-op", () => {
    const { logger } = buildLogger();
    const composite = createCompositeRunEventSink([], logger);

    expect(() => {
      composite.publish(RUN_STARTED);
    }).not.toThrow();
  });
});

describe("createCompositeRunEventSink — a member's throw is surfaced through the logger, never swallowed", () => {
  test("logs the failure at error, identifying which member failed, while every other member still receives the event", () => {
    const before = buildRecordingSink();
    const thrown = new Error("member sink boom");
    const throwingPublish = vi.fn(() => {
      throw thrown;
    });
    const throwing: M3LRunEventSink = { publish: throwingPublish };
    const after = buildRecordingSink();
    const { logger, handler } = buildLogger();
    const composite = createCompositeRunEventSink(
      [before, throwing, after],
      logger,
    );

    expect(() => {
      composite.publish(RUN_STARTED);
    }).not.toThrow();

    // Containment: every other member still received the event.
    expect(before.seen).toEqual([RUN_STARTED]);
    expect(after.seen).toEqual([RUN_STARTED]);

    // Surfaced, not swallowed: the failure is reported at `error`,
    // identifying the failing member (by its index — the only handle a
    // fan-out over an anonymous sink list has) and carrying the underlying
    // cause, not merely "some log call happened".
    const errorEvents = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.data).toMatchObject({
      index: 1,
      cause: Core.getErrorMessage(thrown),
    });
  });
});

describe("createCompositeRunEventSink — logger + stream integration (the slice's whole point)", () => {
  test("run.line reaches the stream member but not the logger member, while run.started reaches both", () => {
    const logger = new Core.M3LLogger([]);
    const infoSpy = vi.spyOn(logger, "info");
    const loggerSink = createLoggerRunEventSink(logger);

    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const stream = hub.open("run-1");
    const streamSink = createStreamRunEventSink(hub);
    const received: M3LRunEvent[] = [];
    stream.subscribe({
      onEvent: (event) => received.push(event.payload),
      onEnd: () => {},
      onGap: () => {},
    });

    const composite = createCompositeRunEventSink(
      [loggerSink, streamSink],
      logger,
    );

    composite.publish(RUN_STARTED);
    composite.publish(RUN_LINE);

    // run.started: logged AND streamed.
    expect(infoSpy).toHaveBeenCalledWith(
      "run started",
      expect.objectContaining({ runId: "run-1" }),
    );
    // run.line: reaches the stream, never the logger — slice 6's documented
    // drop, proven here by fan-out rather than assumed.
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("line"),
      expect.anything(),
    );
    expect(received).toEqual([RUN_STARTED, RUN_LINE]);

    infoSpy.mockRestore();
  });
});
