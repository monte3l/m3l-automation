/**
 * Tests for src/lifecycle/http-server.ts — `startConsoleServer` (m3l-console-server
 * lifecycle contract). `src/lifecycle/http-server.ts` does not exist yet; this
 * suite is RED until the implementation lands.
 *
 * A fake `Server` double is used throughout — not a shortcut, but the only way
 * to reach the failure paths under test: `address()` returning `null`, a
 * string, or a non-loopback address cannot be produced by a real server asked
 * to bind loopback (see `tests/integration/http-server.integration.test.ts`
 * for the handful of guarantees that genuinely need a real socket). The fake
 * is a real `node:events` `EventEmitter` (so `once`/`on`/`removeListener`
 * behave exactly like the real `Server`'s) with `listen`/`close`/
 * `closeIdleConnections`/`closeAllConnections`/`address` layered on top.
 */
import { EventEmitter } from "node:events";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { startConsoleServer } from "../src/lifecycle/http-server.js";
import type { M3LListeningServer } from "../src/lifecycle/http-server.js";

/** A `RequestListener` that never runs in these unit tests — no real socket. */
const noopListener: RequestListener = () => undefined;

/** Builds a TCP `AddressInfo` fixture for a fake server's `address()`. */
function tcpAddress(address: string, port = 45871): AddressInfo {
  return { address, family: address.includes(":") ? "IPv6" : "IPv4", port };
}

/**
 * A controllable fake `Server`. Built on a real `EventEmitter` so
 * `once`/`on`/`removeListener` behave exactly like the real class; `listen`,
 * `close`, `closeIdleConnections`, `closeAllConnections`, and `address` are
 * layered on top and recorded for assertions.
 */
interface FakeServer {
  readonly instance: Server;
  /** Lifecycle method calls, in invocation order — drives the close-ordering pin. */
  readonly calls: string[];
  readonly listenArgs: unknown[][];
  closeCallCount: number;
  closeIdleConnectionsCallCount: number;
  closeAllConnectionsCallCount: number;
  /** Resolves whichever callback was passed to the most recent `close()` call. */
  resolveClose: (error?: Error) => void;
  /** Emits `listening`, as a real server does once bound. */
  emitListening: () => void;
  /** Emits `error`, as a real server does on a failed `listen()`. */
  emitError: (error: Error) => void;
}

function createFakeServer(
  addressValue: AddressInfo | string | null,
): FakeServer {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const listenArgs: unknown[][] = [];
  const state = {
    closeCallCount: 0,
    closeIdleConnectionsCallCount: 0,
    closeAllConnectionsCallCount: 0,
    pendingCloseCallback: undefined as ((error?: Error) => void) | undefined,
  };

  const extensions = {
    listen(...args: unknown[]): Server {
      calls.push("listen");
      listenArgs.push(args);
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      calls.push("close");
      state.closeCallCount += 1;
      state.pendingCloseCallback = callback;
      return extensions as unknown as Server;
    },
    closeIdleConnections(): void {
      calls.push("closeIdleConnections");
      state.closeIdleConnectionsCallCount += 1;
    },
    closeAllConnections(): void {
      calls.push("closeAllConnections");
      state.closeAllConnectionsCallCount += 1;
    },
    address(): AddressInfo | string | null {
      return addressValue;
    },
  };

  const instance = Object.assign(emitter, extensions) as unknown as Server;

  return {
    instance,
    calls,
    listenArgs,
    get closeCallCount() {
      return state.closeCallCount;
    },
    get closeIdleConnectionsCallCount() {
      return state.closeIdleConnectionsCallCount;
    },
    get closeAllConnectionsCallCount() {
      return state.closeAllConnectionsCallCount;
    },
    resolveClose(error?: Error) {
      state.pendingCloseCallback?.(error);
    },
    emitListening() {
      emitter.emit("listening");
    },
    emitError(error: Error) {
      emitter.emit("error", error);
    },
  };
}

