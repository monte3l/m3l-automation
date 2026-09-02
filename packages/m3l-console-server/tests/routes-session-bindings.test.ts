/**
 * Tests for `src/http/routes/session-bindings.ts` — the X6 list route
 * (relocated here with the code it exercises) and X7d's
 * `POST /api/v1/sessions/:id/bindings`.
 *
 * Handlers are driven directly against `M3LRequestContext` fixtures, no real
 * socket, matching `tests/routes-runs.test.ts`'s established shape. Fixtures
 * are copied from `tests/routes-sessions.test.ts` rather than imported, this
 * package's convention (see `.claude/rules/tests.md`).
 *
 * The list-route cases below moved from that file UNCHANGED when the route
 * did — same assertions, same names — so the relocation is visible as a move
 * rather than a rewrite.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createSessionBindingRoutes } from "../src/http/routes/session-bindings.js";
import type { M3LRoute } from "../src/http/router.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/** One persisted binding row, matching `M3LSessionBindingRecord`'s field set. */
const BINDING_ROW = {
  id: "binding-1",
  sessionId: "session-1",
  reference: "step-1.output.Queues[0]",
  expectedType: "string",
  multiSelect: false,
  createdAtMs: 1_000,
};

/** A well-formed selection body. */
const VALID_BODY = {
  reference: "step-1.output.Queues[0]",
  expectedType: "string",
  multiSelect: false,
  parameterName: "queueUrl",
};

/** Builds the route table over recording reader/writer doubles. */
function buildRoutes(
  overrides: {
    readonly bindings?: readonly unknown[];
    readonly listThrows?: Error;
    readonly selectThrows?: Error;
    readonly selected?: unknown;
  } = {},
): {
  readonly routes: readonly M3LRoute[];
  readonly listBindingsForSession: Mock<
    (sessionId: string) => readonly unknown[]
  >;
  readonly selectBinding: Mock<
    (sessionId: string, binding: unknown) => Promise<unknown>
  >;
} {
  const listBindingsForSession = vi.fn((_sessionId: string) => {
    if (overrides.listThrows !== undefined) throw overrides.listThrows;
    return overrides.bindings ?? [];
  });
  const selectBinding = vi.fn((_sessionId: string, _binding: unknown) =>
    overrides.selectThrows === undefined
      ? Promise.resolve(overrides.selected ?? BINDING_ROW)
      : Promise.reject(overrides.selectThrows),
  );
  return {
    listBindingsForSession,
    selectBinding,
    routes: createSessionBindingRoutes({
      reader: { listBindingsForSession },
      writer: { selectBinding },
    }),
  };
}

/** Finds the registered route for `method`/`path`, failing loudly if absent. */
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

/** Builds a request context carrying `params` and an optional body. */
function buildContext(options: {
  readonly method?: string;
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}): M3LRequestContext {
  const base = createRequestContext({
    method: options.method ?? "GET",
    url: options.path,
    headers: {},
    signal: new AbortController().signal,
  });
  return {
    ...base,
    params: options.params ?? {},
    operator: { name: "ada", email: undefined },
    body: options.body,
  };
}

/** Runs the handler, narrowing away the stream arm — both routes are buffered. */
async function runRoute(
  route: M3LRoute,
  ctx: M3LRequestContext,
): Promise<M3LConsoleResponse> {
  const result = await route.handler(ctx);
  if (isStreamResponse(result)) {
    throw new Error("expected a buffered response, got a stream");
  }
  return result;
}

