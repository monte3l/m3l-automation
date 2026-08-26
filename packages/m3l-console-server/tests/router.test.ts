/**
 * Tests for src/http/router.ts — `createRouter`'s matching, conflict
 * detection, and 404/405 outcomes (m3l-console-server X2b contract, wave 2).
 * `src/http/router.ts` does not exist yet; this suite is RED until wave-2
 * implementation lands.
 */
import { describe, expect, test } from "vitest";

import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";

/** A trivially valid success response. */
function okResponse(): M3LConsoleResponse {
  return { status: 200, headers: {}, body: "ok" };
}

/** Builds a minimal `M3LRoute`, defaulting `auth` and `handler`. */
function route(
  overrides: Pick<M3LRoute, "method" | "path"> &
    Partial<Pick<M3LRoute, "auth" | "handler">>,
): M3LRoute {
  return {
    auth: "required",
    handler: () => okResponse(),
    ...overrides,
  };
}

describe("createRouter — :param capture", () => {
  test("captures a single named param", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:id" }),
    ]);

    const result = router.lookup("GET", "/api/v1/runs/42");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.params).toEqual({ id: "42" });
    expect(result.route.path).toBe("/api/v1/runs/:id");
  });

  test("decodes a percent-encoded param value", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:name" }),
    ]);

    const result = router.lookup("GET", "/api/v1/runs/hello%20world");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.params).toEqual({ name: "hello world" });
  });

  test("captures multiple distinct params across segments", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:runId/steps/:stepId" }),
    ]);

    const result = router.lookup("GET", "/api/v1/runs/7/steps/3");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.params).toEqual({ runId: "7", stepId: "3" });
  });
});

describe("createRouter — static beats param at the same position", () => {
  test("prefers the static segment regardless of registration order", () => {
    const staticRoute = route({ method: "GET", path: "/api/v1/runs/summary" });
    const paramRoute = route({ method: "GET", path: "/api/v1/runs/:id" });

    const paramFirst = createRouter([paramRoute, staticRoute]);
    const staticFirst = createRouter([staticRoute, paramRoute]);

    for (const router of [paramFirst, staticFirst]) {
      const result = router.lookup("GET", "/api/v1/runs/summary");
      expect(result.outcome).toBe("matched");
      if (result.outcome !== "matched") throw new Error("expected a match");
      expect(result.route.path).toBe("/api/v1/runs/summary");
    }
  });
});

describe("createRouter — not-found", () => {
  test("returns not-found for a completely unregistered path", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);

    expect(router.lookup("GET", "/api/v1/nope")).toEqual({
      outcome: "not-found",
    });
  });

  test("returns not-found when the segment count differs from every registered route", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:id" }),
    ]);

    expect(router.lookup("GET", "/api/v1/runs")).toEqual({
      outcome: "not-found",
    });
    expect(router.lookup("GET", "/api/v1/runs/42/extra")).toEqual({
      outcome: "not-found",
    });
  });
});

describe("createRouter — method-not-allowed", () => {
  test("carries the sorted set of allowed methods for a registered path", () => {
    const router = createRouter([
      route({ method: "POST", path: "/api/v1/runs" }),
      route({ method: "DELETE", path: "/api/v1/runs" }),
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);

    const result = router.lookup("PUT", "/api/v1/runs");

    expect(result).toEqual({
      outcome: "method-not-allowed",
      allowed: ["DELETE", "GET", "POST"],
    });
  });

  test("does not report method-not-allowed for an unrelated path", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);

    expect(router.lookup("POST", "/api/v1/other")).toEqual({
      outcome: "not-found",
    });
  });
});

describe("createRouter — construction-time conflict detection", () => {
  test("throws ERR_CONSOLE_ROUTE_CONFLICT for two equivalent patterns with the same method", () => {
    const routes = [
      route({ method: "GET", path: "/api/v1/runs/:id" }),
      route({ method: "GET", path: "/api/v1/runs/:name" }),
    ];

    let thrown: unknown;
    try {
      createRouter(routes);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
    expect((thrown as M3LConsoleError).message).toContain("/api/v1/runs/:id");
    expect((thrown as M3LConsoleError).message).toContain("/api/v1/runs/:name");
  });

  test("throws ERR_CONSOLE_ROUTE_CONFLICT for a duplicate :id param name within one pattern", () => {
    let thrown: unknown;
    try {
      createRouter([
        route({ method: "GET", path: "/api/v1/runs/:id/nested/:id" }),
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
  });

  test("does not throw for the same pattern registered under different methods", () => {
    expect(() =>
      createRouter([
        route({ method: "GET", path: "/api/v1/runs/:id" }),
        route({ method: "POST", path: "/api/v1/runs/:id" }),
      ]),
    ).not.toThrow();
  });

  test("does not throw for two literal, non-conflicting paths", () => {
    expect(() =>
      createRouter([
        route({ method: "GET", path: "/api/v1/runs" }),
        route({ method: "GET", path: "/api/v1/runs/summary" }),
      ]),
    ).not.toThrow();
  });
});

describe("createRouter — malformed percent-escape", () => {
  test("surfaces %zz as ERR_CONSOLE_BAD_REQUEST rather than an uncaught URIError", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:id" }),
    ]);

    let thrown: unknown;
    try {
      router.lookup("GET", "/api/v1/runs/%zz");
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

describe("createRouter — routes property", () => {
  test("exposes the registered routes verbatim", () => {
    const registered = [
      route({ method: "GET", path: "/api/v1/runs", auth: "exempt" }),
    ];

    const router = createRouter(registered);

    expect(router.routes).toEqual(registered);
  });
});
