/**
 * Tests for src/main.ts — `createConsoleRuntime` (the composition root) and
 * `startConsole` (the lifecycle entry point: bind, wire the composed
 * middleware chains, register shutdown signals, and drain on the way down).
 * `startConsole` does not exist yet; its describe blocks are RED until the
 * implementation lands. No real socket and no real OS signal delivery is
 * ever used — a fake `Server` double (mirroring `tests/http-server.test.ts`)
 * plus `process.on`/`process.exit` spies (mirroring
 * `packages/m3l-common/tests/script.test.ts`'s proven-safe pattern for
 * `registerShutdownSignals`) stand in for both.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime, startConsole } from "../src/main.js";
import type { M3LRunningConsole, StartConsoleOptions } from "../src/main.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { jsonResponse } from "../src/http/respond.js";
import type { M3LRoute } from "../src/http/router.js";

/** A minimal valid env: only the required operator name set. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    ...overrides,
  };
}

/** A recording `M3LLoggerHandler` fake — the sanctioned test-double pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Builds a TCP `AddressInfo` fixture for a fake server's `address()`. */
function tcpAddress(address = "127.0.0.1", port = 48651): AddressInfo {
  return { address, family: address.includes(":") ? "IPv6" : "IPv4", port };
}

/**
 * A controllable fake `Server`, mirroring `tests/http-server.test.ts`'s
 * pattern: a real `EventEmitter` (so `once`/`on`/`removeListener` behave
 * like the real class) with `listen`/`close`/`closeIdleConnections`/
 * `closeAllConnections`/`address` layered on top. `setOnCloseCalled` is
 * this file's own addition — it lets a test snapshot other observable state
 * (e.g. `runtime.signal.aborted`) at the exact instant `close()` is invoked,
 * to pin shutdown ORDER rather than just eventual outcome.
 */
interface FakeServer {
  readonly instance: Server;
  readonly calls: string[];
  closeCallCount: number;
  /** Resolves whichever callback was passed to the most recent `close()` call. */
  resolveClose: (error?: Error) => void;
  /** Emits `listening`, as a real server does once bound. */
  emitListening: () => void;
  /** Registers a hook invoked synchronously the instant `close()` is called. */
  setOnCloseCalled: (hook: () => void) => void;
}

function createFakeServer(
  addressValue: AddressInfo | string | null,
): FakeServer {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const state = {
    closeCallCount: 0,
    pendingCloseCallback: undefined as ((error?: Error) => void) | undefined,
    onCloseCalled: undefined as (() => void) | undefined,
  };

  const extensions = {
    listen(...args: unknown[]): Server {
      void args;
      calls.push("listen");
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      calls.push("close");
      state.closeCallCount += 1;
      state.pendingCloseCallback = callback;
      state.onCloseCalled?.();
      return extensions as unknown as Server;
    },
    closeIdleConnections(): void {
      calls.push("closeIdleConnections");
    },
    closeAllConnections(): void {
      calls.push("closeAllConnections");
    },
    address(): AddressInfo | string | null {
      return addressValue;
    },
  };

  const instance = Object.assign(emitter, extensions) as unknown as Server;

  return {
    instance,
    calls,
    get closeCallCount() {
      return state.closeCallCount;
    },
    resolveClose(error?: Error) {
      state.pendingCloseCallback?.(error);
    },
    emitListening() {
      emitter.emit("listening");
    },
    setOnCloseCalled(hook: () => void) {
      state.onCloseCalled = hook;
    },
  };
}

/**
 * Starts `startConsole` against a fake server that immediately reports a
 * verified loopback bind once `emitListening` is called — invoked here
 * synchronously right after `startConsole`, mirroring
 * `tests/http-server.test.ts`'s established timing (the promise executor's
 * synchronous portion, including `server.on`/`server.listen`, runs before
 * the first `await` inside `startConsole`/`startConsoleServer`).
 */
function startWithFakeServer(overrides: Partial<StartConsoleOptions> = {}): {
  readonly promise: Promise<M3LRunningConsole>;
  readonly fake: FakeServer;
} {
  const fake = createFakeServer(tcpAddress());
  const promise = startConsole({
    env: buildEnv(),
    createServer: () => fake.instance,
    ...overrides,
  });
  fake.emitListening();
  return { promise, fake };
}

