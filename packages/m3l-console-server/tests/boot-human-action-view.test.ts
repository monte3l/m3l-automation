/**
 * Tests for the `view.*` exposure class (X7b, ADR-0070): the one sensitive
 * view that has a route today, `GET /api/v1/runs/:id/stream`.
 *
 * Three properties here are the reason this file exists rather than being
 * folded into `boot-human-action-audit.test.ts`:
 *
 * 1. **Volume.** One entry per SUBSCRIPTION, not per event. Asserted as an
 *    exact call count of `1` against a 60-event stream, not `>0` — the trail
 *    has no pruning path shipped, so "at least one" would let a per-event
 *    regression through.
 * 2. **Honesty.** A 404 records NOTHING. `buildStreamHandler` does its
 *    not-found check internally, so a `phase: "before"` record would have
 *    written `"served"` for a run that was never served.
 * 3. **Display-vs-persist.** A rejected append refuses the stream BEFORE
 *    `open(sink)` runs, so no SSE byte reaches the operator. Asserted by
 *    proving the sink was never touched.
 *
 * `tests/routes-run-stream.test.ts` is deliberately left unchanged: the gate
 * decorates the route from outside, so the route's own contract did not move.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import { applyHumanActionAudit } from "../src/boot/human-action-audit.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createRequestContext,
  withOperator,
  withParams,
} from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LSseFrame } from "../src/http/sse.js";
import type {
  M3LConsoleResult,
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "../src/http/stream-response.js";
import type { M3LRoute } from "../src/http/router.js";

/** A recording port; `failWith` makes every write reject. */
function createFakePort(failWith?: Error): M3LHumanActionAuditPort & {
  readonly records: M3LHumanActionRecord[];
} {
  const records: M3LHumanActionRecord[] = [];
  return {
    records,
    record(record: M3LHumanActionRecord): Promise<void> {
      records.push(record);
      return failWith === undefined
        ? Promise.resolve()
        : Promise.reject(failWith);
    },
  };
}

/** A recording sink, so "no byte reached the operator" is checkable. */
function createRecordingSink(): M3LStreamSink & {
  readonly frames: M3LSseFrame[];
} {
  const frames: M3LSseFrame[] = [];
  return {
    frames,
    emit(frame: M3LSseFrame): void {
      frames.push(frame);
    },
    closed: false,
  };
}

/** A `GET …/stream` context for run `id`, optionally resuming at `lastEventId`. */
function streamContext(id: string, lastEventId?: string): M3LRequestContext {
  const base = createRequestContext({
    method: "GET",
    url: `http://127.0.0.1/api/v1/runs/${id}/stream`,
    headers: {
      "x-correlation-id": "corr-view",
      ...(lastEventId !== undefined && { "last-event-id": lastEventId }),
    },
    signal: new AbortController().signal,
  });
  return withOperator(withParams(base, { id }), {
    name: "ada",
    email: undefined,
  });
}

/**
 * The audited stream route. `emitCount` frames are written when — and only
 * when — the returned response's `open(sink)` is actually invoked.
 */
function streamRoute(emitCount: number): M3LRoute {
  return {
    method: "GET",
    path: "/api/v1/runs/:id/stream",
    auth: "required",
    handler: (): M3LConsoleStreamResponse => ({
      kind: "stream",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      open: (sink) => {
        for (let i = 0; i < emitCount; i += 1) {
          sink.emit({
            id: i + 1,
            event: "run.line",
            data: `line ${String(i)}`,
          });
        }
        return Promise.resolve();
      },
    }),
  };
}

/** A route whose handler 404s internally, exactly as `buildStreamHandler` does. */
function notFoundRoute(): M3LRoute {
  return {
    method: "GET",
    path: "/api/v1/runs/:id/stream",
    auth: "required",
    handler: (): M3LConsoleResult => {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_NOT_FOUND",
        "no run found with id 'missing'",
      );
    },
  };
}

