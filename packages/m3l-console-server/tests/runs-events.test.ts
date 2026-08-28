/**
 * Tests for src/runs/events.ts — `createLoggerRunEventSink`
 * (m3l-console-server X4 slice 6 round 1). Uses a recording
 * `Core.M3LLoggerHandler` fake (mirrors `tests/main.test.ts`'s
 * `RecordingHandler`, copied locally rather than imported across test
 * files) rather than spying on `Core.M3LLogger`'s own methods, so the
 * assertions stay on the observable event a real handler would receive.
 * The `run.line` cases are load-bearing: the contract deliberately drops
 * that event, and a future regression that starts logging it must fail
 * this suite, not merely go unnoticed.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createLoggerRunEventSink } from "../src/runs/events.js";
import type { M3LRunEvent, M3LRunEventSink } from "../src/runs/events.js";

/** A recording `M3LLoggerHandler` fake — mirrors `tests/main.test.ts`'s pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Builds a sink over a fresh recording handler, returning both. */
function buildSink(): { sink: M3LRunEventSink; handler: RecordingHandler } {
  const handler = new RecordingHandler();
  const logger = new Core.M3LLogger([handler]);
  return { sink: createLoggerRunEventSink(logger), handler };
}

const LIFECYCLE_EVENTS: readonly M3LRunEvent[] = [
  { event: "run.queued", runId: "run-1", scriptName: "sqs-etl", dryRun: false },
  { event: "run.started", runId: "run-1", atMs: 1_000 },
  {
    event: "run.ended",
    runId: "run-1",
    outcome: "success",
    exitCode: 0,
  },
];

describe("createLoggerRunEventSink — lifecycle events are logged at info", () => {
  test.each(LIFECYCLE_EVENTS)("$event logs exactly one INFO event", (event) => {
    const { sink, handler } = buildSink();

    sink.publish(event);

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });
});

describe("createLoggerRunEventSink — run.line is dropped", () => {
  test("publishing a run.line event records nothing", () => {
    const { sink, handler } = buildSink();

    sink.publish({ event: "run.line", runId: "run-1", line: "hello" });

    expect(handler.events).toHaveLength(0);
  });

  test("repeated run.line events never accumulate a recorded entry", () => {
    const { sink, handler } = buildSink();

    sink.publish({ event: "run.line", runId: "run-1", line: "one" });
    sink.publish({ event: "run.line", runId: "run-1", line: "two" });
    sink.publish({ event: "run.line", runId: "run-1", line: "three" });

    expect(handler.events).toHaveLength(0);
  });

  test("a run.line event does not prevent a subsequent lifecycle event from logging", () => {
    const { sink, handler } = buildSink();

    sink.publish({ event: "run.line", runId: "run-1", line: "hello" });
    sink.publish({ event: "run.started", runId: "run-1", atMs: 1_000 });

    expect(handler.events).toHaveLength(1);
  });
});

describe("createLoggerRunEventSink — run.ended exitCode is optional", () => {
  test.each<number | undefined>([0, 1, 137])(
    "exitCode=%s is carried through into the recorded event's data",
    (exitCode) => {
      const { sink, handler } = buildSink();

      sink.publish({
        event: "run.ended",
        runId: "run-1",
        outcome: "failure",
        exitCode,
      });

      expect(handler.events).toHaveLength(1);
      expect(handler.events[0]?.data?.["exitCode"]).toBe(exitCode);
    },
  );

  test("an absent exitCode still logs exactly one INFO event, with the key present and undefined", () => {
    const { sink, handler } = buildSink();

    sink.publish({
      event: "run.ended",
      runId: "run-1",
      outcome: "failure",
      exitCode: undefined,
    });

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
    const data = handler.events[0]?.data ?? {};
    expect(Object.hasOwn(data, "exitCode")).toBe(true);
    expect(data["exitCode"]).toBeUndefined();
  });
});

describe("createLoggerRunEventSink — every M3LRunOutcome is accepted", () => {
  test.each<Core.M3LRunOutcome>([
    "success",
    "failure",
    "dry-run",
    "interrupted",
    "partial",
  ])("outcome=%s logs exactly one INFO event", (outcome) => {
    const { sink, handler } = buildSink();

    sink.publish({
      event: "run.ended",
      runId: "run-1",
      outcome,
      exitCode: undefined,
    });

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });
});

describe("createLoggerRunEventSink — unrecognised event discriminant", () => {
  test("throws ERR_CONSOLE_INTERNAL for an unrecognised event discriminant", () => {
    const { sink } = buildSink();
    // `M3LRunEvent` is a closed discriminated union; this cast deliberately
    // manufactures a discriminant outside it to prove the defensive
    // `default` arm in `publish`'s switch is live at runtime, not merely a
    // compile-time `never` marker.
    const event: M3LRunEvent = {
      event: "run.bogus",
      runId: "run-1",
    } as unknown as M3LRunEvent;

    let thrown: unknown;
    try {
      sink.publish(event);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});

describe("M3LRunEvent", () => {
  test("is a readonly discriminated union over exactly the documented variants", () => {
    expectTypeOf<M3LRunEvent>().toEqualTypeOf<
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
        }
    >();
  });
});
