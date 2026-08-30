/**
 * Tests for src/http/routes/built-in.ts — `toRunsRouteOptions` and
 * `createBuiltInRoutes`.
 *
 * `main.test.ts:590` already pins that `runtime.router` and the live
 * dispatch router are distinct objects, but nothing pins the invariant this
 * module's headline TSDoc actually promises: a caller-supplied route can
 * never shadow a built-in one of the same method+path, because built-in
 * routes are always merged AHEAD of `options.routes`. This file drives
 * `createBuiltInRoutes` directly (no `createConsoleRuntime`, no
 * `createRouter` — the latter would reject a same-method/path duplicate as
 * `ERR_CONSOLE_ROUTE_CONFLICT` before the ordering could even be observed)
 * to pin that ordering, plus `toRunsRouteOptions`'s four presence/absence
 * arms.
 */
import { describe, expect, test } from "vitest";

import { createDrainController } from "../src/lifecycle/drain.js";
import {
  adaptSessionService,
  createBuiltInRoutes,
  toRunsRouteOptions,
  toSessionsRouteOptions,
} from "../src/http/routes/built-in.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type {
  M3LRunLauncherPort,
  M3LRunReaderPort,
} from "../src/http/routes/runs.js";
import type { M3LRunStreamRegistryPort } from "../src/http/routes/run-stream.js";
import type {
  SessionRouteReaderPort,
  SessionRouteWriterPort,
} from "../src/http/routes/sessions.js";
import type { M3LRoute } from "../src/http/router.js";
import { createEventStreamHub } from "../src/stream/event-stream.js";

/** A fixture run-launch handle, matching `M3LRunLauncherPort.launch`'s return shape. */
const FIXTURE_LAUNCH_HANDLE = {
  id: "run-1",
  scriptName: "sqs-etl",
  status: "running" as const,
  dryRun: false,
  executionMode: "spawn",
};

/** A minimal `M3LRunLauncherPort` fixture — never invoked by these tests. */
const fakeOrchestrator: M3LRunLauncherPort = {
  launch: () => FIXTURE_LAUNCH_HANDLE,
};

/**
 * A minimal fixture conforming to BOTH `M3LRunReaderPort` (the REST routes)
 * and `M3LRunStreamRegistryPort` (the stream route) — mirroring
 * `RunsRouteOptions.registry`'s own doc comment. Never invoked by these
 * tests; only its identity and its structural shape matter here.
 */
const fakeRegistry: M3LRunReaderPort & M3LRunStreamRegistryPort = {
  list: () => [],
  get: () => undefined,
};

/** Builds a bare drain controller for `createBuiltInRoutes`'s required `drain` field. */
function buildDrain() {
  return createDrainController({ timeoutMs: 15_000 });
}

/** The four run-governor routes `createBuiltInRoutes` must add when `options.runs` is supplied. */
const RUN_ROUTE_SIGNATURES: readonly { method: string; path: string }[] = [
  { method: "POST", path: "/api/v1/runs" },
  { method: "GET", path: "/api/v1/runs" },
  { method: "GET", path: "/api/v1/runs/:id" },
  { method: "GET", path: "/api/v1/runs/:id/stream" },
];

/**
 * A minimal fixture conforming to BOTH `SessionRouteReaderPort` and
 * `SessionRouteWriterPort` — mirroring `SessionRouteOptions`'s own doc
 * comment (`main.ts` passes the real `M3LSessionService`, which conforms to
 * both structurally). Never invoked by these tests; only its identity and
 * its structural shape matter here.
 */
const fakeSessionService: SessionRouteReaderPort & SessionRouteWriterPort = {
  getSession: () => undefined,
  listSessions: () => [],
  createSession: () => ({
    id: "session-1",
    operator: "alice",
    correlationId: "corr-1",
    status: "open",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }),
  closeSession: () => true,
  reopenSession: () => true,
  addStep: () => Promise.resolve({ step: { id: "step-1" } }),
  raiseDecision: () => ({ id: "decision-1" }),
  answerDecision: () => true,
  listBindingsForSession: () => [],
};

