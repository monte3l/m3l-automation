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
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime, startConsole } from "../src/main.js";
import type { StartConsoleOptions } from "../src/main.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import * as envModule from "../src/config/env.js";

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

  return {
    instance,
    calls,
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
 * tests — the query-executor methods are stubbed to fail loudly if a test
 * hits them by surprise.
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
}

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
  };
  return { store, closeCallCount: () => closeCalls };
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
    fake.instance.emit("error", bindError);

    await expect(promise).rejects.toThrow(M3LConsoleError);
    expect(closeCallCount()).toBe(1);
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