/** Captures a thrown value from an async call. */
async function captureThrown(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The `POST …/bindings` route, found once per test. */
function selectRoute(routes: readonly M3LRoute[]): M3LRoute {
  return findRoute(routes, "POST", "/api/v1/sessions/:id/bindings");
}

describe("createSessionBindingRoutes — route table shape", () => {
  test("registers the list and select routes, both auth: 'required'", () => {
    const { routes } = buildRoutes();

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`).sort(),
    ).toEqual([
      "GET /api/v1/sessions/:id/bindings",
      "POST /api/v1/sessions/:id/bindings",
    ]);
    for (const route of routes) {
      expect(route.auth).toBe("required");
    }
  });
});

describe("GET /api/v1/sessions/:id/bindings", () => {
  test("returns 200 with the bare binding row array from reader.listBindingsForSession", async () => {
    const { routes, listBindingsForSession } = buildRoutes({
      bindings: [BINDING_ROW],
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions/:id/bindings"),
      buildContext({
        path: "/api/v1/sessions/session-1/bindings",
        params: { id: "session-1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([BINDING_ROW]);
    expect(listBindingsForSession).toHaveBeenCalledWith("session-1");
  });

  test("returns 200 with an empty array for a session with no bindings", async () => {
    const { routes } = buildRoutes({ bindings: [] });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions/:id/bindings"),
      buildContext({
        path: "/api/v1/sessions/session-1/bindings",
        params: { id: "session-1" },
      }),
    );

    expect(JSON.parse(response.body)).toEqual([]);
  });

  test("propagates a thrown ERR_CONSOLE_SESSION_NOT_FOUND unchanged for an unknown id", async () => {
    const failure = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      "no such session",
    );
    const { routes } = buildRoutes({ listThrows: failure });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions/:id/bindings"),
        buildContext({
          path: "/api/v1/sessions/nope/bindings",
          params: { id: "nope" },
        }),
      ),
    );

    expect(thrown).toBe(failure);
  });
});

describe("POST /api/v1/sessions/:id/bindings", () => {
  test("returns 201 with the persisted record, passing the validated binding through", async () => {
    const { routes, selectBinding } = buildRoutes();

    const response = await runRoute(
      selectRoute(routes),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/bindings",
        params: { id: "session-1" },
        body: VALID_BODY,
      }),
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual(BINDING_ROW);
    expect(selectBinding).toHaveBeenCalledWith("session-1", VALID_BODY);
  });

  // INVARIANT: the response carries no resolved VALUE. The binding table has
  // no column for one, and putting arbitrary step output in an operator's
  // binding trail is what ADR-0070's display-vs-persist split forbids.
  // Mutation-tested: adding the resolved value to the response fails here.
  test("returns only the persisted record's own fields", async () => {
    const { routes } = buildRoutes();

    const response = await runRoute(
      selectRoute(routes),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/bindings",
        params: { id: "session-1" },
        body: VALID_BODY,
      }),
    );

    const record: unknown = JSON.parse(response.body);
    expect(Object.keys(record as Record<string, unknown>).sort()).toEqual([
      "createdAtMs",
      "expectedType",
      "id",
      "multiSelect",
      "reference",
      "sessionId",
    ]);
  });

  test.each([
    ["a non-object body", "not an object"],
    ["a null body", null],
    ["an array body", []],
  ])("rejects %s as ERR_CONSOLE_BAD_REQUEST", async (_label, body) => {
    const { routes, selectBinding } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        selectRoute(routes),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/bindings",
          params: { id: "session-1" },
          body,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(selectBinding).not.toHaveBeenCalled();
  });

  // INVARIANT: the SAME validator the inline `POST …/steps` path uses, so a
  // body one route rejects is rejected by the other. Mutation-tested:
  // relaxing any one of these in `readBindingEntry` fails both this and
  // `routes-sessions.test.ts`'s inline cases at once, which is the point of
  // there being one implementation.
  test.each([
    ["reference", { ...VALID_BODY, reference: "" }],
    ["reference", { ...VALID_BODY, reference: 42 }],
    ["expectedType", { ...VALID_BODY, expectedType: "date" }],
    ["multiSelect", { ...VALID_BODY, multiSelect: "no" }],
    ["parameterName", { ...VALID_BODY, parameterName: "" }],
  ])("rejects a bad '%s' field, naming it", async (field, body) => {
    const { routes, selectBinding } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        selectRoute(routes),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/bindings",
          params: { id: "session-1" },
          body,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain(field);
    expect(selectBinding).not.toHaveBeenCalled();
  });

  test("returns 400 naming the missing ':id' route parameter, without calling the writer", async () => {
    const { routes, selectBinding } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        selectRoute(routes),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions//bindings",
          body: VALID_BODY,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("':id'");
    expect(selectBinding).not.toHaveBeenCalled();
  });

  // INVARIANT: every reference decision belongs to the SERVICE — whether the
  // ordinal exists, whether that step has output, whether the value matches
  // the declared shape. The route validates the body's shape and nothing
  // more, so a later edit cannot grow a route-local opinion about references.
  test.each([
    "ERR_CONSOLE_SESSION_NOT_FOUND",
    "ERR_CONSOLE_SESSION_CLOSED",
    "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
  ] as const)("propagates the service's %s unchanged", async (code) => {
    const failure = new M3LConsoleError(code, "from the service");
    const { routes } = buildRoutes({ selectThrows: failure });

    const thrown = await captureThrown(() =>
      runRoute(
        selectRoute(routes),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/bindings",
          params: { id: "session-1" },
          body: VALID_BODY,
        }),
      ),
    );

    expect(thrown).toBe(failure);
  });
});