/** Awaits `promise`, captures a thrown/rejected value, and returns it. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

/** Asserts `thrown` is an `M3LConsoleError` with the given `code`. */
function expectConsoleErrorCode(
  thrown: unknown,
  code: M3LConsoleError["code"],
): asserts thrown is M3LConsoleError {
  expect(thrown).toBeInstanceOf(M3LConsoleError);
  expect((thrown as M3LConsoleError).code).toBe(code);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startConsoleServer — successful bind", () => {
  test("resolves host/port from the server's actual address(), not the requested options", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1", 45871));

    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitListening();

    const result: M3LListeningServer = await promise;
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(45871);
    expect(result.port).not.toBe(0);
  });
});

describe("startConsoleServer — the security assertion: reject a non-loopback bind, and never leak the socket", () => {
  // `address()` returning the literal strings "0.0.0.0"/"::" is not how a
  // real TCP `Server.address()` reports a bind-all host (those come back as
  // the `.address` field of an `AddressInfo`); the null and UNIX-socket-path
  // cases genuinely are the whole return value. Every case below is
  // reachable from the fake regardless, and the implementation must reject
  // all four rather than trust a shape it did not ask for.
  const cases: [string, AddressInfo | string | null][] = [
    ["an AddressInfo bound to 0.0.0.0 (IPv4 bind-all)", tcpAddress("0.0.0.0")],
    ["an AddressInfo bound to :: (IPv6 bind-all)", tcpAddress("::")],
    ["null", null],
    ["a UNIX socket path string", "/tmp/x.sock"],
  ];

  test.each(cases)(
    "rejects with ERR_CONSOLE_LISTEN_FAILED and closes the server when address() returns %s",
    async (_label, addressValue) => {
      const fake = createFakeServer(addressValue);

      const promise = startConsoleServer({
        host: "127.0.0.1",
        port: 0,
        listener: noopListener,
        closeTimeoutMs: 5_000,
        createServer: () => fake.instance,
      });
      fake.emitListening();

      const thrown = await captureRejection(promise);
      expectConsoleErrorCode(thrown, "ERR_CONSOLE_LISTEN_FAILED");

      // Assert-then-leak is the exact bug this pin exists to catch.
      expect(fake.closeCallCount).toBeGreaterThanOrEqual(1);
    },
  );

  test("wraps a foreign (non-M3LConsoleError) throw from server.address() as ERR_CONSOLE_LISTEN_FAILED, chaining it as cause", async () => {
    // `options.createServer` is a public injection seam: the `Server` is
    // caller-supplied external input, not something this module fully
    // controls. A fake, a wrapper, or a future subclass can throw something
    // other than M3LConsoleError from address() — that is what the ternary's
    // false arm exists to normalize, so the caller always observes the
    // module's own error contract instead of a foreign error type leaking
    // through. This is reachable input, not a hypothetical.
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const foreignError = new Error("address unavailable");
    fake.instance.address = () => {
      throw foreignError;
    };

    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitListening();

    const thrown = await captureRejection(promise);
    expectConsoleErrorCode(thrown, "ERR_CONSOLE_LISTEN_FAILED");
    expect(thrown.cause).toBe(foreignError);

    // Assert-then-leak is the exact bug this pin exists to catch.
    expect(fake.closeCallCount).toBeGreaterThanOrEqual(1);
  });
});

describe("startConsoleServer — a legitimate loopback bind is accepted", () => {
  test.each<[string]>([["127.0.0.1"], ["::1"], ["127.0.0.2"]])(
    // Binding `localhost` really does resolve to `::1` on Node, so rejecting
    // the IPv6 loopback form here would break the most natural config value.
    "accepts %s",
    async (address) => {
      const fake = createFakeServer(tcpAddress(address));

      const promise = startConsoleServer({
        host: "127.0.0.1",
        port: 0,
        listener: noopListener,
        closeTimeoutMs: 5_000,
        createServer: () => fake.instance,
      });
      fake.emitListening();

      const result = await promise;
      expect(result.host).toBe(address);
    },
  );
});