/** The nine session-module routes `createBuiltInRoutes` must add when `options.sessions` is supplied. */
const SESSION_ROUTE_SIGNATURES: readonly { method: string; path: string }[] = [
  { method: "POST", path: "/api/v1/sessions" },
  { method: "GET", path: "/api/v1/sessions" },
  { method: "GET", path: "/api/v1/sessions/:id" },
  { method: "POST", path: "/api/v1/sessions/:id/steps" },
  { method: "POST", path: "/api/v1/sessions/:id/steps/:stepId/decision" },
  { method: "POST", path: "/api/v1/sessions/:id/decisions/:decisionId" },
  { method: "POST", path: "/api/v1/sessions/:id/close" },
  { method: "POST", path: "/api/v1/sessions/:id/reopen" },
  { method: "GET", path: "/api/v1/sessions/:id/bindings" },
];

describe("toRunsRouteOptions", () => {
  test("both registry and subsystem present builds RunsRouteOptions wired from their sources", () => {
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });
    const subsystem = { orchestrator: fakeOrchestrator, eventHub: hub };

    const result = toRunsRouteOptions(fakeRegistry, subsystem);

    expect(result).toBeDefined();
    expect(result?.orchestrator).toBe(subsystem.orchestrator);
    expect(result?.registry).toBe(fakeRegistry);
    expect(result?.hub).toBe(hub);
  });

  test("registry present, subsystem undefined returns undefined", () => {
    expect(toRunsRouteOptions(fakeRegistry, undefined)).toBeUndefined();
  });

  test("subsystem present, registry undefined returns undefined", () => {
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });
    const subsystem = { orchestrator: fakeOrchestrator, eventHub: hub };

    expect(toRunsRouteOptions(undefined, subsystem)).toBeUndefined();
  });

  test("both registry and subsystem undefined returns undefined", () => {
    expect(toRunsRouteOptions(undefined, undefined)).toBeUndefined();
  });
});

describe("toSessionsRouteOptions", () => {
  test("a supplied subsystem shape builds SessionRouteOptions with both reader and writer wired to the same service object", () => {
    const result = toSessionsRouteOptions({ service: fakeSessionService });

    expect(result).toBeDefined();
    expect(result?.reader).toBe(fakeSessionService);
    expect(result?.writer).toBe(fakeSessionService);
  });

  test("undefined subsystem returns undefined", () => {
    expect(toSessionsRouteOptions(undefined)).toBeUndefined();
  });
});

describe("adaptSessionService", () => {
  test("a service whose createSession returns an 'open' record is passed through with the same fields", () => {
    const record = {
      id: "session-1",
      operator: "alice",
      correlationId: "corr-1",
      status: "open" as const,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    const service = {
      ...fakeSessionService,
      createSession: () => record,
    };

    const adapted = adaptSessionService(service);
    const result = adapted.createSession("alice", "corr-1");

    expect(result).toEqual(record);
  });

  // `sessions/service.ts` documents `createSession` as always returning an
  // "open" record on success; `status: "closed"` here simulates the
  // theoretically-impossible case the adapter still defends against.
  test("a service whose createSession returns a 'closed' record throws ERR_CONSOLE_INTERNAL", () => {
    const service = {
      ...fakeSessionService,
      createSession: () => ({
        id: "session-1",
        operator: "alice",
        correlationId: "corr-1",
        status: "closed" as const,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
    };

    const adapted = adaptSessionService(service);

    expect(() => adapted.createSession("alice", "corr-1")).toThrowError(
      M3LConsoleError,
    );
    let thrown: unknown;
    try {
      adapted.createSession("alice", "corr-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});

describe("createBuiltInRoutes — without options.runs", () => {
  test("returns the health routes plus the caller's routes, with no run routes", () => {
    const callerRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/custom",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "custom" }),
    };

    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [callerRoute],
    });

    const paths = routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual(["GET /health", "GET /ready", "GET /api/v1/custom"]);
    expect(routes.some((route) => route.path.startsWith("/api/v1/runs"))).toBe(
      false,
    );
    expect(routes.at(-1)).toBe(callerRoute);
  });
});

describe("createBuiltInRoutes — with options.runs", () => {
  test("additionally includes every run-governor route", () => {
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });

    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [],
      runs: {
        orchestrator: fakeOrchestrator,
        registry: fakeRegistry,
        hub,
      },
    });

    for (const signature of RUN_ROUTE_SIGNATURES) {
      const match = routes.find(
        (route) =>
          route.method === signature.method && route.path === signature.path,
      );
      expect(
        match,
        `expected a registered route for ${signature.method} ${signature.path}`,
      ).toBeDefined();
      expect(match?.auth).toBe("required");
    }
  });
});

describe("createBuiltInRoutes — without options.sessions", () => {
  test("returns no session routes — there is no 'registered but always 404' middle state", () => {
    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [],
    });

    expect(
      routes.some((route) => route.path.startsWith("/api/v1/sessions")),
    ).toBe(false);
  });
});

