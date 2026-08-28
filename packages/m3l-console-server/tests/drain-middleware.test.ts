/**
 * Tests for src/http/drain-middleware.ts — `createDrainMiddleware` wraps
 * every request in the ADR-0049 drain controller's `track()`/release
 * lifecycle. `src/http/drain-middleware.ts` does not exist yet; this suite
 * is RED until implementation lands.
 */
import { describe, expect, test } from "vitest";

import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext, withAccessMode } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { createDrainMiddleware } from "../src/http/drain-middleware.js";
import type { M3LConsoleHandler } from "../src/http/middleware.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { isStreamResponse } from "../src/http/stream-response.js";
import type {
  M3LConsoleResult,
  M3LStreamSink,
} from "../src/http/stream-response.js";
import { createDrainController } from "../src/lifecycle/drain.js";

/** A minimal, deterministic request context for middleware tests. */
function buildContext(): M3LRequestContext {
  return createRequestContext({
    method: "GET",
    url: "/api/v1/runs",
    headers: {},
    signal: new AbortController().signal,
  });
}

/** A trivially valid success response. */
function okResponse(): M3LConsoleResponse {
  return { status: 200, headers: {}, body: "ok" };
}

/** A trivially valid stream result whose `open` is fully caller-controlled. */
function streamResult(
  open: (sink: M3LStreamSink) => Promise<void>,
): M3LConsoleResult {
  return { kind: "stream", status: 200, headers: {}, open };
}

/** A `M3LStreamSink` double that just records nothing — the sink is never asserted on here. */
function inertSink(): M3LStreamSink {
  return {
    emit: () => {
      /* no-op: this suite asserts drain tracking, not frame delivery */
    },
    closed: false,
  };
}

/** A deferred promise, resolved from outside its own constructor. */
function createDeferred<Value = void>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yields the microtask queue a few times so a pending `await` chain settles. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("createDrainMiddleware — while serving", () => {
  test("tracks the request, calls next, and releases once next resolves", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    let observedInFlightDuringNext = -1;
    const handler: M3LConsoleHandler = () => {
      observedInFlightDuringNext = controller.inFlight;
      return okResponse();
    };

    const middleware = createDrainMiddleware(controller);
    const response = await middleware(buildContext(), handler);

    expect(observedInFlightDuringNext).toBe(priorInFlight + 1);
    expect(controller.inFlight).toBe(priorInFlight);
    expect(response).toEqual(okResponse());
  });

  test("releases on the reject path, restoring inFlight even when next rejects", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const boom = new Error("handler boom");
    const handler: M3LConsoleHandler = () => Promise.reject(boom);

    const middleware = createDrainMiddleware(controller);

    await expect(middleware(buildContext(), handler)).rejects.toThrow(
      "handler boom",
    );
    expect(controller.inFlight).toBe(priorInFlight);
  });

  test("a rejected next still releases and propagates the original error unchanged", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const boom = new Error("original failure");
    const handler: M3LConsoleHandler = () => Promise.reject(boom);

    const middleware = createDrainMiddleware(controller);

    let thrown: unknown;
    try {
      await middleware(buildContext(), handler);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(controller.inFlight).toBe(0);
  });
});

describe("createDrainMiddleware — once draining", () => {
  test("track() throws ERR_CONSOLE_UNAVAILABLE and next is never called", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    void controller.drain();
    let handlerCalls = 0;
    const handler: M3LConsoleHandler = () => {
      handlerCalls += 1;
      return okResponse();
    };

    const middleware = createDrainMiddleware(controller);

    let thrown: unknown;
    try {
      await middleware(buildContext(), handler);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_UNAVAILABLE");
    expect(handlerCalls).toBe(0);
  });

  test("the ERR_CONSOLE_UNAVAILABLE throw propagates rather than being caught into a response", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    void controller.drain();
    const handler: M3LConsoleHandler = () => okResponse();

    const middleware = createDrainMiddleware(controller);

    await expect(middleware(buildContext(), handler)).rejects.toThrow(
      /draining|unavailable/i,
    );
  });
});

/**
 * Bug 3: `createDrainMiddleware` currently releases its tracked unit in a
 * plain `finally { release(); }` once `next()` resolves — for a stream
 * result, `next()` resolves at *open*, not at stream completion, so
 * `inFlight` reaches 0 while a watcher is still attached. The intended fix
 * drops the `finally` in favour of an explicit `releaseOnce` on both the
 * resolve and throw paths, wrapping the resolved result with
 * `withStreamCompletion` so release is deferred to the stream's own `open()`
 * settling. `createDrainMiddleware` never invokes `open()` itself — these
 * tests drive it directly, the way `handler.ts`'s stream branch eventually
 * will.
 */