/**
 * Builds a minimal `IncomingMessage` double — an `EventEmitter` carrying
 * just the members the request listener reads (`method`, `url`, `headers`),
 * mirroring `tests/handler.test.ts`'s established pattern.
 */
function createFakeIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url" | "headers">> = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, {
    method: "GET",
    url: "/",
    headers: {},
    ...overrides,
  });
  return req;
}

/** What a {@link createRecordingServerResponse} double actually had written to it. */
interface RecordedWrite {
  status?: number;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that records `writeHead`/`end` calls,
 * mirroring `tests/handler.test.ts`'s established pattern. No real socket.
 */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly written: RecordedWrite;
  /**
   * Resolves the moment `end()` is called on this double. A middleware
   * chain's depth (how many `composeMiddleware` layers and `wrapLayer`/
   * `dispatch` async boundaries a request crosses) is not a test's
   * business to know — a fixed tick budget calibrated to today's chain is
   * a latent failure the moment another layer (auth, origin guard, a
   * future X4 middleware) is added. Awaiting actual completion instead of
   * guessing a tick count keeps the test correct regardless of chain
   * depth.
   */
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
      written.headers = headers;
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

/** Drains the microtask queue `times` times — enough for a fire-and-forget promise chain (e.g. a signal handler's `Promise.resolve().then(...)`) to settle before an assertion. */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Races `promise` against a short timeout that rejects with a clear
 * message, so a genuinely broken implementation (one that never calls
 * `end()` — e.g. auth wiring dropped from the composed chain) fails fast
 * and legibly instead of silently hitting vitest's global test timeout.
 */
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
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe("createConsoleRuntime — resolved config", () => {
  test("returns the config resolved from the injected env", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_PORT: "9090" }),
      handlers: [handler],
    });

    expect(runtime.config).toEqual({
      host: "127.0.0.1",
      port: 9090,
      operatorName: "ada",
      operatorEmail: undefined,
      drainTimeoutMs: 15000,
      logLevel: "info",
    });
  });

  test("returns a Core.M3LLogger instance", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime.logger).toBeInstanceOf(Core.M3LLogger);
  });
});

describe("createConsoleRuntime — posture log line", () => {
  test("a supplied handler receives exactly one info-level posture event", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_PORT: "8080" }),
      handlers: [handler],
    });

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });

  test("the posture event names host, port, operator name, drain timeout, and log level", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({
        M3L_CONSOLE_HOST: "localhost",
        M3L_CONSOLE_PORT: "8080",
        M3L_CONSOLE_OPERATOR_NAME: "grace",
        M3L_CONSOLE_DRAIN_TIMEOUT_MS: "5000",
        M3L_CONSOLE_LOG_LEVEL: "debug",
      }),
      handlers: [handler],
    });

    const [event] = handler.events;
    const rendered = JSON.stringify(event);
    expect(rendered).toContain("localhost");
    expect(rendered).toContain("8080");
    expect(rendered).toContain("grace");
    expect(rendered).toContain("5000");
    expect(rendered).toContain("debug");
  });

  test("never logs the operator email, even when one is configured", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_EMAIL: "ada@example.com" }),
      handlers: [handler],
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("ada@example.com");
  });
});

describe("createConsoleRuntime — logger secrets port (operator email leak regression)", () => {
  // The security review PROVED this leak against a real M3LLogger:
  // `operatorEmail`/`email` is NOT in m3l-common's built-in
  // `SENSITIVE_KEY_NAMES` set, so a later layer doing something as ordinary
  // as `logger.info(msg, { ...runtime.config })` printed the operator's
  // email verbatim before `main.ts` wired a `secrets` port onto the
  // constructed `M3LLogger`. This reproduces that exact call shape through
  // the runtime's own logger, not a fresh one, so it fails if the `secrets`
  // port is ever removed from `createConsoleRuntime`.
  test("redacts the operator email when a caller logs the spread runtime config, while a non-secret field still appears", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_EMAIL: "ada@example.com" }),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered spread", { ...runtime.config });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("ada@example.com");
    expect(rendered).toContain("127.0.0.1");
  });
});

