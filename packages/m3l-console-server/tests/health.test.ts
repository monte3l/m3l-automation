/**
 * Tests for src/http/routes/health.ts — `createHealthRoutes` (ADR-0066:
 * health/readiness as GET queries). `src/http/routes/health.ts` does not
 * exist yet; this suite is RED until the implementation lands.
 *
 * Every case drives a returned route's `handler` directly against a plain
 * `M3LRequestContext` built via the real `createRequestContext` — no real
 * socket, no real `node:http` server.
 */
import { describe, expect, test } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { createDrainController } from "../src/lifecycle/drain.js";
import { createHealthRoutes } from "../src/http/routes/health.js";
import type { M3LRoute } from "../src/http/router.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/** Builds a bare GET request context against `path`, for driving a route handler directly. */
function buildContext(path: string): M3LRequestContext {
  return createRequestContext({
    method: "GET",
    url: path,
    headers: {},
    signal: new AbortController().signal,
  });
}

/** Finds the registered route for `method`/`path`, failing loudly (not silently `undefined`) if absent. */
function findRoute(
  routes: readonly M3LRoute[],
  method: string,
  path: string,
): M3LRoute {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) {
    throw new Error(`no route registered for ${method} ${path}`);
  }
  return route;
}

/**
 * Runs `route`'s handler against a bare GET context for `path`. Every health
 * route is buffered, never a stream, so this narrows `M3LRoute["handler"]`'s
 * widened `M3LConsoleResult` back down to `M3LConsoleResponse` rather than
 * loosening the helper's own return type — a stream result here would be a
 * genuine regression in `src/http/routes/health.ts`, not something this test
 * suite should silently tolerate.
 */
async function runRoute(
  route: M3LRoute,
  path: string,
): Promise<M3LConsoleResponse> {
  const result = await route.handler(buildContext(path));
  if (isStreamResponse(result)) {
    throw new Error(
      `expected a buffered response from ${route.method} ${route.path}, got a stream`,
    );
  }
  return result;
}

