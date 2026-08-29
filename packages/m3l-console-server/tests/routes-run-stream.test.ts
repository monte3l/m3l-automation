/**
 * Tests for src/http/routes/run-stream.ts — `createRunStreamRoutes` (X4
 * slice 7a). `src/http/routes/run-stream.ts` does not exist yet; this suite
 * is RED until the implementation lands.
 *
 * DECISIONS THIS SUITE BAKES IN (contract left these open — confirm with the
 * hub before GREEN):
 *
 * 1. `createRunStreamRoutes(options)` takes `{ hub, registry }`: `hub` is a
 *    REAL `M3LEventStreamHub<TPayload>` (zone-legal — `http/` may import
 *    `stream/` directly), `registry` is a narrow LOCAL port
 *    (`{ get(id) }`) mirroring `M3LRunRegistry.get`, declared inside
 *    `http/routes/run-stream.ts` per the `M3LReadinessProbe` precedent.
 * 2. The route LAZILY opens the hub stream for a still-active run
 *    (`status` `"queued"`/`"running"`) on its first watcher — nothing else
 *    in this slice's file list (`orchestrator.ts` is not touched) opens a
 *    per-run stream. Only the route itself does, via
 *    `hub.get(id) ?? hub.open(id)`.
 * 3. For a run whose registry row is ALREADY TERMINAL at subscribe time, the
 *    route replays whatever the hub has retained (if any) and resolves
 *    `open()` immediately — it does NOT wait for a live `onEnd`. This
 *    module itself never calls `stream.end()` for an individual run; that
 *    now lives in `runs/stream-events.ts`'s sink (addendum Correction 2,
 *    covered by `tests/runs-stream-lifecycle.test.ts`), a module this route
 *    never calls into directly. So a terminal run's hub stream may or may
 *    not already be ended by the time this route's handler runs, and this
 *    route must behave correctly either way — resolving promptly, never
 *    hanging on a live `onEnd` that might not come until well after the
 *    watcher subscribed, or that may never come if the sink already fired
 *    before this route ever opened the connection.
 * 4. A resume-position gap (`stream/event-stream.ts`'s `onGap`) is surfaced
 *    to the client as an SSE frame with `event: "stream.gap"` and a JSON
 *    `data` payload `{ oldestRetainedId }` — chosen for consistency with
 *    `http/stream-writer.ts`'s own (differently-scoped) `"stream.gap"`
 *    backpressure re-sync frame, though the two are unrelated mechanisms.
 * 5. The route reads a resume request from the `last-event-id` header
 *    (lower-cased, per Node's own header-name normalization) on
 *    `ctx.headers`.
 * 6. On client disconnect (`ctx.signal` aborting), the route unsubscribes
 *    and resolves `open()` rather than leaving the promise pending forever.
 *
 * Every case drives a returned route's `handler`/`open` directly — no real
 * socket, no real `node:http` server, mirroring `tests/health.test.ts`.
 */
import { describe, expect, test } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRunStreamRoutes } from "../src/http/routes/run-stream.js";
import type { M3LRoute } from "../src/http/router.js";
import { encodeSseFrame } from "../src/http/sse.js";
import type { M3LSseFrame } from "../src/http/sse.js";
import { isStreamResponse } from "../src/http/stream-response.js";
import type {
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "../src/http/stream-response.js";
import { createEventStreamHub } from "../src/stream/event-stream.js";

/** The minimal run-event shape these tests publish through the hub. */
interface FakeRunEvent {
  readonly event: string;
  readonly runId: string;
  readonly line?: string;
}

/** One fixture run row, just enough for the route's existence/terminal check. */
interface FakeRunRow {
  readonly id: string;
  readonly status: "queued" | "running" | "success" | "failure";
}

/** The local reader port `createRunStreamRoutes` depends on. */
interface FakeRegistry {
  get(id: string): FakeRunRow | undefined;
}

/** A recording `M3LStreamSink` fixture: captures every emitted frame in order. */
interface RecordingSink extends M3LStreamSink {
  readonly frames: M3LSseFrame[];
}

/** Builds a {@link RecordingSink}, never reporting `closed`. */
function buildSink(): RecordingSink {
  const frames: M3LSseFrame[] = [];
  return {
    frames,
    emit(frame) {
      frames.push(frame);
    },
    closed: false,
  };
}

/** Builds a bare GET request context for `path`, optionally captioned with `params`/a resume header. */
function buildContext(options: {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
}): M3LRequestContext {
  const base = createRequestContext({
    method: "GET",
    url: options.path,
    headers:
      options.lastEventId === undefined
        ? {}
        : { "last-event-id": options.lastEventId },
    signal: options.signal ?? new AbortController().signal,
  });
  return { ...base, params: options.params };
}

/** Finds the registered route for `method`/`path`, failing loudly if absent. */
function findRoute(
  routes: readonly M3LRoute[],
  method: string,
  path: string,
): M3LRoute {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) {
    throw new Error(`no route registered for ${method} ${path}`);
  }
  return route;
}

