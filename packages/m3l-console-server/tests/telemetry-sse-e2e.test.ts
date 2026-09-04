/**
 * End-to-end coverage for X8 slice 3b's `sse.stream` telemetry wiring,
 * driven through a REAL `:memory:` SQLite store rather than a mocked
 * {@link "../src/telemetry/port.js".M3LTelemetryRecorder} test double —
 * mirrors `tests/telemetry-http-e2e.test.ts`'s own rationale for slice 2b.
 *
 * WHY THIS FILE EXISTS: it is the only place that drives a real SSE request
 * through the REAL composition root (`createConsoleRuntime`, wired to a
 * real `:memory:` store's own `telemetry` repository), end to end, so it is
 * what actually proves the wiring holds together across every layer: a
 * completed or disconnected stream produces exactly one `sse.stream` row per
 * granularity tier, with the right `outcome`, and no
 * `"telemetry fan-out dropped"` warning is logged. A unit test against a
 * mocked recorder (`tests/telemetry-sse.test.ts`,
 * `tests/telemetry-recorder.test.ts`) proves `finishRequest` calls
 * `telemetry.sseStream` with the right sample, and that
 * `createStoreTelemetryRecorder` maps that sample to a measure-free
 * measurement — but neither proves anything between those two ends (the
 * router, `stream-writer.ts`'s disconnect detection, the repository's actual
 * SQL) doesn't silently drop the row or throw before `res.end()`. Only a
 * real store, driven through the real runtime, closes that gap.
 *
 * NOTE ON THE "MEASURES ARE NULL" ASSERTIONS BELOW: they are a sanity check
 * on the persisted row's shape, NOT proof that a measure-bearing `sse.stream`
 * row would be rejected by the v11 `CHECK` constraint. `recordSseStream`
 * (`src/store/telemetry-repository.ts`) routes every `sse.stream` measurement
 * through `upsertCounter`, whose `SQL_UPSERT_COUNTER` statement binds
 * `NULL, NULL, NULL` for `sum_value`/`min_value`/`max_value` as SQL LITERALS —
 * it never reads a measure field off the measurement at all. So even if
 * `buildSseStreamMeasurement` (`src/telemetry-recorder.ts`) regressed and
 * started attaching a measure to an `sse.stream` sample, these rows would
 * still land with NULL measures, `count()` would be unchanged, and no drop
 * warning would appear — this file's assertions would stay green either way.
 * The test that actually discriminates that specific regression lives at the
 * measurement-building layer, in `tests/telemetry-recorder.test.ts`: it
 * inspects the measurement object handed to the repository directly, before
 * any SQL literal can mask a regression.
 *
 * This file opens `openConsoleStore({ location: ":memory:" })`, builds the
 * runtime through the REAL composition root (`createConsoleRuntime`, wired
 * to the store's own `telemetry` repository — exactly
 * `tests/telemetry-http-e2e.test.ts`'s harness), registers one real
 * stream-kind route (mirrors `tests/handler-streaming.test.ts`'s
 * `streamRoute` fixture, driven here through `createConsoleRuntime`'s
 * `routes` option rather than `createConsoleRequestListener` directly), and
 * drives one real SSE request end to end via `runtime.requestListener`.
 *
 * A stream request records BOTH an `http.request` sample (every request
 * does, via `finishRequest`'s unconditional `telemetry.httpRequest` call)
 * AND an `sse.stream` sample (stream results only) — so `store.telemetry.count()`
 * is 6 for one stream request: 3 fan-out rows (minute/hour/day) per metric,
 * confirmed against `tests/telemetry-http-e2e.test.ts`'s identical
 * one-metric/one-sample/three-granularity assertion for `http.request` and
 * `tests/telemetry-runs-e2e.test.ts`'s identical assertion for
 * `run.finished`. The `sse.stream` fan-out is asserted directly below by
 * querying all three granularities.
 *
 * Isolation: `:memory:` only, closed in `afterEach` — mirrors
 * `tests/telemetry-http-e2e.test.ts`'s own header comment on this
 * package's standing history of accidental real-store opens.
 *
 * Terminal-state coverage: "completed" (the route's `open()` resolves on
 * its own) and "client-disconnected" (the fake `ServerResponse`, a real
 * `EventEmitter`, emits `"close"` while `open()` is still pending). Per
 * `src/http/stream-writer.ts`'s `createCloseSignal`, the disconnect
 * detector listens on `res`'s own `"close"` event — deliberately NOT the
 * request's — so the fixture below emits `"close"` on `res`, not `req`
 * (unlike `tests/handler-streaming.test.ts`'s Bug-1 suite, which exercises
 * a different, request-level disconnect concern). To avoid a race against
 * `createCloseSignal`'s own listener registration (which happens
 * synchronously, immediately before the route's `open()` is invoked), the
 * disconnect route resolves a `started` deferred as the very first thing
 * `open()` does; the test awaits that deferred before emitting `"close"`,
 * guaranteeing the listener is already attached.
 */
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRuntime } from "../src/main.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";
import type { M3LRoute } from "../src/http/router.js";
import type {
  M3LConsoleResult,
  M3LStreamSink,
} from "../src/http/stream-response.js";