describe("createBuiltInRoutes — with options.sessions", () => {
  test("additionally includes every session-module route", () => {
    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [],
      sessions: { reader: fakeSessionService, writer: fakeSessionService },
    });

    for (const signature of SESSION_ROUTE_SIGNATURES) {
      const match = routes.find(
        (route) =>
          route.method === signature.method && route.path === signature.path,
      );
      expect(
        match,
        `expected a registered route for ${signature.method} ${signature.path}`,
      ).toBeDefined();
      expect(match?.auth).toBe("required");
    }
  });

  test("session routes are positioned AFTER run routes and BEFORE caller routes (health, runs, sessions, caller)", () => {
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });
    const callerRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/custom",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "custom" }),
    };

    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [callerRoute],
      runs: { orchestrator: fakeOrchestrator, registry: fakeRegistry, hub },
      sessions: { reader: fakeSessionService, writer: fakeSessionService },
    });

    const healthIndex = routes.findIndex((route) => route.path === "/health");
    const firstRunIndex = routes.findIndex((route) =>
      route.path.startsWith("/api/v1/runs"),
    );
    const firstSessionIndex = routes.findIndex((route) =>
      route.path.startsWith("/api/v1/sessions"),
    );
    const callerIndex = routes.indexOf(callerRoute);

    expect(healthIndex).toBeGreaterThanOrEqual(0);
    expect(firstRunIndex).toBeGreaterThan(healthIndex);
    expect(firstSessionIndex).toBeGreaterThan(firstRunIndex);
    expect(callerIndex).toBeGreaterThan(firstSessionIndex);
  });
});

describe("createBuiltInRoutes — built-in routes always win over a colliding caller route", () => {
  test("a caller route sharing a built-in route's method+path is appended AFTER it, never before", () => {
    // This route deliberately collides with the built-in `GET /health` route
    // on both method and path. `createBuiltInRoutes` itself never rejects
    // the collision (only `createRouter` would, with
    // `ERR_CONSOLE_ROUTE_CONFLICT`) — so both entries coexist in the
    // returned array, and only their RELATIVE ORDER decides which one a
    // first-match-wins router dispatches to.
    const collidingCallerRoute: M3LRoute = {
      method: "GET",
      path: "/health",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "shadow attempt" }),
    };

    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [collidingCallerRoute],
    });

    const healthIndices = routes
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.method === "GET" && route.path === "/health")
      .map(({ index }) => index);

    expect(healthIndices).toHaveLength(2);
    const [builtInIndex, callerIndex] = healthIndices;
    expect(builtInIndex).toBeDefined();
    expect(callerIndex).toBeDefined();

    // Identity, not just position: the FIRST `GET /health` entry is the
    // built-in one (never the caller's own object), and the caller's route
    // object is present but strictly later in the array.
    expect(routes[builtInIndex as number]).not.toBe(collidingCallerRoute);
    expect(routes[callerIndex as number]).toBe(collidingCallerRoute);
    expect(builtInIndex as number).toBeLessThan(callerIndex as number);
  });

  test("a caller route colliding with a run-governor route is also appended AFTER it", () => {
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });
    const collidingCallerRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/runs",
      auth: "exempt",
      handler: () => ({ status: 200, headers: {}, body: "shadow attempt" }),
    };

    const routes = createBuiltInRoutes({
      drain: buildDrain(),
      startedAt: Date.now(),
      routes: [collidingCallerRoute],
      runs: {
        orchestrator: fakeOrchestrator,
        registry: fakeRegistry,
        hub,
      },
    });

    const matchingIndices = routes
      .map((route, index) => ({ route, index }))
      .filter(
        ({ route }) => route.method === "GET" && route.path === "/api/v1/runs",
      )
      .map(({ index }) => index);

    expect(matchingIndices).toHaveLength(2);
    const [builtInIndex, callerIndex] = matchingIndices;
    expect(routes[builtInIndex as number]).not.toBe(collidingCallerRoute);
    expect(routes[callerIndex as number]).toBe(collidingCallerRoute);
    expect(builtInIndex as number).toBeLessThan(callerIndex as number);
  });
});