describe("createConsoleRuntime — logger secrets port covers headers/cookie", () => {
  // `M3LRequestContext` now carries `headers` (see tests/context.test.ts).
  // Pinning `isSecret("cookie")`/`isSecret("headers")` indirectly through
  // observable logger output, since `runtimeSecrets` is a module-private
  // const in main.ts, not an exported symbol.
  test("isSecret treats a top-level 'cookie' field as secret, independent of any headers wrapping", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered field", {
      cookie: "TOPLEVEL-COOKIE-CANARY",
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("TOPLEVEL-COOKIE-CANARY");
  });

  test("isSecret treats a top-level 'headers' field as secret, even when its nested keys are otherwise unremarkable", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered field", {
      headers: { pragma: "NO-CACHE-CANARY" },
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("NO-CACHE-CANARY");
  });
});

describe("createConsoleRuntime — logger secrets port (request-headers leak regression)", () => {
  // MEASURED against a real M3LLogger: redaction recurses and DOES redact a
  // nested `authorization` header (it's in the library's built-in
  // `SENSITIVE_KEY_NAMES`), but `cookie` is NOT in that set and leaked
  // verbatim. Adding `headers` to `M3LRequestContext` therefore makes an
  // ordinary `logger.info(msg, { ...ctx })` print a session cookie in full —
  // the same class of defect as the operator-email leak above, fixed the
  // same structural way: widen `runtimeSecrets` rather than rely on every
  // future call site remembering not to spread `ctx.headers` into a log
  // call. Reproduces the exact call shape through the runtime's own logger,
  // not a fresh one, so it fails if the `secrets` port is ever narrowed.
  test("redacts a nested cookie AND a nested authorization header, while a non-secret sibling field still appears", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    const cookieValue = "sid=CANARY-SESSION-COOKIE-1";
    const authValue = "Bearer CANARY-AUTH-TOKEN-2";

    runtime.logger.info("caller-triggered spread of a request context", {
      method: "GET",
      headers: { cookie: cookieValue, authorization: authValue },
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain(cookieValue);
    expect(rendered).not.toContain(authValue);
    expect(rendered).toContain("GET");
  });
});

describe("createConsoleRuntime — default handler path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("without an explicit handlers option, writes one JSON line to process.stdout via the default M3LJsonLoggerHandler", () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    createConsoleRuntime({ env: buildEnv() });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [written] = writeSpy.mock.calls[0] as [string];
    const parsed: unknown = JSON.parse(written);
    expect(parsed).toMatchObject({ category: "info" });
  });
});

describe("createConsoleRuntime — env option omitted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("resolves configuration from the real process.env when no env option is supplied", () => {
    vi.stubEnv("M3L_CONSOLE_OPERATOR_NAME", "ada");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const runtime = createConsoleRuntime();

    expect(runtime.config.operatorName).toBe("ada");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createConsoleRuntime — config failure propagates", () => {
  test("throws the underlying M3LConsoleError instead of swallowing it, when the operator name is missing", () => {
    expect(() =>
      createConsoleRuntime({
        env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: undefined }),
      }),
    ).toThrow(M3LConsoleError);
  });

  test("never binds a socket or otherwise produces a listening side effect", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime).not.toHaveProperty("server");
    expect(runtime).not.toHaveProperty("close");
  });

  test("registers no process signal handler — process.listenerCount for SIGTERM/SIGINT is unchanged across the call", () => {
    const handler = new RecordingHandler();
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    createConsoleRuntime({ env: buildEnv(), handlers: [handler] });

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });
});

describe("createConsoleRuntime — operator composition", () => {
  test("builds the operator from the resolved config's operatorName/operatorEmail", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({
        M3L_CONSOLE_OPERATOR_NAME: "grace",
        M3L_CONSOLE_OPERATOR_EMAIL: "grace@example.com",
      }),
      handlers: [handler],
    });

    expect(runtime.operator).toEqual({
      name: "grace",
      email: "grace@example.com",
    });
    expect(runtime.operator.name).toBe(runtime.config.operatorName);
    expect(runtime.operator.email).toBe(runtime.config.operatorEmail);
  });

  test("operatorProvider is the single-operator provider, and resolve() returns the same operator profile", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: "ada" }),
      handlers: [handler],
    });

    expect(runtime.operatorProvider.kind).toBe("single-operator");
    expect(runtime.operatorProvider.resolve({})).toEqual(runtime.operator);
  });
});