const SSE_ROUTE_PATH = "/api/v1/sse";

/**
 * A minimal valid env: only the required operator name plus an audit root
 * that deliberately does not exist — mirrors
 * `tests/telemetry-http-e2e.test.ts`'s own `buildEnv`.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-sse-e2e-audit-absent",
    ),
  };
}

/**
 * A capturing `Core.M3LLoggerHandler`, the sanctioned test-double pattern
 * for this package: a plain object literal satisfies `M3LLoggerHandler`
 * directly, and `createConsoleRuntime`'s own `handlers` option is typed as
 * an array of handlers (it builds the real, private-fielded
 * `Core.M3LLogger` internally) — mirrors
 * `tests/telemetry-http-e2e.test.ts`'s own `buildCapturingHandler`.
 */
function buildCapturingHandler(): {
  readonly handler: Core.M3LLoggerHandler;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { handler, events };
}

/** Builds a minimal `IncomingMessage` double carrying only what the request pipeline reads. */
function createFakeIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url" | "headers">> = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, {
    method: "GET",
    url: "/",
    headers: { host: "127.0.0.1" },
    ...overrides,
  });
  return req;
}

/** What a {@link createStreamServerResponse} double actually had written to it. */
interface RecordedWrite {
  status?: number;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that is also a real `EventEmitter` (so a
 * test can `emit("close")` to simulate a client disconnect — the exact
 * event `stream-writer.ts`'s `createCloseSignal` listens for) and whose
 * `end()` resolves `finished`. Implements every method the streaming path
 * actually calls: `writeHead`, `flushHeaders`, `write` (backpressure-aware
 * callers read its boolean return; this double never reports backpressure),
 * and `end`.
 */
function createStreamServerResponse(): {
  readonly res: ServerResponse;
  readonly written: RecordedWrite;
  readonly finished: Promise<void>;
} {
  const written: RecordedWrite = {};
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: (
      status: number,
      headers?: Readonly<Record<string, string>>,
    ): ServerResponse => {
      written.status = status;
      void headers;
      res.headersSent = true;
      return res;
    },
    flushHeaders: (): void => {},
    write: (_chunk: string): boolean => true,
    end: (body?: string): ServerResponse => {
      written.body = body;
      res.writableEnded = true;
      resolveFinished();
      return res;
    },
  });
  return { res, written, finished };
}

