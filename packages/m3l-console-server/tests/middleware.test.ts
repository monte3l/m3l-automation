/**
 * Tests for src/http/middleware.ts — `composeMiddleware`'s onion composition
 * (m3l-console-server X2b contract, wave 2). `src/http/middleware.ts` does
 * not exist yet; this suite is RED until wave-2 implementation lands.
 */
import { describe, expect, test } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { composeMiddleware } from "../src/http/middleware.js";
import type {
  M3LConsoleHandler,
  M3LConsoleMiddleware,
} from "../src/http/middleware.js";

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

describe("composeMiddleware — onion ordering", () => {
  test("runs middlewares outermost-first, then the handler, then unwinds back outward", async () => {
    const order: string[] = [];
    const outer: M3LConsoleMiddleware = async (ctx, next) => {
      order.push("outer:before");
      const response = await next(ctx);
      order.push("outer:after");
      return response;
    };
    const inner: M3LConsoleMiddleware = async (ctx, next) => {
      order.push("inner:before");
      const response = await next(ctx);
      order.push("inner:after");
      return response;
    };
    const handler: M3LConsoleHandler = () => {
      order.push("handler");
      return okResponse();
    };

    const composed = composeMiddleware([outer, inner])(handler);
    const response = await composed(buildContext());

    expect(order).toEqual([
      "outer:before",
      "inner:before",
      "handler",
      "inner:after",
      "outer:after",
    ]);
    expect(response).toEqual(okResponse());
  });
});

describe("composeMiddleware — empty list", () => {
  test("returns the handler unchanged when given no middlewares", () => {
    const handler: M3LConsoleHandler = () => okResponse();

    const composed = composeMiddleware([])(handler);

    expect(composed).toBe(handler);
  });
});

describe("composeMiddleware — a middleware that short-circuits", () => {
  test("never calls the handler when a middleware returns without calling next", async () => {
    let handlerCalls = 0;
    const shortCircuit: M3LConsoleMiddleware = () =>
      Promise.resolve({
        status: 403,
        headers: {},
        body: "forbidden",
      });
    const handler: M3LConsoleHandler = () => {
      handlerCalls += 1;
      return okResponse();
    };

    const composed = composeMiddleware([shortCircuit])(handler);
    const response = await composed(buildContext());

    expect(response.status).toBe(403);
    expect(handlerCalls).toBe(0);
  });
});

describe("composeMiddleware — a middleware that throws", () => {
  test("propagates a synchronous throw as a rejection", async () => {
    const boom: M3LConsoleMiddleware = () => {
      throw new Error("boom");
    };
    const handler: M3LConsoleHandler = () => okResponse();

    const composed = composeMiddleware([boom])(handler);

    await expect(composed(buildContext())).rejects.toThrow("boom");
  });

  test("propagates a rejected promise from a middleware", async () => {
    const boom: M3LConsoleMiddleware = () =>
      Promise.reject(new Error("async boom"));
    const handler: M3LConsoleHandler = () => okResponse();

    const composed = composeMiddleware([boom])(handler);

    await expect(composed(buildContext())).rejects.toThrow("async boom");
  });

  test("a throw from an inner middleware still unwinds through an outer middleware", async () => {
    const order: string[] = [];
    const outer: M3LConsoleMiddleware = async (ctx, next) => {
      try {
        return await next(ctx);
      } finally {
        order.push("outer:finally");
      }
    };
    const inner: M3LConsoleMiddleware = () => {
      throw new Error("inner boom");
    };
    const handler: M3LConsoleHandler = () => okResponse();

    const composed = composeMiddleware([outer, inner])(handler);

    await expect(composed(buildContext())).rejects.toThrow("inner boom");
    expect(order).toEqual(["outer:finally"]);
  });
});

describe("composeMiddleware — next() called twice", () => {
  test("throws ERR_CONSOLE_INTERNAL rather than silently re-running the chain", async () => {
    let handlerCalls = 0;
    const handler: M3LConsoleHandler = () => {
      handlerCalls += 1;
      return okResponse();
    };
    const doubleNext: M3LConsoleMiddleware = async (ctx, next) => {
      await next(ctx);
      return next(ctx);
    };

    const composed = composeMiddleware([doubleNext])(handler);

    let thrown: unknown;
    try {
      await composed(buildContext());
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect(handlerCalls).toBe(1);
  });

  test("calling next() twice in an outer middleware does not re-run an inner middleware", async () => {
    let innerCalls = 0;
    const inner: M3LConsoleMiddleware = (ctx, next) => {
      innerCalls += 1;
      return next(ctx);
    };
    const doubleNextOuter: M3LConsoleMiddleware = async (ctx, next) => {
      await next(ctx);
      return next(ctx);
    };
    const handler: M3LConsoleHandler = () => okResponse();

    const composed = composeMiddleware([doubleNextOuter, inner])(handler);

    let thrown: unknown;
    try {
      await composed(buildContext());
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect(innerCalls).toBe(1);
  });
});