describe("createConsoleRuntime — routes option reaches the router", () => {
  test("a routes array passed through options is reachable via runtime.router", () => {
    const handler = new RecordingHandler();
    const route: M3LRoute = {
      method: "GET",
      path: "/api/v1/health",
      auth: "exempt",
      handler: () => ({ status: 200, headers: {}, body: "ok" }),
    };

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [route],
    });

    expect(runtime.router.routes).toEqual([route]);
    expect(runtime.router.lookup("GET", "/api/v1/health")).toMatchObject({
      outcome: "matched",
    });
  });
});

// This divergence is INTENTIONAL and load-bearing (a code-review finding
// confirmed against the source, not a bug): `runtime.router` reflects
// `options.routes` VERBATIM, for a caller's own introspection, while
// `requestListener` actually dispatches through a SEPARATE router built by
// `buildDispatchRouter`, which merges the built-in health routes ahead of
// `options.routes` so a caller can never accidentally shadow `/health` or
// `/ready`. Nothing previously pinned this, so a future "fix" that made
// `runtime.router` the same object `requestListener` dispatches through
// would silently change this guarantee. See `buildDispatchRouter`'s own
// TSDoc in `src/main.ts` for the rationale.
describe("createConsoleRuntime — runtime.router and the live dispatch router are deliberately different objects", () => {
  test("runtime.router.lookup('GET', '/health') is not-found, even though the live requestListener answers 200 for GET /health", async () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    // `runtime.router` only ever knows about `options.routes` (empty here)
    // — it never sees the built-in health routes at all.
    expect(runtime.router.lookup("GET", "/health")).toMatchObject({
      outcome: "not-found",
    });

    // Yet the SAME runtime's live `requestListener` — which dispatches
    // through `buildDispatchRouter`'s merged router, not `runtime.router`
    // — answers the same path with a real 200.
    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() for GET /health",
    );

    expect(written.status).toBe(200);
  });
});

// `assertNoRequiredAuthRoutes` is gone: now that the auth middleware exists
// and is wired into `createConsoleRuntime`'s own `requestListener`, an
// `auth: "required"` route is no longer a composition-time misconfiguration
// — it is accepted, and it is genuinely authenticated. This replaces the
// prior "throws ERR_CONSOLE_CONFIG_INVALID" test with the stronger claim the
// auth middleware now makes true, rather than merely deleting a test whose
// behavior went away with nothing standing in for it.
describe("createConsoleRuntime — an auth: 'required' route is accepted and genuinely authenticated", () => {
  test("a route declaring auth: 'required' observes the resolved operator on ctx — auth actually ran, it was not bypassed", async () => {
    const handler = new RecordingHandler();
    const route: M3LRoute = {
      method: "GET",
      path: "/api/v1/runs",
      auth: "required",
      // Proves the auth middleware ran (not merely that the request
      // succeeded): `ctx.operator` is only ever populated by
      // `withOperator`, which only the auth middleware calls. If auth were
      // bypassed, `ctx.operator` would stay `undefined` and this key would
      // be entirely absent from the serialized JSON body.
      handler: (ctx) => jsonResponse(200, { operator: ctx.operator ?? null }),
    };

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: "ada" }),
      handlers: [handler],
      routes: [route],
    });

    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/api/v1/runs",
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() — auth wiring may be broken",
    );

    expect(written.status).toBe(200);
    const body = JSON.parse(written.body ?? "null") as { operator: unknown };
    expect(body.operator).toEqual({ name: "ada", email: null });
  });
});

describe("createConsoleRuntime — drain signal", () => {
  test("runtime.signal is an unaborted AbortSignal at construction", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime.signal).toBeInstanceOf(AbortSignal);
    expect(runtime.signal.aborted).toBe(false);
  });
});

