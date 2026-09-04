/**
 * Tests for src/main.ts's X3 console-persistence store wiring (issue #551,
 * ADR-0069): `M3LConsoleRuntimeOptions.config`/`store`,
 * `StartConsoleOptions.openStore`, and `startConsole`'s
 * open-store-before-bind sequencing, its store-close-on-bind-failure
 * cleanup, and the store-closes-after-drain shutdown ordering. Split out of
 * `tests/main.test.ts` (ADR-0072 — that file was already 57,151 bytes
 * against the 60,000 ceiling; the next PR in this stack adds migration and
 * metadata-repository wiring tests on top) — small helpers are duplicated
 * here rather than shared via an import between test files, per
 * `.claude/rules/tests.md`.
 *
 * RED until `main.ts` gains those options and the sequencing they drive.
 * `openStore`/`store`/`config` are not yet accepted options, so every object
 * literal below that supplies them trips a "does not exist in type"
 * excess-property diagnostic under `tsc` — that is the expected (and only
 * acceptable) RED diagnostic here; nothing else in this file should.
 *
 * No real socket and no real OS signal delivery is ever used — a fake
 * `Server` double (mirroring `tests/http-server.test.ts` and
 * `tests/main.test.ts`) stands in for both.
 */
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime, startConsole } from "../src/main.js";
import type { M3LConsoleRuntime, StartConsoleOptions } from "../src/main.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import * as envModule from "../src/config/env.js";
import * as routerModule from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";
import type { M3LConsoleMetaRepository } from "../src/store/meta-repository.js";
import type { M3LConsoleRunsRepository } from "../src/store/runs-repository.js";
import type { M3LConsoleSessionsRepository } from "../src/store/sessions-repository.js";
import type { M3LConsoleAuditRepository } from "../src/store/audit-repository.js";
import type { M3LConsoleTelemetryRepository } from "../src/store/telemetry-repository.js";
import type { M3LConsoleStoreUnit } from "../src/store/store.js";

/**
 * A minimal valid env: only the required operator name set.
 *
 * `M3L_CONSOLE_AUDIT_ROOT` points at a path that deliberately does NOT exist:
 * X7c's boot rebuild (`boot/audit-rebuild.ts`) reads the trail before the
 * listener binds, and an absent directory reads as an empty trail — so these
 * tests neither touch the real data dir nor pay for a tmpdir they never
 * assert on.
 */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(tmpdir(), "m3l-console-audit-absent"),
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
 * A controllable fake `Server`, mirroring `tests/main.test.ts`'s own
 * `FakeServer` (duplicated here rather than imported — see this file's
 * header comment).
 */
interface FakeServer {
  readonly instance: Server;
  readonly calls: string[];
  /** Resolves whichever callback was passed to the most recent `close()` call. */
  resolveClose: (error?: Error) => void;
  /** Emits `listening`, as a real server does once bound. */
  emitListening: () => void;
  /** Emits `error`, as a real server does when the bind fails. */
  emitBindError: (error: Error) => void;
  /** Registers a hook invoked synchronously the instant `close()` is called. */
  setOnCloseCalled: (hook: () => void) => void;
}