/** Decorates a route and returns the decorated form. */
function decorate(route: M3LRoute, port: M3LHumanActionAuditPort): M3LRoute {
  const [decorated] = applyHumanActionAudit([route], port, () => 1_700_000);
  if (decorated === undefined) throw new Error("route was not decorated");
  return decorated;
}

describe("one record per subscription", () => {
  test("an SSE open records exactly one view.run.stream entry", async () => {
    const port = createFakePort();
    const decorated = decorate(streamRoute(3), port);

    const result = await decorated.handler(streamContext("run-1"));
    await (result as M3LConsoleStreamResponse).open(createRecordingSink());

    expect(port.records).toHaveLength(1);
    expect(port.records[0]?.action).toBe("view.run.stream");
    expect(port.records[0]?.target).toEqual({ kind: "run", id: "run-1" });
    expect(port.records[0]?.outcome).toBe("served");
    expect(port.records[0]?.correlationId).toBe("corr-view");
  });

  // THE VOLUME GUARD. Exactly `1`, never `>0`: per-event recording would
  // write thousands of lines per watcher into a trail with no pruning path.
  test("a 60-event stream still records exactly one entry", async () => {
    const port = createFakePort();
    const decorated = decorate(streamRoute(60), port);
    const sink = createRecordingSink();

    const result = await decorated.handler(streamContext("run-1"));
    await (result as M3LConsoleStreamResponse).open(sink);

    expect(sink.frames).toHaveLength(60);
    expect(port.records).toHaveLength(1);
  });

  test("a resume records a second entry carrying lastEventId", async () => {
    const port = createFakePort();
    const decorated = decorate(streamRoute(1), port);

    await decorated.handler(streamContext("run-1"));
    await decorated.handler(streamContext("run-1", "41"));

    expect(port.records).toHaveLength(2);
    // A first open carries no resume marker…
    expect(port.records[0]?.detail).toEqual({});
    // …and a resume is distinguishable from it.
    expect(port.records[1]?.detail).toEqual({ lastEventId: 41 });
  });

  test.each([
    ["a non-integer", "not-a-number"],
    ["a negative value", "-1"],
  ] as [string, string][])(
    "%s Last-Event-ID is treated as absent, not recorded verbatim",
    async (_label, raw) => {
      // Matches `parseLastEventId`'s own rule, and keeps caller-controlled
      // text out of `detail`.
      const port = createFakePort();
      const decorated = decorate(streamRoute(1), port);

      await decorated.handler(streamContext("run-1", raw));

      expect(port.records[0]?.detail).toEqual({});
    },
  );
});

describe("honesty: a view that never happened is never recorded", () => {
  // `buildStreamHandler` 404s INTERNALLY, so recording before it would have
  // written `"served"` for a run that was never served.
  test("a 404 records no entry at all", async () => {
    const port = createFakePort();
    const decorated = decorate(notFoundRoute(), port);

    await expect(
      (async () => decorated.handler(streamContext("missing")))(),
    ).rejects.toBeInstanceOf(M3LConsoleError);

    expect(port.records).toHaveLength(0);
  });
});

describe("display-vs-persist: the refusal lands before any byte does", () => {
  // The proof that `phase: "after"` still REFUSES. `open(sink)` has not run
  // when the append is attempted, so a rejected write means the operator saw
  // nothing. Mutation-tested by moving the record after the return.
  test("a rejected append refuses the stream before open(sink) runs", async () => {
    const failure = new M3LConsoleError(
      "ERR_CONSOLE_AUDIT_WRITE_FAILED",
      "trail unwritable",
    );
    const port = createFakePort(failure);
    const openSpy = vi.fn(() => Promise.resolve());
    const decorated = decorate(
      {
        method: "GET",
        path: "/api/v1/runs/:id/stream",
        auth: "required",
        handler: (): M3LConsoleStreamResponse => ({
          kind: "stream",
          status: 200,
          headers: {},
          open: openSpy,
        }),
      },
      port,
    );

    let thrown: unknown;
    try {
      await decorated.handler(streamContext("run-1"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    // The whole point: the transport never got a chance to write.
    expect(openSpy).not.toHaveBeenCalled();
  });
});
