/**
 * Tests for src/http/drain-middleware.ts — `createDrainMiddleware` wraps
 * every request in the ADR-0049 drain controller's `track()`/release
 * lifecycle. `src/http/drain-middleware.ts` does not exist yet; this suite
 * is RED until implementation lands.
 */
import { describe, expect, test } from "vitest";

import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { createDrainMiddleware } from "../src/http/drain-middleware.js";
import type { M3LConsoleHandler } from "../src/http/middleware.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
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

  test("releases in a finally, restoring inFlight even when next rejects", async () => {
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