// =============================================================================
// PR review MUST-FIX: health routes must survive a drain through the COMPOSED
// listener. `main.ts` registers `createDrainMiddleware(drain)` in
// `preRouting`, which runs before routing for EVERY request — including the
// `auth: "exempt"` health routes — and `createDrainMiddleware` calls
// `controller.track()` unconditionally, which throws `ERR_CONSOLE_UNAVAILABLE`
// the instant the controller leaves "serving". So today, once a drain starts,
// `GET /health` returns a 503 error envelope instead of health.ts's
// documented 200 `{ status: "ok", uptimeMs }`, and `GET /ready` returns that
// same error envelope instead of its own plain `{ status: "draining" }` body
// — that branch of `buildReadyHandler` is unreachable through the composed
// listener. These tests deliberately drive `runtime.requestListener` (never
// the route handlers directly, which the pre-existing health suite already
// does and is why this defect shipped unnoticed) and start the drain via
// `runtime.drain` directly — `createConsoleRuntime` exposes it for exactly
// this kind of test, per its own TSDoc.
// =============================================================================
describe("createConsoleRuntime — health routes survive a drain (composition defect regression)", () => {
  /** A non-exempt route this suite uses to prove the drain refusal still applies to real work. */
  const requiredRoute: M3LRoute = {
    method: "GET",
    path: "/api/v1/secure-during-drain",
    auth: "required",
    handler: () => jsonResponse(200, { ok: true }),
  };

  function buildDrainableRuntime(): ReturnType<typeof createConsoleRuntime> {
    const handler = new RecordingHandler();
    return createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [requiredRoute],
    });
  }

  /** Drives one GET request through `runtime.requestListener` end to end, parsing the JSON body once `res.end()` is observed. */
  async function dispatch(
    runtime: ReturnType<typeof createConsoleRuntime>,
    path: string,
  ): Promise<{ status: number | undefined; body: unknown }> {
    const req = createFakeIncomingMessage({
      method: "GET",
      url: path,
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      `requestListener never called res.end() for GET ${path}`,
    );

    return {
      status: written.status,
      body:
        written.body !== undefined
          ? (JSON.parse(written.body) as unknown)
          : undefined,
    };
  }

  // Baseline: this is expected to pass both before and after the fix — it
  // only pins that nothing is broken absent a drain.
  test("before any drain: health is 200 ok, ready is 200 ready, and the required route serves normally", async () => {
    const runtime = buildDrainableRuntime();

    const health = await dispatch(runtime, "/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok" });

    const ready = await dispatch(runtime, "/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready" });

    const required = await dispatch(runtime, "/api/v1/secure-during-drain");
    expect(required.status).toBe(200);
  });

  test("GET /health returns 200 { status: 'ok', uptimeMs } during a drain — NOT an error envelope", async () => {
    const runtime = buildDrainableRuntime();
    void runtime.drain.drain();
    expect(runtime.drain.state).toBe("draining");

    const health = await dispatch(runtime, "/health");

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok" });
    expect(health.body).not.toHaveProperty("error");
  });

  test("GET /ready returns a plain 503 { status: 'draining' } body during a drain — NOT an ERR_CONSOLE_UNAVAILABLE envelope", async () => {
    const runtime = buildDrainableRuntime();
    void runtime.drain.drain();
    expect(runtime.drain.state).toBe("draining");

    const ready = await dispatch(runtime, "/ready");

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "draining" });
    expect(ready.body).not.toHaveProperty("error");
    expect(ready.body).not.toHaveProperty("code");
  });

  // The over-correction guard: expected to pass both before and after the
  // fix — a "fix" that disabled the drain middleware entirely to make the
  // two tests above pass would show up here as a regression.
  test("a non-exempt (auth: 'required') route is STILL refused with ERR_CONSOLE_UNAVAILABLE during a drain", async () => {
    const runtime = buildDrainableRuntime();
    void runtime.drain.drain();

    const required = await dispatch(runtime, "/api/v1/secure-during-drain");

    expect(required.status).toBe(503);
    const body = required.body as { error?: { code?: string } };
    expect(body.error?.code).toBe("ERR_CONSOLE_UNAVAILABLE");
  });
});

// =============================================================================
// startConsole — lifecycle entry point
// =============================================================================

