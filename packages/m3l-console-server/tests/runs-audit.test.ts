/**
 * Tests for src/runs/audit.ts — `createLoggerAuditSink` (m3l-console-server
 * X4 slice 6 round 1). Uses a recording `Core.M3LLoggerHandler` fake (the
 * same sanctioned pattern as `tests/main.test.ts`'s `RecordingHandler`,
 * copied locally rather than imported across test files) instead of spying
 * on `Core.M3LLogger`'s own methods, so the assertions stay on the observable
 * event a real handler would receive.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createLoggerAuditSink } from "../src/runs/audit.js";
import type {
  M3LRunAuditAction,
  M3LRunAuditRecord,
  M3LRunAuditSink,
} from "../src/runs/audit.js";

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

const ALL_ACTIONS: readonly M3LRunAuditAction[] = [
  "run.launch-allowed",
  "run.launch-denied",
  "run.launch-rejected",
  "run.started",
  "run.finished",
  "run.cancelled",
  "run.reconciled",
];

/** Builds an audit record fixture, defaulting every field to a queued launch. */
function buildRecord(
  overrides: Partial<M3LRunAuditRecord> = {},
): M3LRunAuditRecord {
  return {
    action: "run.launch-allowed",
    runId: "run-1",
    scriptName: "sqs-etl",
    operator: "ada",
    atMs: 1_000,
    detail: {},
    ...overrides,
  };
}

/** Builds a sink over a fresh recording handler, returning both. */
function buildSink(): { sink: M3LRunAuditSink; handler: RecordingHandler } {
  const handler = new RecordingHandler();
  const logger = new Core.M3LLogger([handler]);
  return { sink: createLoggerAuditSink(logger), handler };
}

describe("createLoggerAuditSink — every action reaches the logger", () => {
  test.each(ALL_ACTIONS)("%s logs exactly one INFO event", (action) => {
    const { sink, handler } = buildSink();

    sink.record(buildRecord({ action }));

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });
});

describe("createLoggerAuditSink — stable message per action", () => {
  test.each(ALL_ACTIONS)(
    "%s produces the same message text across two differing records",
    (action) => {
      const { sink, handler } = buildSink();

      sink.record(
        buildRecord({ action, runId: "run-a", detail: { attempt: 1 } }),
      );
      sink.record(
        buildRecord({ action, runId: "run-b", detail: { attempt: 2 } }),
      );

      expect(handler.events).toHaveLength(2);
      expect(handler.events[0]?.message).toBe(handler.events[1]?.message);
    },
  );
});

describe("createLoggerAuditSink — runId can be undefined", () => {
  test("recording a denial before an id exists does not throw", () => {
    const { sink } = buildSink();

    expect(() => {
      sink.record(
        buildRecord({ action: "run.launch-denied", runId: undefined }),
      );
    }).not.toThrow();
  });
});

describe("createLoggerAuditSink — falsy scalar detail values", () => {
  test("an empty string, zero, and false in detail do not throw", () => {
    const { sink } = buildSink();

    expect(() => {
      sink.record(
        buildRecord({
          detail: { reason: "", attempt: 0, confirmed: false },
        }),
      );
    }).not.toThrow();
  });
});

describe("createLoggerAuditSink — unrecognised action", () => {
  test("throws ERR_CONSOLE_INTERNAL for an unrecognised audit action", () => {
    const { sink } = buildSink();
    // The `action` union is closed; this cast deliberately manufactures a
    // value outside it to prove the defensive `default` arm in `messageFor`
    // is live at runtime, not merely a compile-time `never` marker.
    const record: M3LRunAuditRecord = buildRecord({
      action: "run.bogus-action" as unknown as M3LRunAuditAction,
    });

    let thrown: unknown;
    try {
      sink.record(record);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});

describe("M3LRunAuditRecord", () => {
  test("has the exact readonly field shape the contract declares", () => {
    expectTypeOf<M3LRunAuditRecord>().toEqualTypeOf<{
      readonly action: M3LRunAuditAction;
      readonly runId: string | undefined;
      readonly scriptName: string;
      readonly operator: string;
      readonly atMs: number;
      readonly detail: Readonly<Record<string, string | number | boolean>>;
    }>();
  });
});

describe("M3LRunAuditAction", () => {
  test("is exactly the seven documented action literals", () => {
    expectTypeOf<M3LRunAuditAction>().toEqualTypeOf<
      | "run.launch-allowed"
      | "run.launch-denied"
      | "run.launch-rejected"
      | "run.started"
      | "run.finished"
      | "run.cancelled"
      | "run.reconciled"
    >();
  });
});
