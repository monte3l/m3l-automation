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

describe("createRouter — rejects a non-upper-case method at construction time", () => {
  // Before this guard, `lookup` compares methods case-sensitively, so a
  // `"get"` registration would silently never match any request and report
  // 405 for every attempt instead of surfacing the typo at construction time.
  test("throws ERR_CONSOLE_CONFIG_INVALID for a lower-case method", () => {
    let thrown: unknown;
    try {
      createRouter([route({ method: "get", path: "/api/v1/runs" })]);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect((thrown as M3LConsoleError).message).toContain("/api/v1/runs");
    expect((thrown as M3LConsoleError).message).toContain("get");
  });

  test("does not throw, and matches requests, for an upper-case method", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);

    expect(router.lookup("GET", "/api/v1/runs")).toMatchObject({
      outcome: "matched",
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

describe("createRouter — per-position specificity, not total param count", () => {
  // The motivating case (X2b, S5): both patterns have exactly one `:param`,
  // so the OLD total-param-count comparison tied and fell back to whichever
  // was registered first — silently deciding `auth` by array order. A
  // differing-`auth` version of this exact pair is now rejected outright at
  // construction time (see "construction-time cross-auth overlap
  // detection" below), so both routes here share `auth` to isolate the
  // pure specificity decision: static beats param at the first DIFFERING
  // position (position 1: "b" vs ":x"), regardless of registration order.
  test("prefers the pattern with an earlier static segment, registered first", () => {
    const earlyParam = route({
      method: "GET",
      path: "/a/:x/c",
      auth: "required",
    });
    const earlyStatic = route({
      method: "GET",
      path: "/a/b/:y",
      auth: "required",
    });

    const router = createRouter([earlyParam, earlyStatic]);
    const result = router.lookup("GET", "/a/b/c");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.route.path).toBe("/a/b/:y");
  });

  test("resolves the identical pair to the same winner when registered in the opposite order", () => {
    const earlyParam = route({
      method: "GET",
      path: "/a/:x/c",
      auth: "required",
    });
    const earlyStatic = route({
      method: "GET",
      path: "/a/b/:y",
      auth: "required",
    });

    const router = createRouter([earlyStatic, earlyParam]);
    const result = router.lookup("GET", "/a/b/c");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.route.path).toBe("/a/b/:y");
  });
});

describe("createRouter — construction-time cross-auth overlap detection", () => {
  test("throws ERR_CONSOLE_ROUTE_CONFLICT for a static-vs-param overlap declaring different auth modes", () => {
    // Same shape as the specificity test above, but with DIFFERENT auth:
    // every position is pairwise compatible (":x" is a param at position 1,
    // literal "c"/":y" is compatible at position 2), so this pair would
    // resolve deterministically by specificity — but which route's `auth`
    // a request lands under would still depend on the two patterns' shapes
    // rather than any declared intent. Rejected at construction instead.
    let thrown: unknown;
    try {
      createRouter([
        route({ method: "GET", path: "/a/:x/c", auth: "required" }),
        route({ method: "GET", path: "/a/b/:y", auth: "exempt" }),
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
    expect((thrown as M3LConsoleError).message).toContain("/a/:x/c");
    expect((thrown as M3LConsoleError).message).toContain("/a/b/:y");
  });

  test("throws when the SECOND route is the param side (b-is-param arm) rather than the first", () => {
    let thrown: unknown;
    try {
      createRouter([
        route({
          method: "GET",
          path: "/api/v1/runs/summary",
          auth: "required",
        }),
        route({ method: "GET", path: "/api/v1/runs/:id", auth: "exempt" }),
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
  });

  test("does not throw when overlapping routes share the same auth mode", () => {
    expect(() =>
      createRouter([
        route({
          method: "GET",
          path: "/api/v1/runs/summary",
          auth: "required",
        }),
        route({ method: "GET", path: "/api/v1/runs/:id", auth: "required" }),
      ]),
    ).not.toThrow();
  });

  test("does not throw when auth differs but the two patterns are literally incompatible at some position", () => {
    expect(() =>
      createRouter([
        route({ method: "GET", path: "/api/v1/runs", auth: "required" }),
        route({ method: "GET", path: "/api/v1/steps", auth: "exempt" }),
      ]),
    ).not.toThrow();
  });

  test("does not flag a cross-auth overlap when only the method differs", () => {
    expect(() =>
      createRouter([
        route({
          method: "GET",
          path: "/api/v1/runs/:id",
          auth: "required",
        }),
        route({
          method: "POST",
          path: "/api/v1/runs/:id",
          auth: "exempt",
        }),
      ]),
    ).not.toThrow();
  });

  test("does not flag a cross-auth overlap when the segment counts differ", () => {
    expect(() =>
      createRouter([
        route({ method: "GET", path: "/api/v1/runs/:id", auth: "required" }),
        route({
          method: "GET",
          path: "/api/v1/runs/:id/steps",
          auth: "exempt",
        }),
      ]),
    ).not.toThrow();
  });

  test("finds a conflicting pair beyond the first candidate checked", () => {
    // (0,1): same auth -> no conflict. (0,2): different auth, and ":name"
    // (a param) is compatible with the literal "healthz" -> conflict. The
    // detector must not stop after the first (non-conflicting) pair it
    // examines for route 0.
    let thrown: unknown;
    try {
      createRouter([
        route({ method: "GET", path: "/healthz", auth: "exempt" }),
        route({ method: "GET", path: "/readyz", auth: "exempt" }),
        route({ method: "GET", path: "/:name", auth: "required" }),
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_ROUTE_CONFLICT");
    expect((thrown as M3LConsoleError).message).toContain("/healthz");
    expect((thrown as M3LConsoleError).message).toContain("/:name");
  });
});

describe("createRouter — captured params are a frozen, null-prototype record", () => {
  test("params has no inherited prototype and is frozen", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:id" }),
    ]);

    const result = router.lookup("GET", "/api/v1/runs/42");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(Object.getPrototypeOf(result.params)).toBeNull();
    expect(Object.isFrozen(result.params)).toBe(true);
  });

  test("an unmatched :param-free route still yields a frozen, null-prototype empty params object", () => {
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);

    const result = router.lookup("GET", "/api/v1/runs");

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.params).toEqual({});
    expect(Object.getPrototypeOf(result.params)).toBeNull();
    expect(Object.isFrozen(result.params)).toBe(true);
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