describe("startConsoleServer — a listen() failure", () => {
  test("rejects with ERR_CONSOLE_LISTEN_FAILED and chains the original error as cause", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const originalError = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });

    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitError(originalError);

    const thrown = await captureRejection(promise);
    expectConsoleErrorCode(thrown, "ERR_CONSOLE_LISTEN_FAILED");
    expect(thrown.cause).toBe(originalError);
  });

  test("does not leave its own error listener attached after a failed start", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const removeListenerSpy = vi.spyOn(fake.instance, "removeListener");
    const originalError = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });

    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitError(originalError);
    await captureRejection(promise);

    // A later runtime error must not be mis-attributed to boot — the
    // module's own startup `error` listener must have been detached.
    expect(removeListenerSpy).toHaveBeenCalled();
    expect(
      removeListenerSpy.mock.calls.some(([eventName]) => eventName === "error"),
    ).toBe(true);
  });
});

describe("startConsoleServer — close()", () => {
  function startResolved(fake: FakeServer): Promise<M3LListeningServer> {
    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitListening();
    return promise;
  }

  test("is idempotent — two calls both resolve, and the underlying close() is invoked once", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const listeningServer = await startResolved(fake);

    const firstClose = listeningServer.close();
    const secondClose = listeningServer.close();
    fake.resolveClose();

    await expect(firstClose).resolves.toBeUndefined();
    await expect(secondClose).resolves.toBeUndefined();
    expect(fake.closeCallCount).toBe(1);
  });

  test("is safe to call after a failed start — a close-time error does not override the original listen failure", async () => {
    // Simulates the internal cleanup close (triggered by the non-loopback
    // rejection below) itself failing; the caller must still observe the
    // original ERR_CONSOLE_LISTEN_FAILED, not an unrelated close error.
    const fake = createFakeServer(tcpAddress("0.0.0.0"));
    const closeFailure = new Error("close failed");

    const promise = startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener: noopListener,
      closeTimeoutMs: 5_000,
      createServer: () => fake.instance,
    });
    fake.emitListening();
    fake.resolveClose(closeFailure);

    const thrown = await captureRejection(promise);
    expectConsoleErrorCode(thrown, "ERR_CONSOLE_LISTEN_FAILED");
  });

  // PR review finding: `createCloseOnce`'s `server.close(callback)` drops the
  // callback's own `error` argument — it only ever calls `resolve()`,
  // regardless of what `close()` passed back. So a real close failure (e.g.
  // Node's own `ERR_SERVER_NOT_RUNNING`) is reported to the caller as a clean
  // success, and `main.ts`'s `runShutdownSequence` would report a graceful
  // shutdown that never actually happened.
  test("rejects with an M3LConsoleError, chaining the original error as cause, when the close callback receives an error", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const listeningServer = await startResolved(fake);
    const closeError = new Error("ERR_SERVER_NOT_RUNNING");

    const closePromise = listeningServer.close();
    fake.resolveClose(closeError);

    const thrown = await captureRejection(closePromise);

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).cause).toBe(closeError);
  });

  test("still resolves cleanly when the close callback is invoked with no error (undefined)", async () => {
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const listeningServer = await startResolved(fake);

    const closePromise = listeningServer.close();
    fake.resolveClose(undefined);

    await expect(closePromise).resolves.toBeUndefined();
  });

  test("closeIdleConnections() runs after close() is initiated; closeAllConnections() only fires at the closeTimeoutMs deadline", async () => {
    vi.useFakeTimers();
    const closeTimeoutMs = 5_000;
    const fake = createFakeServer(tcpAddress("127.0.0.1"));
    const listeningServer = await startResolved(fake);

    const closePromise = listeningServer.close();

    // Fast path: close() was initiated and idle sockets were swept — but the
    // forceful kill must not have fired yet, or a graceful drain becomes a
    // kill on every request in flight.
    expect(fake.calls).toContain("close");
    expect(fake.calls).toContain("closeIdleConnections");
    expect(fake.calls.indexOf("close")).toBeLessThan(
      fake.calls.indexOf("closeIdleConnections"),
    );
    expect(fake.calls).not.toContain("closeAllConnections");

    await vi.advanceTimersByTimeAsync(closeTimeoutMs);
    expect(fake.calls).toContain("closeAllConnections");

    fake.resolveClose();
    await closePromise;
  });
});