describe("startConsole — resolves a running console from the verified bind", () => {
  test("server.host/server.port come from the fake server's verified address(), not a requested value", async () => {
    const { promise, fake } = startWithFakeServer();

    const running = await promise;

    expect(running.server.host).toBe("127.0.0.1");
    expect(running.server.port).toBe(48651);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

describe("startConsole — 'closed' vs 'shutdown()' are different things", () => {
  test("'closed' is still pending immediately after start — merely starting (or awaiting 'closed') must never itself trigger a drain", async () => {
    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    let settled = false;
    void running.closed.then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    // Clean up: this test only pins that starting didn't drain; it must not
    // leave a running server/signal handlers dangling into later tests.
    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });

  test("shutdown() triggers the drain and resolves an M3LDrainOutcome; 'closed' then resolves to an equal outcome", async () => {
    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    const outcome = await shutdownPromise;

    expect(outcome.graceful).toBe(true);
    expect(outcome.abandoned).toBe(0);

    const closedOutcome = await running.closed;
    expect(closedOutcome).toEqual(outcome);
  });

  test("shutdown() is idempotent — a second call resolves an equal outcome and does not drain (or close the listener) a second time", async () => {
    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    const first = running.shutdown();
    fake.resolveClose();
    const firstOutcome = await first;

    const secondOutcome = await running.shutdown();

    expect(secondOutcome).toEqual(firstOutcome);
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
  });
});

describe("startConsole — shutdown order: drain begins before the listener closes", () => {
  // `server.close()` refuses new connections with ECONNREFUSED the instant
  // it is CALLED (not merely once its callback settles), so if the listener
  // closed before the drain began, there would be a window where the server
  // is unreachable yet nothing (a readiness probe, `runtime.signal`) has
  // observed a drain in progress. `runtime.signal` is the same field
  // `createConsoleRuntime`'s own TSDoc names as the future home for the
  // drain controller's signal ("a later slice replaces the owner with
  // M3LDrainController without changing this field's shape") — exactly the
  // slice this test targets. `M3LDrainController.drain()` aborts its signal
  // SYNCHRONOUSLY, before returning, so if `shutdown()` starts the drain
  // before calling `close()`, the signal must already be aborted at the
  // exact instant `close()` is invoked.
  test("runtime.signal is already aborted by the time the fake server's close() is invoked", async () => {
    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    let signalAbortedAtCloseTime: boolean | undefined;
    fake.setOnCloseCalled(() => {
      signalAbortedAtCloseTime = running.runtime.signal.aborted;
    });

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;

    expect(fake.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(signalAbortedAtCloseTime).toBe(true);
  });
});

describe("startConsole — default signal trap set (real process, mirroring registerShutdownSignals)", () => {
  test("traps all three of SIGTERM, SIGINT, and SIGQUIT by default — not just the first two", async () => {
    const baseline = {
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGQUIT: process.listenerCount("SIGQUIT"),
    };

    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM + 1);
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT + 1);
    expect(process.listenerCount("SIGQUIT")).toBe(baseline.SIGQUIT + 1);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });

  test("removes all three signal handlers once the drain settles — a leak would trip MaxListenersExceededWarning and make an unrelated suite flaky", async () => {
    const baseline = {
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGQUIT: process.listenerCount("SIGQUIT"),
    };

    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;

    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM);
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT);
    expect(process.listenerCount("SIGQUIT")).toBe(baseline.SIGQUIT);
  });

  test("honors a caller-supplied 'signals' seam instead of the default trap set", async () => {
    const baseline = {
      SIGHUP: process.listenerCount("SIGHUP"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };

    const { promise, fake } = startWithFakeServer({ signals: ["SIGHUP"] });
    const running = await promise;

    expect(process.listenerCount("SIGHUP")).toBe(baseline.SIGHUP + 1);
    // The default set must not ALSO be trapped when an explicit override is given.
    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;

    expect(process.listenerCount("SIGHUP")).toBe(baseline.SIGHUP);
  });
});

describe("startConsole — trapped signal behavior (process.on captured via spy, never emitted for real)", () => {
  // Mirrors packages/m3l-common/tests/script.test.ts's proven-safe pattern
  // for registerShutdownSignals: spy on `process.on` to CAPTURE the handler
  // function without ever registering it on the real `process`, then invoke
  // the captured function directly. This never touches the real event
  // system, so it cannot be affected by (or affect) any other listener
  // already registered on `process` by the test runner or another suite —
  // unlike `process.emit(signal)`, which would run every listener currently
  // registered for that event, not just the one under test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a trapped signal starts the drain, and 'closed' resolves", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        if (typeof eventName === "string") {
          handlers.set(eventName, listener);
        }
        return process;
      },
    );

    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();

    sigtermHandler?.();
    await flushMicrotasks();
    fake.resolveClose();

    const outcome = await running.closed;
    expect(outcome.graceful).toBe(true);
  });

  test("a second trapped signal force-exits without waiting for the drain to complete", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(
      (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
        if (typeof eventName === "string") {
          handlers.set(eventName, listener);
        }
        return process;
      },
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    // The fake server's close() is never resolved in this test: the whole
    // point is that the second signal must not wait for the drain (or the
    // listener close) to complete before forcing an exit.
    const { promise } = startWithFakeServer();
    await promise;

    const sigtermHandler = handlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();

    sigtermHandler?.();
    sigtermHandler?.();

    expect(exitSpy).toHaveBeenCalled();
  });
});