/** Drives `route`'s handler and asserts it produced the stream arm. */
async function runStreamRoute(
  route: M3LRoute,
  ctx: M3LRequestContext,
): Promise<M3LConsoleStreamResponse> {
  const result = await route.handler(ctx);
  if (!isStreamResponse(result)) {
    throw new Error(
      `expected a stream response from ${route.method} ${route.path}, got buffered`,
    );
  }
  return result;
}

/** Captures a value thrown by an async call. */
async function captureThrown(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("createRunStreamRoutes — route table shape", () => {
  test("registers GET /api/v1/runs/:id/stream, auth: 'required'", () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = { get: () => undefined };
    const routes = createRunStreamRoutes({ hub, registry });

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`),
    ).toEqual(["GET /api/v1/runs/:id/stream"]);
    expect(routes[0]?.auth).toBe("required");
  });
});

describe("createRunStreamRoutes — GET /api/v1/runs/:id/stream", () => {
  test("returns the stream arm with text/event-stream content-type and no content-length", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const controller = new AbortController();
    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    expect(result.headers["content-type"]).toBe("text/event-stream");
    expect(result.headers).not.toHaveProperty("content-length");

    controller.abort();
    await result.open(buildSink());
  });

  test("400s ERR_CONSOLE_BAD_REQUEST when the ':id' route parameter is missing, leaving hub.openCount at 0", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = { get: () => undefined };
    const routes = createRunStreamRoutes({ hub, registry });

    const route = findRoute(routes, "GET", "/api/v1/runs/:id/stream");
    const thrown = await captureThrown(async () =>
      route.handler(
        buildContext({
          path: "/api/v1/runs//stream",
          params: {},
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(hub.openCount).toBe(0);
  });

  test("404s ERR_CONSOLE_RUN_NOT_FOUND for an unknown run id BEFORE opening any stream, leaving hub.openCount at 0", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = { get: () => undefined };
    const routes = createRunStreamRoutes({ hub, registry });

    const thrown = await captureThrown(() =>
      runStreamRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
        buildContext({
          path: "/api/v1/runs/nope/stream",
          params: { id: "nope" },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_RUN_NOT_FOUND");
    expect(hub.openCount).toBe(0);
  });

  test("delivers a live-published event's `event` field as the SSE event name with a monotonic id, encodable via the real encodeSseFrame", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    stream.publish({ event: "run.started", runId: "run-1" });

    expect(sink.frames).toHaveLength(1);
    const frame = sink.frames[0];
    expect(frame?.event).toBe("run.started");
    expect(frame?.id).toBe(1);
    // Proves the emitted frame is a well-formed, encodable SSE frame — not
    // asserting the encoder's own behavior (covered by its own suite).
    expect(() => encodeSseFrame(frame as M3LSseFrame)).not.toThrow();

    controller.abort();
    await openPromise;
  });

  test("Last-Event-ID resume replays exactly the missed events", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const preOpened = hub.open("run-1");
    preOpened.publish({ event: "run.started", runId: "run-1" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "one" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "two" });

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        lastEventId: "1",
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    // Only ids 2 and 3 were missed; id 1 must not be replayed again.
    expect(sink.frames.map((frame) => frame.id)).toEqual([2, 3]);
    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.line",
      "run.line",
    ]);

    controller.abort();
    await openPromise;
  });

  test("an evicted Last-Event-ID produces the explicit gap signal, not a silent resume", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 2 });
    const preOpened = hub.open("run-1");
    preOpened.publish({ event: "run.line", runId: "run-1", line: "one" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "two" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "three" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "four" });
    // bufferSize: 2 with 4 published events retains ids 3 and 4, so
    // oldestRetainedId is 3. Resuming from id 1 must gap: 1 < oldestRetainedId
    // (3) - 1 == 2 is true, i.e. the client's last-seen id (1) is more than
    // one behind the oldest retained id, so events 2 and 3 are genuinely
    // stranded — this is strictly less than the `lastEventId ===
    // oldestRetainedId - 1` "still replayable" boundary (see the companion
    // test below).

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        lastEventId: "1",
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]?.event).toBe("stream.gap");
    const payload: unknown = JSON.parse(sink.frames[0]?.data ?? "{}");
    expect(payload).toMatchObject({ oldestRetainedId: 3 });

    controller.abort();
    await openPromise;
  });

  test("resuming from exactly oldestRetainedId - 1 replays cleanly with no gap frame", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 2 });
    const preOpened = hub.open("run-1");
    preOpened.publish({ event: "run.line", runId: "run-1", line: "one" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "two" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "three" });
    preOpened.publish({ event: "run.line", runId: "run-1", line: "four" });
    // Retained ids are 3 and 4, so oldestRetainedId is 3. Resuming from id 2
    // sits exactly on the `lastEventId === oldestRetainedId - 1` boundary:
    // the client has already seen everything up to and including id 2, so
    // replaying ids 3 and 4 (still retained) loses nothing — no gap.

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        lastEventId: "2",
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    expect(sink.frames.map((frame) => frame.id)).toEqual([3, 4]);
    expect(sink.frames.every((frame) => frame.event !== "stream.gap")).toBe(
      true,
    );

    controller.abort();
    await openPromise;
  });

  test("a run already terminal at subscribe time resolves open() promptly, replaying any retained events, without waiting on a live end", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const preOpened = hub.open("run-1");
    preOpened.publish({ event: "run.started", runId: "run-1" });
    preOpened.publish({ event: "run.ended", runId: "run-1" });
    // Deliberately never `preOpened.end(...)` here: this scenario simulates a
    // watcher reaching the route in the narrow window before
    // `runs/stream-events.ts`'s sink has ended the stream (or a deployment
    // where nothing ever ends it) — the route itself must not hang waiting
    // on an `onEnd` that may arrive late or never.

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "success" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
      }),
    );

    const sink = buildSink();
    // No fake timers, no manual abort: a hanging implementation would make
    // this `await` never settle and the test would time out — the proof
    // that this genuinely resolves rather than merely "usually resolves".
    await result.open(sink);

    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.started",
      "run.ended",
    ]);
  });

  test("the stream ending while a watcher is subscribed resolves the open promise (not just a client abort)", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    // The signal is never aborted in this test: the only way `open()` can
    // settle is via `openActiveStream`'s `onEnd: () => finish()` arm.
    stream.end("completed");

    await expect(openPromise).resolves.toBeUndefined();
  });

  test("resolves open() exactly once when the stream ends AND the client aborts, without throwing (the once() double-fire guard)", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    // First completion path: the stream itself ends, firing `onEnd`.
    stream.end("completed");
    // Second completion path, fired immediately after: the client aborts.
    // The `once()` guard must make this a no-op — it must not throw, and
    // the already-settled promise below must still resolve exactly once.
    expect(() => {
      controller.abort();
    }).not.toThrow();

    await expect(openPromise).resolves.toBeUndefined();
  });

  test("a run already terminal with no hub stream at all resolves open() immediately with zero frames", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "failure" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
      }),
    );

    const sink = buildSink();
    await result.open(sink);

    expect(sink.frames).toHaveLength(0);
    expect(hub.openCount).toBe(0);
  });

  // Regression coverage for a defect found during manual acceptance of X4
  // slice 7a: the terminal path ignored `Last-Event-ID` entirely, always
  // replaying the full retained buffer regardless of what the client had
  // already seen. Each of the next three tests builds the SAME retained
  // window honestly (publish 9 events at bufferSize 3, so ids 7, 8, and 9
  // are retained and `oldestRetainedId` is 7) and drives a different resume
  // header through it. Every test asserts the `open()` promise itself
  // resolves (not just that it eventually returns frames) — a hanging
  // implementation would leave the `await` unsettled and the test would
  // time out, per this file's existing terminal-path proof pattern.
  test("a terminal run's precise Last-Event-ID resume replays only the missed retained event", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 3 });
    const preOpened = hub.open("run-1");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      preOpened.publish({
        event: "run.line",
        runId: "run-1",
        line: `line-${String(sequence)}`,
      });
    }
    preOpened.end("completed");

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "success" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        lastEventId: "8",
      }),
    );

    const sink = buildSink();
    await expect(result.open(sink)).resolves.toBeUndefined();

    // Only id 9 was missed; ids 7 and 8 (already seen by the client) must
    // not be replayed again. The stream was already ended before this
    // route ever subscribed, so a trailing `stream.end` frame (carrying no
    // `id`) is expected after the replay — see the acceptance-step-5 tests
    // above for that frame's own dedicated coverage.
    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.line",
      "stream.end",
    ]);
    expect(sink.frames.map((frame) => frame.id)).toEqual([9, undefined]);
    expect(sink.frames.every((frame) => frame.event !== "stream.gap")).toBe(
      true,
    );
  });

  test("a terminal run's stranded Last-Event-ID produces the explicit gap signal, never a silent partial replay", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 3 });
    const preOpened = hub.open("run-1");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      preOpened.publish({
        event: "run.line",
        runId: "run-1",
        line: `line-${String(sequence)}`,
      });
    }
    // Same retained window as the previous test: ids 7, 8, 9 retained,
    // oldestRetainedId is 7. Resuming from id 2 is a genuine gap
    // (2 < oldestRetainedId (7) - 1 == 6), distinct from the
    // oldestRetainedId - 1 "still replayable" boundary the active-path
    // suite already pins above — this is the terminal path.
    preOpened.end("completed");

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "success" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        lastEventId: "2",
      }),
    );

    const sink = buildSink();
    await expect(result.open(sink)).resolves.toBeUndefined();

    // Exactly one gap frame — never a silent replay of 7, 8, and 9 — plus
    // the trailing `stream.end` frame the stream's own prior `.end()` call
    // now produces (see the acceptance-step-5 tests above).
    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "stream.gap",
      "stream.end",
    ]);
    const gapPayload: unknown = JSON.parse(sink.frames[0]?.data ?? "{}");
    expect(gapPayload).toMatchObject({ oldestRetainedId: 7 });
  });

  test("a terminal run with no Last-Event-ID header still replays the full retained buffer, unchanged", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 3 });
    const preOpened = hub.open("run-1");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      preOpened.publish({
        event: "run.line",
        runId: "run-1",
        line: `line-${String(sequence)}`,
      });
    }
    preOpened.end("completed");

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "success" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
      }),
    );

    const sink = buildSink();
    await expect(result.open(sink)).resolves.toBeUndefined();

    // Guards against the fix over-correcting: an absent header must still
    // deliver the whole retained window, exactly as it did before the fix —
    // plus the trailing `stream.end` frame the stream's own prior `.end()`
    // call now produces (see the acceptance-step-5 tests above).
    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.line",
      "run.line",
      "run.line",
      "stream.end",
    ]);
    expect(sink.frames.map((frame) => frame.id)).toEqual([7, 8, 9, undefined]);
    expect(sink.frames.every((frame) => frame.event !== "stream.gap")).toBe(
      true,
    );
  });

  // Regression coverage for the SIGTERM-with-a-watcher-attached failure: the
  // route never emitted any terminal SSE frame, so a watcher's connection
  // was severed with no explanation. The fix adds a `stream.end` frame,
  // emitted right before `open()` settles, on every path that can end a
  // stream while a watcher holds it: a live watcher whose stream is ended
  // (draining or an ordinary run completion), and the terminal-replay path
  // for a stream that is already ended by the time a late watcher arrives.
  test("a live watcher whose stream ends with 'draining' receives a final stream.end frame, ordered after every prior event", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    stream.publish({ event: "run.line", runId: "run-1", line: "one" });
    stream.end("draining");

    await expect(openPromise).resolves.toBeUndefined();

    // Ordering, not just presence: the terminal frame must be LAST.
    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.line",
      "stream.end",
    ]);
    const finalFrame = sink.frames.at(-1);
    const payload: unknown = JSON.parse(finalFrame?.data ?? "{}");
    expect(payload).toEqual({ reason: "draining" });
  });

  test("a live watcher whose stream ends with 'completed' receives a final stream.end frame, ordered after every prior event", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    stream.publish({ event: "run.started", runId: "run-1" });
    stream.publish({ event: "run.ended", runId: "run-1" });
    stream.end("completed");

    await expect(openPromise).resolves.toBeUndefined();

    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.started",
      "run.ended",
      "stream.end",
    ]);
    const finalFrame = sink.frames.at(-1);
    const payload: unknown = JSON.parse(finalFrame?.data ?? "{}");
    expect(payload).toEqual({ reason: "completed" });
  });

  test("the stream.end frame carries no 'id' — it names no real published event", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "running" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });
    const controller = new AbortController();

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
        signal: controller.signal,
      }),
    );

    const sink = buildSink();
    const openPromise = result.open(sink);

    const stream = hub.get("run-1");
    if (stream === undefined) {
      throw new Error("expected the route to have opened a stream for run-1");
    }
    stream.publish({ event: "run.started", runId: "run-1" });
    stream.end("completed");

    await expect(openPromise).resolves.toBeUndefined();

    const finalFrame = sink.frames.at(-1);
    expect(finalFrame?.event).toBe("stream.end");
    expect(finalFrame).not.toHaveProperty("id");
  });

  test("the terminal-replay path also emits a trailing stream.end frame after replaying the retained backlog", async () => {
    const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });
    const preOpened = hub.open("run-1");
    preOpened.publish({ event: "run.started", runId: "run-1" });
    preOpened.publish({ event: "run.ended", runId: "run-1" });
    // Unlike the pre-existing "already terminal, no live end" test above,
    // this scenario ends the stream BEFORE the watcher arrives — the common
    // case once `runs/stream-events.ts`'s sink reliably ends the stream on
    // `run.ended`, and the case the fix's terminal-replay `onEnd` arm exists
    // for.
    preOpened.end("completed");

    const registry: FakeRegistry = {
      get: () => ({ id: "run-1", status: "success" }),
    };
    const routes = createRunStreamRoutes({ hub, registry });

    const result = await runStreamRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
      buildContext({
        path: "/api/v1/runs/run-1/stream",
        params: { id: "run-1" },
      }),
    );

    const sink = buildSink();
    await expect(result.open(sink)).resolves.toBeUndefined();

    expect(sink.frames.map((frame) => frame.event)).toEqual([
      "run.started",
      "run.ended",
      "stream.end",
    ]);
    const finalFrame = sink.frames.at(-1);
    expect(finalFrame).not.toHaveProperty("id");
    const payload: unknown = JSON.parse(finalFrame?.data ?? "{}");
    expect(payload).toEqual({ reason: "completed" });
  });

  test.each([
    ["draining" as const, "live"] as const,
    ["completed" as const, "live"] as const,
    ["completed" as const, "terminal"] as const,
  ])(
    "open() resolves (never hangs) when the stream ends with reason '%s' on the %s path",
    async (reason, path) => {
      const hub = createEventStreamHub<FakeRunEvent>({ bufferSize: 10 });

      if (path === "terminal") {
        const preOpened = hub.open("run-1");
        preOpened.publish({ event: "run.started", runId: "run-1" });
        preOpened.end(reason);
      }

      const registry: FakeRegistry = {
        get: () => ({
          id: "run-1",
          status: path === "terminal" ? "success" : "running",
        }),
      };
      const routes = createRunStreamRoutes({ hub, registry });
      const controller = new AbortController();

      const result = await runStreamRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/stream"),
        buildContext({
          path: "/api/v1/runs/run-1/stream",
          params: { id: "run-1" },
          signal: controller.signal,
        }),
      );

      const sink = buildSink();
      const openPromise = result.open(sink);

      if (path === "live") {
        const stream = hub.get("run-1");
        if (stream === undefined) {
          throw new Error(
            "expected the route to have opened a stream for run-1",
          );
        }
        stream.end(reason);
      }

      // No fake timers, no manual abort: a hanging implementation would
      // leave this `await` unsettled and the test would time out.
      await expect(openPromise).resolves.toBeUndefined();
    },
  );
});