function createFakeServer(
  addressValue: AddressInfo | string | null,
): FakeServer {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const state = {
    pendingCloseCallback: undefined as ((error?: Error) => void) | undefined,
    onCloseCalled: undefined as (() => void) | undefined,
  };

  const extensions = {
    listen(...args: unknown[]): Server {
      void args;
      calls.push("listen");
      listened = true;
      flushBind();
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      calls.push("close");
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

  /**
   * Arms the bind outcome; {@link listen} is what actually emits it.
   *
   * A test calls `emitListening()` in the same synchronous turn as
   * `startConsole(...)`, which used to be safe because everything from that
   * call down to `server.listen()` ran without yielding. X7c's audit-index
   * boot rebuild (`boot/audit-rebuild.ts`) put an `await` before the bind, so
   * a bare `emitter.emit(...)` at that point goes nowhere (`listening` hangs
   * the test; `error` is rethrown by `EventEmitter` as unhandled).
   *
   * Arming instead of emitting makes the order irrelevant, DETERMINISTICALLY:
   * `lifecycle/http-server.ts` attaches both handlers BEFORE it calls
   * `listen()` (`server.on("error"/"listening", ...)` then
   * `server.listen(...)`), so an emit driven from inside `listen()` always
   * finds them — no polling and no attempt bound that a slow CI runner can
   * exhaust.
   */
  let listened = false;
  let armedBind: { readonly error?: Error } | undefined;

  const flushBind = (): void => {
    if (!listened || armedBind === undefined) return;
    const outcome = armedBind;
    armedBind = undefined;
    // Asynchronous, as a real `Server` reports its bind outcome.
    setImmediate(() => {
      if (outcome.error === undefined) emitter.emit("listening");
      else emitter.emit("error", outcome.error);
    });
  };

  return {
    instance,
    calls,
    resolveClose(error?: Error) {
      state.pendingCloseCallback?.(error);
    },
    emitListening() {
      armedBind = {};
      flushBind();
    },
    emitBindError(error: Error) {
      armedBind = { error };
      flushBind();
    },
    setOnCloseCalled(hook: () => void) {
      state.onCloseCalled = hook;
    },
  };
}

/**
 * Starts `startConsole` against a fake server that immediately reports a
 * verified loopback bind once `emitListening` is called — mirrors
 * `tests/main.test.ts`'s established timing (the promise executor's
 * synchronous portion, including `server.on`/`server.listen`, runs before
 * the first `await` inside `startConsole`/`startConsoleServer`).
 */
function startWithFakeServer(overrides: Partial<StartConsoleOptions> = {}): {
  readonly promise: ReturnType<typeof startConsole>;
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
 * A minimal local stand-in for `M3LConsoleStoreHandle` — `store/store.ts`'s
 * real type doesn't yet expose `schemaVersion`, so this exists purely to
 * give the fakes below an explicit local shape in RED (the real type is a
 * strict superset once it lands, and stays structurally assignable). Only
 * `isOpen`/`location`/`schemaVersion`/`close()` are ever exercised by these
 * tests — the query-executor methods, `meta`, `runs`, and `transaction` are
 * stubbed to fail loudly if a test hits them by surprise; none of the tests
 * in this file touch `store.runs` (that seam is exercised through
 * `tests/main-runs.test.ts`'s own fake instead), so a loud-throwing stub is
 * correct here too, per `.claude/rules/tests.md`'s "real enough behaviour
 * for whatever the tests touch" guidance.
 *
 * `meta`/`runs`/`transaction` were added once `StartConsoleOptions.openStore`
 * widened from `M3LConsoleStoreHandle` to `M3LConsoleStoreHandle &
 * M3LConsoleStore` (X4 slice 6 round 3b) — every `openStore` fake in this
 * file must now satisfy the wider intersection type.
 */
interface FakeConsoleStoreHandle {
  readonly isOpen: boolean;
  readonly location: string;
  readonly schemaVersion: number;
  close(): void;
  all(): never;
  get(): never;
  run(): never;
  script(): never;
  readonly meta: M3LConsoleMetaRepository;
  readonly runs: M3LConsoleRunsRepository;
  readonly sessions: M3LConsoleSessionsRepository;
  readonly audit: M3LConsoleAuditRepository;
  readonly telemetry: M3LConsoleTelemetryRepository;
  transaction<T>(work: (unit: M3LConsoleStoreUnit) => T): T;
}

/** Throws when a `meta`-repository method is called unexpectedly on a fake store. */
const unexpectedMetaCall = (): never => {
  throw new Error("unexpected meta-repository call on the fake store");
};

/** Throws when a `runs`-repository method is called unexpectedly on a fake store. */
const unexpectedRunsCall = (): never => {
  throw new Error("unexpected runs-repository call on the fake store");
};

/** Throws when a `sessions`-repository method is called unexpectedly on a fake store. */
const unexpectedSessionsCall = (): never => {
  throw new Error("unexpected sessions-repository call on the fake store");
};

/** A loud-throwing `sessions` stub, shared by every fake store in this file (added for X6 slice 1's `M3LConsoleStoreUnit.sessions` field — none of this file's tests exercise it). */
const stubSessionsRepository: M3LConsoleSessionsRepository = {
  insertSession: unexpectedSessionsCall,
  getSession: unexpectedSessionsCall,
  listSessions: unexpectedSessionsCall,
  closeSession: unexpectedSessionsCall,
  reopenSession: unexpectedSessionsCall,
  insertStep: unexpectedSessionsCall,
  claimStepForStart: unexpectedSessionsCall,
  finishStep: unexpectedSessionsCall,
  getStep: unexpectedSessionsCall,
  getStepByOrdinal: unexpectedSessionsCall,
  listStepsForSession: unexpectedSessionsCall,
  insertBinding: unexpectedSessionsCall,
  listBindingsForSession: unexpectedSessionsCall,
  insertDecision: unexpectedSessionsCall,
  answerDecision: unexpectedSessionsCall,
  getDecision: unexpectedSessionsCall,
  listDecisionsForSession: unexpectedSessionsCall,
  countOpenSessions: unexpectedSessionsCall,
  attachStepRun: unexpectedSessionsCall,
  getStepByRunId: unexpectedSessionsCall,
};

/** Throws when an `audit`-repository method is called unexpectedly on a fake store. */
const unexpectedAuditCall = (): never => {
  throw new Error("unexpected audit-repository call on the fake store");
};

/** A mostly-loud `audit` stub, shared by every fake store in this file (added for X7c's `M3LConsoleStoreUnit.audit` field — none of this file's tests exercise it). */
const stubAuditRepository: M3LConsoleAuditRepository = {
  insert: unexpectedAuditCall,
  insertAll: unexpectedAuditCall,
  deleteAll: unexpectedAuditCall,
  list: unexpectedAuditCall,
  // Answers instead of throwing: X7c's boot rebuild legitimately calls
  // `count()` before the bind, so a loud stub here would make every
  // `startConsole` test in this file exercise the rebuild's degradation path
  // and log an error. `0` plus the absent audit root above makes it a clean
  // no-op; every write method stays loud.
  count: (): number => 0,
};

/** Throws when a `telemetry`-repository method is called unexpectedly on a fake store. */
const unexpectedTelemetryCall = (): never => {
  throw new Error("unexpected telemetry-repository call on the fake store");
};

/** A mostly-loud `telemetry` stub, shared by every fake store in this file (added for X8 slice 1's `M3LConsoleStoreUnit.telemetry` field; X8 slice 2b's request instrumentation legitimately reaches the write methods on every request, so `record`/`recordAll` answer quietly here — the read/prune methods stay loud since nothing in the request path calls them). */
const stubTelemetryRepository: M3LConsoleTelemetryRepository = {
  // Answers instead of throwing: X8 slice 2b's `finish-request.ts` calls
  // `telemetry.httpRequest(...)` on every request, which fans out through
  // `record`/`recordAll` on the store-backed recorder. A loud stub here would
  // make every request-handling test in this file exercise the recorder's
  // degradation path and log a "telemetry fan-out dropped" error. `void`
  // and the measurement count are clean no-ops; the read/prune methods stay
  // loud.
  record: (): void => undefined,
  recordAll: (measurements): number => measurements.length,
  list: unexpectedTelemetryCall,
  count: unexpectedTelemetryCall,
  prune: unexpectedTelemetryCall,
};

/** Throws when `transaction()` is called unexpectedly on a fake store. */
function unexpectedTransactionCall<T>(): T {
  throw new Error("unexpected transaction() call on the fake store");
}

/** A loud-throwing `meta` stub, shared by every fake store in this file. */
const stubMetaRepository: M3LConsoleMetaRepository = {
  describe: unexpectedMetaCall,
  history: unexpectedMetaCall,
};

/** A loud-throwing `runs` stub, shared by every fake store in this file. */
const stubRunsRepository: M3LConsoleRunsRepository = {
  insertQueued: unexpectedRunsCall,
  claimForStart: unexpectedRunsCall,
  finish: unexpectedRunsCall,
  get: unexpectedRunsCall,
  list: unexpectedRunsCall,
  countByStatus: unexpectedRunsCall,
  countRunningForScript: unexpectedRunsCall,
  reconcileOrphaned: unexpectedRunsCall,
  abandonQueued: unexpectedRunsCall,
};

/**
 * Builds a recording {@link FakeConsoleStoreHandle}: `close()` records every
 * call and, when `closeShouldThrow` is supplied, throws it every time.
 */
function createFakeStore(
  overrides: {
    location?: string;
    schemaVersion?: number;
    closeShouldThrow?: Error;
  } = {},
): {
  readonly store: FakeConsoleStoreHandle;
  readonly closeCallCount: () => number;
} {
  let closeCalls = 0;
  const unexpectedCall = (): never => {
    throw new Error("unexpected query-executor call on the fake store");
  };
  const store: FakeConsoleStoreHandle = {
    isOpen: true,
    location: overrides.location ?? ":memory:",
    schemaVersion: overrides.schemaVersion ?? 0,
    close(): void {
      closeCalls += 1;
      if (overrides.closeShouldThrow !== undefined) {
        throw overrides.closeShouldThrow;
      }
    },
    all: unexpectedCall,
    get: unexpectedCall,
    run: unexpectedCall,
    script: unexpectedCall,
    meta: stubMetaRepository,
    runs: stubRunsRepository,
    sessions: stubSessionsRepository,
    audit: stubAuditRepository,
    telemetry: stubTelemetryRepository,
    transaction: unexpectedTransactionCall,
  };
  return { store, closeCallCount: () => closeCalls };
}

/**
 * Builds a {@link FakeConsoleStoreHandle} that is already closed
 * (`isOpen: false`) — the shape `/ready`'s `M3LReadinessProbe` reads
 * structurally. Only `isOpen` is exercised by the test below; the
 * query-executor/`meta`/`runs`/`transaction` members are stubbed to fail
 * loudly if hit by surprise.
 */
function createClosedFakeStore(): FakeConsoleStoreHandle {
  const unexpectedCall = (): never => {
    throw new Error("unexpected query-executor call on the fake store");
  };
  return {
    isOpen: false,
    location: ":memory:",
    schemaVersion: 0,
    close(): void {
      /* already closed */
    },
    all: unexpectedCall,
    get: unexpectedCall,
    run: unexpectedCall,
    script: unexpectedCall,
    meta: stubMetaRepository,
    runs: stubRunsRepository,
    sessions: stubSessionsRepository,
    audit: stubAuditRepository,
    telemetry: stubTelemetryRepository,
    transaction: unexpectedTransactionCall,
  };
}

/**
 * Builds a minimal `IncomingMessage` double — an `EventEmitter` carrying
 * just the members the request listener reads (`method`, `url`, `headers`).
 * Duplicated from `tests/main.test.ts` rather than imported — see this
 * file's header comment.
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
 * Builds a `ServerResponse` double that records `writeHead`/`end` calls.
 * Duplicated from `tests/main.test.ts` — see this file's header comment.
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
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Drives one GET request through `runtime.requestListener` end to end, parsing the JSON body once `res.end()` is observed. */
async function dispatch(
  runtime: M3LConsoleRuntime,
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

/**
 * Walks a caught value's native `cause` chain, collecting every link so a
 * test can assert a value is reachable at ANY depth rather than assuming a
 * fixed number of hops.
 */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (
    current !== null &&
    typeof current === "object" &&
    "cause" in current
  ) {
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined) break;
    chain.push(cause);
    current = cause;
  }
  return chain;
}

describe("createConsoleRuntime — options.config short-circuits the resolve", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loadConsoleConfig is NOT called when options.config is supplied — runtime.config is the exact object given", () => {
    const config = envModule.loadConsoleConfig({ env: buildEnv() });
    const spy = vi.spyOn(envModule, "loadConsoleConfig");

    // `env` is deliberately ALSO supplied (and would resolve successfully on
    // its own) so this test's outcome never depends on ambient process.env
    // state — the point under test is that `options.config`, when present,
    // is preferred outright, not merely that a fallback resolve happens not
    // to throw.
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      config,
      handlers: [new RecordingHandler()],
    });

    expect(spy).not.toHaveBeenCalled();
    expect(runtime.config).toBe(config);
  });
});