describe("startConsole — composed chains are wired into runtime.requestListener", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("preRouting carries the origin guard: a hostile Host header is rejected with 400", async () => {
    const { promise, fake } = startWithFakeServer();
    const running = await promise;

    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/",
      headers: { host: "evil.example" },
    });
    const { res, written } = createRecordingServerResponse();

    running.runtime.requestListener(req, res);
    await flushMicrotasks();

    expect(written.status).toBe(400);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });

  test("middlewares carries auth: a registered auth: 'required' route observes the resolved operator on ctx (auth actually ran, not bypassed)", async () => {
    const route: M3LRoute = {
      method: "GET",
      path: "/api/v1/secure",
      auth: "required",
      // See the identical rationale in the createConsoleRuntime auth test
      // above: `ctx.operator` is only populated by the auth middleware, so
      // its presence in the body proves auth ran rather than was bypassed.
      handler: (ctx) => jsonResponse(200, { operator: ctx.operator ?? null }),
    };
    const { promise, fake } = startWithFakeServer({ routes: [route] });
    const running = await promise;

    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/api/v1/secure",
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    running.runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() — auth wiring may be broken",
    );

    expect(written.status).toBe(200);
    const body = JSON.parse(written.body ?? "null") as { operator: unknown };
    expect(body.operator).toEqual({ name: "ada", email: null });

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

// =============================================================================
// startConsole — 'closed' must settle on a REJECTING shutdown sequence too
// (error-handling audit regression: `resolveClosed` is only ever invoked on
// `runShutdownSequence`'s success branch, so a rejecting shutdown leaves
// `closed` pending forever — a silent hang, not a surfaced failure).
// =============================================================================

/**
 * Builds a fake server whose close() THROWS SYNCHRONOUSLY. `createCloseOnce`
 * (`lifecycle/http-server.ts`) calls `server.close(cb)` inside a `Promise`
 * executor with no `try`/`catch` of its own, so a synchronous throw there
 * makes the executor itself throw, which the `Promise` constructor turns
 * into a rejection — in turn rejecting `runShutdownSequence`'s
 * `Promise.all`. This is the seam the audit named to drive the "closed
 * never settles on a rejecting shutdown" defect deterministically, with no
 * real socket involved.
 */
function createServerWithThrowingClose(closeError: Error): FakeServer {
  const fake = createFakeServer(tcpAddress());
  Object.assign(fake.instance, {
    close: (): Server => {
      throw closeError;
    },
  });
  return fake;
}

/** The signal set `startConsole` traps by default (mirrors `DEFAULT_SIGNALS` in `src/main.ts`). */
const TRAPPED_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGTERM",
  "SIGINT",
  "SIGQUIT",
];

/** A `process.on(signal, ...)` listener's shape, narrower than `EventEmitter.listeners()`'s own `Function[]` return type. */
type SignalListenerFn = (...args: unknown[]) => void;

/**
 * Snapshots the exact listener functions currently registered for
 * `TRAPPED_SIGNALS`, so a later call to {@link stripLeakedSignalListeners}
 * can remove precisely what a test added — not just restore a count. Every
 * test below drives `startConsole` against a REAL (unspied) `process.on`,
 * so on the defect's RED path (`closed` never settling) the registered
 * `handleSignal` listener is never cleaned up by the implementation itself;
 * without this, that leaked listener would corrupt every later test file's
 * own `process.listenerCount` baseline for the rest of the worker process.
 */