describe("createDrainMiddleware — streaming results (Bug 3)", () => {
  test("a stream result is NOT released when next() resolves — inFlight stays incremented", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const deferred = createDeferred<void>();
    const handler: M3LConsoleHandler = () =>
      streamResult(async (sink) => {
        sink.emit({ event: "test", data: "1" });
        await deferred.promise;
      });
    const middleware = createDrainMiddleware(controller);

    const result = await middleware(buildContext(), handler);

    expect(controller.inFlight).toBe(priorInFlight + 1);
    expect(isStreamResponse(result)).toBe(true);

    deferred.resolve();
    if (isStreamResponse(result)) {
      await result.open(inertSink());
    }
  });

  test("a stream result releases once its own open() settles", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const deferred = createDeferred<void>();
    const handler: M3LConsoleHandler = () =>
      streamResult(async (sink) => {
        sink.emit({ event: "test", data: "1" });
        await deferred.promise;
      });
    const middleware = createDrainMiddleware(controller);

    const result = await middleware(buildContext(), handler);
    if (!isStreamResponse(result)) {
      throw new Error("expected a stream result from the drain middleware");
    }

    const openPromise = result.open(inertSink());
    await flushMicrotasks();
    expect(controller.inFlight).toBe(priorInFlight + 1);

    deferred.resolve();
    await openPromise;

    expect(controller.inFlight).toBe(priorInFlight);
  });

  test("a stream result releases even when its own open() rejects, and the rejection propagates unchanged", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const boom = new Error("stream open boom");
    const handler: M3LConsoleHandler = () =>
      streamResult(() => Promise.reject(boom));
    const middleware = createDrainMiddleware(controller);

    const result = await middleware(buildContext(), handler);
    if (!isStreamResponse(result)) {
      throw new Error("expected a stream result from the drain middleware");
    }

    // Sanity: still tracked at this point (release deferred to open()
    // settling) — otherwise the assertions below would pass identically
    // under the pre-fix `finally { release(); }`, which releases the
    // instant `next()` resolves, well before this rejecting `open()` is
    // even invoked.
    expect(controller.inFlight).toBe(priorInFlight + 1);

    let thrown: unknown;
    try {
      await result.open(inertSink());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(controller.inFlight).toBe(priorInFlight);
  });

  test("a buffered (non-stream) result is still released as soon as next() resolves — unaffected by the streaming wrap", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const handler: M3LConsoleHandler = () => okResponse();
    const middleware = createDrainMiddleware(controller);

    const result = await middleware(buildContext(), handler);

    expect(controller.inFlight).toBe(priorInFlight);
    expect(result).toEqual(okResponse());
  });

  test("release happens exactly once per tracked unit — inFlight does not go negative across two settles", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const deferred = createDeferred<void>();
    const handler: M3LConsoleHandler = () =>
      streamResult(async () => {
        await deferred.promise;
      });
    const middleware = createDrainMiddleware(controller);

    const result = await middleware(buildContext(), handler);
    if (!isStreamResponse(result)) {
      throw new Error("expected a stream result from the drain middleware");
    }

    // Sanity: still tracked before either settle — otherwise both
    // assertions below would pass identically under the pre-fix
    // `finally { release(); }`, which releases the instant `next()`
    // resolves and never touches `inFlight` again from here on.
    expect(controller.inFlight).toBe(priorInFlight + 1);

    deferred.resolve();
    await result.open(inertSink());
    expect(controller.inFlight).toBe(priorInFlight);

    // The SAME wrapped `open` settling a second time (its underlying promise
    // is already resolved, so this resolves immediately) must not
    // double-decrement `inFlight` below the prior count —
    // `withStreamCompletion`'s `once()` guard is what this exercises, driven
    // through the real middleware seam.
    await result.open(inertSink());
    expect(controller.inFlight).toBe(priorInFlight);
  });

  test("an exempt route skips drain tracking entirely, streaming or not", async () => {
    const controller = createDrainController({ timeoutMs: 1000 });
    const priorInFlight = controller.inFlight;
    const handler: M3LConsoleHandler = () =>
      streamResult(async () => {
        /* resolves immediately; tracking should never have started */
      });
    const middleware = createDrainMiddleware(controller);
    const exemptCtx = withAccessMode(buildContext(), "exempt");

    const result = await middleware(exemptCtx, handler);

    expect(controller.inFlight).toBe(priorInFlight);
    expect(isStreamResponse(result)).toBe(true);
  });
});