/** Rejects if `promise` has not settled within `ms`, so a wedged listener fails fast instead of hanging the suite. */
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  ms = 1000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Polls (via repeated microtask flushes, never a real timer) until `events`
 * contains a request outcome line (`access-log.ts`'s `<method> <path> ->
 * <status>` marker), then returns. This is the synchronization point that
 * actually matters here, NOT `res.end()`/`finished`: for a stream, `res.end()`
 * fires from inside `writeStream` (awaited by `resolveDispatchedResult`),
 * which returns through one more microtask hop before `runRequest` reaches
 * `finishRequest`. `finishRequest` itself is fully synchronous — it calls
 * `logOutcome` and then `telemetry.httpRequest`/`telemetry.sseStream` in the
 * same call stack, with no `await` between them — so once the outcome line
 * is observed, both telemetry fan-outs have already run and the real store
 * already reflects them. Awaiting bare `finished` alone would race that one
 * extra microtask hop and observe the store before `finishRequest` ran.
 */
async function waitForOutcomeLine(
  events: readonly Core.M3LLogEvent[],
): Promise<void> {
  const maxIterations = 200;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (events.some((event) => event.message.includes(" -> "))) return;
    await Promise.resolve();
  }
  throw new Error(
    "timed out waiting for the request outcome log line to appear",
  );
}

/** A stream route whose `open()` emits one frame and resolves on its own — the "completed" terminal reason. */
function buildCompletedStreamRoute(): M3LRoute {
  const handler = (): M3LConsoleResult => ({
    kind: "stream",
    status: 200,
    headers: { "content-type": "text/event-stream" },
    open: (sink: M3LStreamSink): Promise<void> => {
      sink.emit({ event: "tick", data: "hello" });
      return Promise.resolve();
    },
  });
  return {
    method: "GET",
    path: SSE_ROUTE_PATH,
    auth: "required",
    handler,
  };
}

/**
 * A stream route whose `open()` never resolves on its own, so whichever
 * side wins the disconnect race in `stream-writer.ts`'s `writeStream`
 * determines the outcome. `started` resolves as the very first thing
 * `open()` does — after `stream-writer.ts` has already registered its
 * `res`-level `"close"` listener (that registration runs synchronously,
 * immediately before `open()` is invoked), so awaiting `started` before
 * emitting `"close"` on `res` cannot race the listener's own attachment.
 */
function buildDisconnectStreamRoute(): {
  readonly route: M3LRoute;
  readonly started: Promise<void>;
} {
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const handler = (): M3LConsoleResult => ({
    kind: "stream",
    status: 200,
    headers: { "content-type": "text/event-stream" },
    open: (sink: M3LStreamSink): Promise<void> => {
      resolveStarted();
      sink.emit({ event: "tick", data: "hello" });
      return new Promise<void>(() => {
        // Deliberately never resolves: the disconnect race decides the
        // outcome, not this promise settling on its own.
      });
    },
  });
  const route: M3LRoute = {
    method: "GET",
    path: SSE_ROUTE_PATH,
    auth: "required",
    handler,
  };
  return { route, started };
}

describe("telemetry-sse-e2e — real store, real runtime", () => {
  let store: (M3LConsoleStoreHandle & M3LConsoleStore) | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  test("a completed SSE stream persists an sse.stream row per granularity tier, outcome 'completed', measures NULL", async () => {
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const runtime: M3LConsoleRuntime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [buildCompletedStreamRoute()],
      telemetry: store.telemetry,
    });

    const req = createFakeIncomingMessage({
      method: "GET",
      url: SSE_ROUTE_PATH,
    });
    const { res, written, finished } = createStreamServerResponse();
    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() for the completed SSE stream",
    );
    await withTimeout(
      waitForOutcomeLine(events),
      "finishRequest never logged the request outcome line",
    );

    expect(written.status).toBe(200);

    // A stream request records both an http.request sample (every request
    // does) and an sse.stream sample (stream results only), each fanning
    // out to minute/hour/day — 3 + 3 = 6 total rows. See this file's header
    // comment for why the total is 6, not 3.
    expect(store.telemetry.count()).toBe(6);

    for (const granularity of ["minute", "hour", "day"] as const) {
      const buckets = store.telemetry.list({
        granularity,
        metric: "sse.stream",
        limit: 10,
      });
      expect(buckets).toHaveLength(1);
      const bucket = buckets[0];
      expect(bucket?.outcome).toBe("completed");
      expect(bucket?.sampleCount).toBe(1);
      // Sanity check on the persisted row's shape — see this file's header
      // comment for why this does NOT prove the measure-omission
      // (`buildSseStreamMeasurement`) contract; that is
      // `tests/telemetry-recorder.test.ts`'s job.
      expect(bucket?.sumValue).toBeUndefined();
      expect(bucket?.minValue).toBeUndefined();
      expect(bucket?.maxValue).toBeUndefined();
    }

    // A rejected/dropped write is otherwise invisible except for the row
    // count above — assert its absence explicitly, mirroring every sibling
    // e2e file's identical guard.
    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });

  test("a mid-stream client disconnect persists an sse.stream row per granularity tier, outcome 'client-disconnected'", async () => {
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const { route, started } = buildDisconnectStreamRoute();
    const runtime: M3LConsoleRuntime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [route],
      telemetry: store.telemetry,
    });

    const req = createFakeIncomingMessage({
      method: "GET",
      url: SSE_ROUTE_PATH,
    });
    const { res, written, finished } = createStreamServerResponse();
    runtime.requestListener(req, res);

    await withTimeout(started, "the stream route's open() was never invoked");
    // Sanity: still genuinely mid-stream — otherwise the disconnect below
    // would win the race for the wrong reason (a request that had already
    // finished trivially has no live stream to disconnect from).
    expect(res.writableEnded).toBe(false);

    res.emit("close");

    await withTimeout(
      finished,
      "requestListener never called res.end() after the simulated disconnect",
    );
    await withTimeout(
      waitForOutcomeLine(events),
      "finishRequest never logged the request outcome line",
    );

    expect(written.status).toBe(200);
    expect(store.telemetry.count()).toBe(6);

    for (const granularity of ["minute", "hour", "day"] as const) {
      const buckets = store.telemetry.list({
        granularity,
        metric: "sse.stream",
        limit: 10,
      });
      expect(buckets).toHaveLength(1);
      const bucket = buckets[0];
      expect(bucket?.outcome).toBe("client-disconnected");
      expect(bucket?.sampleCount).toBe(1);
      expect(bucket?.sumValue).toBeUndefined();
      expect(bucket?.minValue).toBeUndefined();
      expect(bucket?.maxValue).toBeUndefined();
    }

    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });
});