/** Parses a `M3LConsoleResponse` body as JSON, typed loosely for field-presence checks. */
function parseBody(response: M3LConsoleResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("createHealthRoutes — route table shape", () => {
  test("registers exactly two routes: GET /health and GET /ready", () => {
    const drain = createDrainController({ timeoutMs: 1_000 });

    const routes = createHealthRoutes({ drain, startedAt: 0 });

    expect(routes).toHaveLength(2);
    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`).sort(),
    ).toEqual(["GET /health", "GET /ready"]);
  });

  test("both routes declare auth: 'exempt' — a liveness/readiness probe must work before an operator session exists", () => {
    const drain = createDrainController({ timeoutMs: 1_000 });

    const routes = createHealthRoutes({ drain, startedAt: 0 });

    // Asserted explicitly per-route, not just "every route" over an
    // arbitrary-length array: if either route were "required", an
    // orchestrator's probe would 401 and it would kill a healthy process.
    expect(findRoute(routes, "GET", "/health").auth).toBe("exempt");
    expect(findRoute(routes, "GET", "/ready").auth).toBe("exempt");
  });
});

describe("createHealthRoutes — GET /health (liveness)", () => {
  test("returns 200 with status 'ok' and a numeric uptimeMs derived from now() - startedAt", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({
      drain,
      startedAt: 1_000,
      now: () => 1_500,
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/health"),
      "/health",
    );

    expect(response.status).toBe(200);
    const body = parseBody(response);
    expect(body["status"]).toBe("ok");
    expect(body["uptimeMs"]).toBe(500);
  });

  test("stays 200 'ok' EVEN WHILE DRAINING — liveness must stay green so nothing kills the process mid-drain", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({ drain, startedAt: 0, now: () => 10 });

    // Both arms of "even while draining" must be reachable from this test's
    // own setup: begin a real drain (never resolved/awaited here — there is
    // nothing tracked, so it would settle on its own, but the assertion
    // below only needs the synchronous "draining" state `drain()` sets
    // before it returns).
    void drain.drain();
    expect(drain.state).toBe("draining");

    const response = await runRoute(
      findRoute(routes, "GET", "/health"),
      "/health",
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["status"]).toBe("ok");
  });
});

describe("createHealthRoutes — GET /ready (readiness)", () => {
  test("returns 200 with status 'ready' while the drain controller is 'serving'", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({ drain, startedAt: 0 });
    expect(drain.state).toBe("serving");

    const response = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["status"]).toBe("ready");
  });

  test("returns a plain 503 jsonResponse with status 'draining' once a drain has begun — never a thrown ERR_CONSOLE_UNAVAILABLE, since readiness is a normal outcome, not an error", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({ drain, startedAt: 0 });

    void drain.drain();
    expect(drain.state).toBe("draining");

    // Must resolve to a response value, not reject/throw — a readiness
    // signal is a status document, not an error envelope.
    const response = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    expect(response.status).toBe(503);
    expect(parseBody(response)["status"]).toBe("draining");
  });
});

// =============================================================================
// X3 console-persistence (issue #551, ADR-0069) — readiness reports store
// health via a structural probe declared inside `http/routes/health.ts`
// (`M3LReadinessProbe`, `{ readonly isOpen: boolean }`), never through an
// import of `M3LConsoleStoreHandle` — an `http -> store` ESLint zone edge
// must never exist. `HealthRouteOptions` does not yet accept a `store` field,
// so every case below is RED until it does.
// =============================================================================

describe("createHealthRoutes — GET /ready reports store health via a structural probe", () => {
  test("returns 503 { status: 'unavailable' } when the store probe reports isOpen: false — not 'degraded', and discloses no schemaVersion", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({
      drain,
      startedAt: 0,
      store: { isOpen: false },
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    expect(response.status).toBe(503);
    const body = parseBody(response);
    expect(body["status"]).toBe("unavailable");
    expect(body).not.toHaveProperty("schemaVersion");
  });

  test("still returns 200 'ready' when the store probe reports isOpen: true and the drain is serving", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({
      drain,
      startedAt: 0,
      store: { isOpen: true },
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["status"]).toBe("ready");
  });
});

describe("createHealthRoutes — GET /health stays 200 unconditionally, even with a closed store", () => {
  test("returns 200 'ok' when the store probe reports isOpen: false — an orchestrator that sees liveness fail kills the process mid-drain", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({
      drain,
      startedAt: 0,
      store: { isOpen: false },
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/health"),
      "/health",
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["status"]).toBe("ok");
  });
});

describe("createHealthRoutes — existing draining behaviour is unchanged by the store probe", () => {
  test("GET /ready still returns 503 'draining' while draining, even when the store probe reports isOpen: true", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({
      drain,
      startedAt: 0,
      store: { isOpen: true },
    });

    void drain.drain();
    expect(drain.state).toBe("draining");

    const response = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    expect(response.status).toBe(503);
    expect(parseBody(response)["status"]).toBe("draining");
  });
});

describe("createHealthRoutes — no posture disclosure on a pre-auth surface", () => {
  test("neither /health's nor /ready's serialized body carries the operator name, email, host, port, or a version string", async () => {
    const drain = createDrainController({ timeoutMs: 1_000 });
    const routes = createHealthRoutes({ drain, startedAt: 0 });

    const healthResponse = await runRoute(
      findRoute(routes, "GET", "/health"),
      "/health",
    );
    const readyResponse = await runRoute(
      findRoute(routes, "GET", "/ready"),
      "/ready",
    );

    for (const response of [healthResponse, readyResponse]) {
      expect(response.body).not.toMatch(/operator/i);
      expect(response.body).not.toMatch(/email/i);
      expect(response.body).not.toMatch(/host/i);
      expect(response.body).not.toMatch(/port/i);
      expect(response.body).not.toMatch(/version/i);
    }
  });
});