function snapshotSignalListeners(): ReadonlyMap<
  NodeJS.Signals,
  SignalListenerFn[]
> {
  return new Map(
    TRAPPED_SIGNALS.map((signal) => [
      signal,
      process.listeners(signal) as SignalListenerFn[],
    ]),
  );
}

/** Removes any listener present now but absent from `before` — this test's own leak, regardless of pass/fail. */
function stripLeakedSignalListeners(
  before: ReadonlyMap<NodeJS.Signals, SignalListenerFn[]>,
): void {
  for (const signal of TRAPPED_SIGNALS) {
    const untouched = before.get(signal) ?? [];
    for (const listener of process.listeners(signal) as SignalListenerFn[]) {
      if (!untouched.includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
}

describe("startConsole — 'closed' rejects (rather than hanging) when the shutdown sequence fails", () => {
  test("'closed' rejects and carries the original cause, instead of staying pending forever", async () => {
    const before = snapshotSignalListeners();
    const closeError = new Error("close-boom-1");
    const fake = createServerWithThrowingClose(closeError);

    try {
      const promise = startConsole({
        env: buildEnv(),
        createServer: () => fake.instance,
      });
      fake.emitListening();
      const running = await promise;

      void running.shutdown().catch(() => {});

      // Never await this directly without a timeout guard: today `closed`
      // never settles on this path, so a bare `await running.closed` would
      // hang until vitest's global test timeout — slow and illegible.
      // Attach a no-op catch immediately too, so a fix landing mid-run
      // never produces an unhandled-rejection warning from this unawaited
      // handle.
      running.closed.catch(() => {});

      const settled = await withTimeout(
        running.closed.then(
          (outcome) => ({ kind: "resolved" as const, outcome }),
          (cause: unknown) => ({ kind: "rejected" as const, cause }),
        ),
        "closed never settled",
        500,
      );

      expect(settled.kind).toBe("rejected");
      if (settled.kind === "rejected") {
        // Identity, not just a message match: a swallowed/re-wrapped cause
        // would still be "an error", but this is half the defect too.
        expect(settled.cause).toBe(closeError);
      }
    } finally {
      stripLeakedSignalListeners(before);
    }
  });

  test("shutdown() also rejects on that same failing path, so a caller awaiting it directly observes the failure too", async () => {
    const before = snapshotSignalListeners();
    const closeError = new Error("close-boom-2");
    const fake = createServerWithThrowingClose(closeError);

    try {
      const promise = startConsole({
        env: buildEnv(),
        createServer: () => fake.instance,
      });
      fake.emitListening();
      const running = await promise;
      running.closed.catch(() => {});

      let thrown: unknown;
      try {
        await running.shutdown();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(closeError);
    } finally {
      stripLeakedSignalListeners(before);
    }
  });

  test("signal listeners are still removed even when the shutdown sequence fails — cleanup must not be a happy-path-only side effect", async () => {
    const before = snapshotSignalListeners();
    const baselineCounts = new Map<NodeJS.Signals, number>(
      TRAPPED_SIGNALS.map((signal) => [signal, process.listenerCount(signal)]),
    );

    const closeError = new Error("close-boom-3");
    const fake = createServerWithThrowingClose(closeError);

    try {
      const promise = startConsole({
        env: buildEnv(),
        createServer: () => fake.instance,
      });
      fake.emitListening();
      const running = await promise;
      running.closed.catch(() => {});

      await running.shutdown().catch(() => {});
      // The cleanup this test pins is wired off `closed.finally(...)`, not
      // off `shutdown()`'s own settling — give any such chain a few
      // microtask turns to run before asserting, mirroring this file's
      // established `flushMicrotasks` pattern for fire-and-forget chains.
      await flushMicrotasks(8);

      for (const signal of TRAPPED_SIGNALS) {
        expect(process.listenerCount(signal)).toBe(baselineCounts.get(signal));
      }
    } finally {
      // Regardless of outcome, remove any listener this test's failing
      // shutdown leaked, so it never pollutes a later test's own baseline
      // count — this cleanup exists precisely BECAUSE the defect under
      // test is a listener leak.
      stripLeakedSignalListeners(before);
    }
  });
});
