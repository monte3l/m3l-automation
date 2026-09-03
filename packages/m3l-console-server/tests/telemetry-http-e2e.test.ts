/**
 * End-to-end tests for the X8 slice 2b telemetry wiring, driven through a
 * REAL `:memory:` SQLite store rather than a mocked
 * {@link "../src/telemetry/port.js".M3LTelemetryRecorder} test double.
 *
 * Every other slice-2b test (`tests/telemetry-http.test.ts`,
 * `tests/telemetry-seam.test.ts`) asserts at the port boundary against a
 * hand-written fake — by construction none of those can catch a value the
 * DATABASE itself rejects (e.g. an empty `route`, which
 * `console_telemetry_rollup`'s own `CHECK` constraint forbids), because
 * `telemetry-recorder.ts`'s `createStoreTelemetryRecorder` swallows a
 * repository failure as a logged `warning` rather than throwing — the
 * mocked tests would stay green while nothing actually persisted. This file
 * closes that gap: it opens a real `openConsoleStore({ location: ":memory:" })`,
 * builds a real `createConsoleRuntime` wired to that store's own
 * `telemetry` repository, drives one request through
 * `runtime.requestListener`, and reads the rollup table back through
 * `store.telemetry.list()`/`count()`.
 *
 * Isolation: `:memory:` only, never a real file — this package has a
 * standing history of tests accidentally opening the real store (see
 * `tests/main-store.test.ts`'s own header comment), so every store here is
 * opened via `openConsoleStore({ location: ":memory:" })` and closed in
 * `afterEach`. The audit root is pointed at a deliberately-nonexistent
 * tmpdir path (mirroring `tests/telemetry-seam.test.ts`'s own `buildEnv`) —
 * the route under test is registered through `createConsoleRuntime`'s
 * `routes` option, which `main.ts`'s own TSDoc documents as NOT audited, so
 * this never touches that path either.
 *
 * Request-completion detection mirrors `tests/main-store.test.ts`'s own
 * `dispatch` helper: the fake `ServerResponse`'s `end()` call resolves a
 * `finished` promise, guarded by a timeout so a wedged listener fails fast
 * rather than hanging the suite. Because `finish-request.ts` calls
 * `res.end()` (via `writeResponseGuarded`) and then `telemetry.httpRequest`
 * synchronously, in the same call stack, awaiting that promise is sufficient
 * to know the store write has already happened by the time control returns
 * — no extra microtask-flushing helper is needed.
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

/**
 * A minimal valid env: only the required operator name plus an audit root
 * that deliberately does not exist (mirrors `tests/telemetry-seam.test.ts`'s
 * `buildEnv` and `tests/main-store.test.ts`'s own).
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-http-e2e-audit-absent",
    ),
  };
}

/**
 * A capturing `Core.M3LLoggerHandler`, the sanctioned test-double pattern
 * for this package (`tests/access-log.test.ts:51`,
 * `tests/telemetry-seam.test.ts`): a plain object literal satisfies the
 * `M3LLoggerHandler` interface directly, so no `Core.M3LLogger` instance is
 * needed here — only `createConsoleRuntime`'s own `handlers` seam, which is
 * typed as an array of handlers, not loggers.
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

/** What a {@link createRecordingServerResponse} double actually had written to it. */
interface RecordedWrite {
  status?: number;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double whose `end()` resolves `finished` —
 * duplicated from `tests/main-store.test.ts`'s own helper rather than
 * imported, per `.claude/rules/tests.md`.
 */
function createRecordingServerResponse(): {
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
    writeHead: (status: number): ServerResponse => {
      written.status = status;
      res.headersSent = true;
      return res;
    },
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

/** Drives one request through `runtime.requestListener`, awaiting `res.end()`. */
async function dispatch(
  runtime: M3LConsoleRuntime,
  path: string,
): Promise<RecordedWrite> {
  const req = createFakeIncomingMessage({ method: "GET", url: path });
  const { res, written, finished } = createRecordingServerResponse();

  runtime.requestListener(req, res);
  await withTimeout(
    finished,
    `requestListener never called res.end() for GET ${path}`,
  );

  return written;
}

describe("telemetry-http-e2e — real store, real runtime", () => {
  let store: (M3LConsoleStoreHandle & M3LConsoleStore) | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  test("a matched route's request persists exactly one bucket per granularity tier, keyed by the route PATTERN", async () => {
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const probeRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/probe/:id",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "ok" }),
    };
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [probeRoute],
      telemetry: store.telemetry,
    });

    const written = await dispatch(runtime, "/api/v1/probe/7");
    expect(written.status).toBe(200);

    expect(store.telemetry.count()).toBe(3);

    const buckets = store.telemetry.list({
      granularity: "minute",
      metric: "http.request",
      limit: 10,
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket?.route).toBe("/api/v1/probe/:id");
    expect(bucket?.route).not.toContain("7");
    expect(bucket?.outcome).toBe("2xx");
    expect(bucket?.sampleCount).toBe(1);

    // A rejected/dropped write is otherwise invisible except for the count
    // (`createStoreTelemetryRecorder` swallows a repository failure as a
    // logged warning rather than throwing) — assert its absence explicitly.
    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });

  test("a request to an unregistered path persists a '(not-found)' route row", async () => {
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [],
      telemetry: store.telemetry,
    });

    const written = await dispatch(runtime, "/nope");
    expect(written.status).toBe(404);

    expect(store.telemetry.count()).toBe(3);

    const buckets = store.telemetry.list({
      granularity: "minute",
      metric: "http.request",
      limit: 10,
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket?.route).toBe("(not-found)");
    expect(bucket?.outcome).toBe("4xx");
    expect(bucket?.sampleCount).toBe(1);

    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });
});