describe("startConsole — the store is opened before the listener binds", () => {
  test("openStore() runs before server.listen() — recorded in call order, not merely 'both happened'", async () => {
    const { store } = createFakeStore();
    const fake = createFakeServer(tcpAddress());
    const openStore = vi.fn(() => {
      fake.calls.push("openStore");
      return store;
    });

    const promise = startConsole({
      env: buildEnv(),
      createServer: () => fake.instance,
      openStore,
    });
    fake.emitListening();
    const running = await promise;

    expect(fake.calls).toEqual(["openStore", "listen"]);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

describe("startConsole — a store-open failure never binds", () => {
  test("createServer() is never invoked when openStore() throws", async () => {
    const createServerSpy = vi.fn((): Server => {
      throw new Error(
        "test forced failure: createServer must not run when the store failed to open",
      );
    });
    const openStoreError = new Error("boom-open-store");
    const openStore = vi.fn(() => {
      throw openStoreError;
    });

    await expect(
      startConsole({
        env: buildEnv(),
        createServer: createServerSpy,
        openStore,
      }),
    ).rejects.toThrow(openStoreError);

    expect(createServerSpy).not.toHaveBeenCalled();
  });
});

describe("startConsole — a bind failure closes the store", () => {
  test("the store's close() is called exactly once before the ERR_CONSOLE_LISTEN_FAILED propagates", async () => {
    const { store, closeCallCount } = createFakeStore();
    const openStore = vi.fn(() => store);
    const bindError = new Error("bind-boom");
    const fake = createFakeServer(tcpAddress());

    const promise = startConsole({
      env: buildEnv(),
      createServer: () => fake.instance,
      openStore,
    });
    fake.emitBindError(bindError);

    await expect(promise).rejects.toThrow(M3LConsoleError);
    expect(closeCallCount()).toBe(1);
  });
});

describe("startConsole — a runtime-construction failure closes the store [SHOULD-FIX, PR #706 finding 4]", () => {
  // `openStore()`/`createConsoleRuntime()` run BEFORE the `try` that guards
  // the bind path (`src/main.ts` ~462-470). A duplicate route makes
  // `createConsoleRuntime` throw ERR_CONSOLE_ROUTE_CONFLICT (`http/router.ts`)
  // synchronously, before that `try` is ever entered — the same handle/WAL
  // leak class the bind-failure path exists to prevent.
  test("createConsoleRuntime throwing on a duplicate route still closes the already-opened store, and the original error propagates unchanged", async () => {
    const { store, closeCallCount } = createFakeStore();
    const openStore = vi.fn(() => store);
    const duplicateRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/duplicate",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "" }),
    };

    let thrown: unknown;
    try {
      await startConsole({
        env: buildEnv(),
        openStore,
        routes: [duplicateRoute, duplicateRoute],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
    expect(closeCallCount()).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Double-fault paths: a store `close()` that ITSELF fails while `main.ts` is
// already handling a construction/bind failure. These are deliberately
// distinct from the single-failure tests directly above (which use a store
// whose `close()` succeeds) — they exercise `chainSecondaryFailure` and the
// `runtime === undefined` branch that selects between chaining the close
// failure onto `cause`'s own cause chain (no runtime, so no logger yet) and
// logging it through `runtime.logger` (a runtime exists; only the bind
// failed). Neither of these second failures is reachable from a
// single-failure fixture, which is why they shipped uncovered.
// -----------------------------------------------------------------------------

describe("startConsole — a runtime-construction failure AND a store close failure (double fault)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("createConsoleRuntime throwing on a duplicate route, with no pre-existing cause, chains the close failure onto the original error's own cause — the original error still propagates unchanged", async () => {
    const closeError = new Error("close-boom-no-runtime");
    const { store, closeCallCount } = createFakeStore({
      closeShouldThrow: closeError,
    });
    const openStore = vi.fn(() => store);
    const duplicateRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/duplicate-double-fault",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "" }),
    };

    let thrown: unknown;
    try {
      await startConsole({
        env: buildEnv(),
        openStore,
        routes: [duplicateRoute, duplicateRoute],
      });
    } catch (error) {
      thrown = error;
    }

    // The original construction failure propagates unchanged — identity on
    // both the instance's code and its class, not merely "something threw".
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
    expect(closeCallCount()).toBe(1);

    // There is no `runtime.logger` for this close failure to be reported
    // through (createConsoleRuntime is what threw), so it has nowhere left
    // to go but the original error's own cause chain — walk it rather than
    // assuming a fixed depth.
    expect(causeChain(thrown)).toContain(closeError);
  });

  // `createRouter` (`http/router.ts`) is spied out rather than relying on a
  // duplicate-route conflict, because none of that module's
  // `ERR_CONSOLE_ROUTE_CONFLICT` errors carry a `cause` — there is no
  // deterministic, undocumented-internals-free way to make
  // `createConsoleRuntime` throw an error that already has one otherwise.
  // Spying the named export mirrors this file's existing
  // `envModule.loadConsoleConfig` spy technique above.
  test("a pre-existing cause on the construction error is preserved, and the close failure is still reachable further down the chain — chainSecondaryFailure never overwrites an existing cause but never drops the secondary failure either", async () => {
    const preExistingCause = new Error("pre-existing-cause");
    const constructionError = new Error("construction-boom-with-cause", {
      cause: preExistingCause,
    });
    vi.spyOn(routerModule, "createRouter").mockImplementation(() => {
      throw constructionError;
    });

    const closeError = new Error("close-boom-pre-existing-cause");
    const { store, closeCallCount } = createFakeStore({
      closeShouldThrow: closeError,
    });
    const openStore = vi.fn(() => store);

    let thrown: unknown;
    try {
      await startConsole({ env: buildEnv(), openStore });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(constructionError);
    expect(closeCallCount()).toBe(1);

    // `failure.cause === undefined` is FALSE here (it is already
    // `preExistingCause`), so `chainSecondaryFailure` must leave it exactly
    // as it was — never replacing it with the close failure. But the close
    // failure must not simply vanish either: `chainSecondaryFailure` walks
    // past the already-set `cause` to the first free slot further down the
    // chain and attaches it there, so it is appended beyond the existing
    // cause rather than discarded.
    expect((thrown as Error).cause).toBe(preExistingCause);
    expect(causeChain(thrown)).toEqual([preExistingCause, closeError]);
    expect(preExistingCause.cause).toBe(closeError);
  });
});

describe("startConsole — a bind failure AND a store close failure (double fault)", () => {
  test("the close failure is logged through runtime.logger — a runtime exists, only the bind failed — while the original bind failure still propagates unchanged", async () => {
    const closeError = new Error("close-boom-bind-double-fault");
    const { store, closeCallCount } = createFakeStore({
      closeShouldThrow: closeError,
    });
    const openStore = vi.fn(() => store);
    const bindError = new Error("bind-boom-double-fault");
    const fake = createFakeServer(tcpAddress());
    const handler = new RecordingHandler();

    const promise = startConsole({
      env: buildEnv(),
      createServer: () => fake.instance,
      openStore,
      handlers: [handler],
    });
    fake.emitBindError(bindError);

    let thrown: unknown;
    try {
      await promise;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_LISTEN_FAILED");
    expect(closeCallCount()).toBe(1);

    const errorEvents = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(errorEvents)).toContain("console store close failed");
  });
});

describe("startConsole — the store closes after the drain and the listener close both settle", () => {
  test("the store is still open at the instant server.close() is invoked, and closed exactly once after shutdown settles", async () => {
    const { store, closeCallCount } = createFakeStore();
    const openStore = vi.fn(() => store);
    const { promise, fake } = startWithFakeServer({ openStore });
    const running = await promise;

    let storeCloseCallsWhenListenerCloseInvoked: number | undefined;
    fake.setOnCloseCalled(() => {
      storeCloseCallsWhenListenerCloseInvoked = closeCallCount();
    });

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;

    expect(storeCloseCallsWhenListenerCloseInvoked).toBe(0);
    expect(closeCallCount()).toBe(1);
  });
});

describe("startConsole — 'closed' still resolves the drain outcome when the store's close() throws", () => {
  test("a failing store close() is logged at error level but does not reject 'closed' or 'shutdown()'", async () => {
    const closeError = new Error("store-close-boom");
    const { store } = createFakeStore({ closeShouldThrow: closeError });
    const openStore = vi.fn(() => store);
    const handler = new RecordingHandler();

    const { promise, fake } = startWithFakeServer({
      openStore,
      handlers: [handler],
    });
    const running = await promise;

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    const outcome = await shutdownPromise;

    expect(outcome.graceful).toBe(true);
    const closedOutcome = await running.closed;
    expect(closedOutcome).toEqual(outcome);

    const errorEvents = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("startConsole — the boot line names the store's location and schemaVersion", () => {
  test("logs 'console store ready' naming location and schemaVersion, after the listener has bound", async () => {
    const handler = new RecordingHandler();
    const { store } = createFakeStore({
      location: "/tmp/x3-console-store-boot-line/console.sqlite",
      schemaVersion: 0,
    });
    const openStore = vi.fn(() => store);

    const { promise, fake } = startWithFakeServer({
      openStore,
      handlers: [handler],
    });
    const running = await promise;

    const rendered = JSON.stringify(handler.events);
    expect(rendered).toContain("console store ready");
    expect(rendered).toContain(
      "/tmp/x3-console-store-boot-line/console.sqlite",
    );
    expect(rendered).toContain("schemaVersion");

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

describe("startConsole — /ready reflects the store's health through the composed listener (wiring defect regression)", () => {
  // `main.ts`'s `buildDispatchRouter` calls `createHealthRoutes({ drain,
  // startedAt })` and never forwards `options.store`, even though
  // `createConsoleRuntime` has it in scope by the time the dispatch router
  // is built. `createHealthRoutes` itself is fully correct — proven in
  // isolation by `tests/health.test.ts` — which is exactly why this shipped
  // unnoticed: no existing test drives `/ready` through the REAL composed
  // `startConsole` -> `createConsoleRuntime` -> `requestListener` path with a
  // closed store. This test is the conformance proof for the structural
  // `M3LReadinessProbe` type: it must observe `/ready` degrade with the real
  // store wired through `startConsole`, not merely call
  // `createHealthRoutes` directly.
  test("GET /ready is 503 { status: 'unavailable' } when the opened store reports isOpen: false, while GET /health stays 200", async () => {
    const store = createClosedFakeStore();
    const openStore = vi.fn(() => store);
    const { promise, fake } = startWithFakeServer({ openStore });
    const running = await promise;

    const ready = await dispatch(running.runtime, "/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "unavailable" });

    const health = await dispatch(running.runtime, "/health");
    expect(health.status).toBe(200);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});
