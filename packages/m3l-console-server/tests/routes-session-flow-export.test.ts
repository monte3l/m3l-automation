/**
 * Tests for `src/http/routes/session-flow-export.ts` —
 * `POST /api/v1/sessions/:id/flow-export` (X13 session-flow-export module,
 * issue #561, PR 5/6, Round B).
 *
 * RED: `../src/http/routes/session-flow-export.ts` does not exist yet —
 * every import from it below is expected to fail to resolve until the
 * implementer lands it.
 *
 * Its own file rather than an addition to `tests/routes-sessions.test.ts`:
 * that file sits at 42,018 of ADR-0072's 60,000-byte TEST_CEILING_BYTES cap,
 * leaving thin headroom for a new route's full case matrix, and
 * `tests/routes-session-bindings.test.ts` is the established precedent for a
 * single-resource write route living in its own file (moved out of
 * `sessions.ts` for the identical file-budget reason). Handlers are driven
 * directly against `M3LRequestContext` fixtures, no real socket, matching
 * both siblings' established shape. Fixtures are copied rather than
 * imported, per `.claude/rules/tests.md`.
 *
 * **Resolved convention question (Task 6):** whether an absent
 * `description` reaches the writer as an omitted key or as
 * `description: undefined`. Verified directly against
 * `src/sessions/flow-export.ts`'s `buildSessionFlowExport`, which builds its
 * document via `...(request.description !== undefined && { description:
 * request.description })` — a conditional spread that OMITS the key
 * entirely rather than setting it to `undefined`. This file's "both absent"
 * case asserts the same omit-the-key shape for the route's own call into
 * `writer.exportFlow`, for consistency with that established convention.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createSessionFlowExportRoutes } from "../src/http/routes/session-flow-export.js";
import type { M3LRoute } from "../src/http/router.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/** One successful export result, matching `M3LSessionFlowWriteResult`'s field set. */
const FLOW_RESULT = {
  name: "dlq-reconcile",
  yaml: "name: dlq-reconcile\nsteps: []\n",
  steps: [],
  decisionsDropped: 0,
  path: "/data/config/flows/dlq-reconcile.yaml",
};

/** A well-formed request body, every field present. */
const VALID_BODY = {
  name: "dlq-reconcile",
  description: "a description",
  overwrite: true,
};

/** Builds the route table over a recording writer double. */
function buildRoutes(
  overrides: {
    readonly exportThrows?: Error;
    readonly exported?: unknown;
  } = {},
): {
  readonly routes: readonly M3LRoute[];
  readonly exportFlow: Mock<
    (sessionId: string, request: unknown) => Promise<unknown>
  >;
} {
  const exportFlow = vi.fn((_sessionId: string, _request: unknown) =>
    overrides.exportThrows === undefined
      ? Promise.resolve(overrides.exported ?? FLOW_RESULT)
      : Promise.reject(overrides.exportThrows),
  );
  return {
    exportFlow,
    routes: createSessionFlowExportRoutes({ writer: { exportFlow } }),
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
    method: options.method ?? "POST",
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

/** Runs the handler, narrowing away the stream arm — this route is buffered. */
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

/** The `POST …/flow-export` route, found once per test. */
function exportRoute(routes: readonly M3LRoute[]): M3LRoute {
  return findRoute(routes, "POST", "/api/v1/sessions/:id/flow-export");
}

describe("createSessionFlowExportRoutes — route table shape", () => {
  test("registers exactly one route, auth: 'required'", () => {
    const { routes } = buildRoutes();

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`),
    ).toEqual(["POST /api/v1/sessions/:id/flow-export"]);
    for (const route of routes) {
      expect(route.auth).toBe("required");
    }
  });
});

describe("POST /api/v1/sessions/:id/flow-export", () => {
  test("returns 201 with the writer's return value verbatim", async () => {
    const { routes, exportFlow } = buildRoutes();

    const response = await runRoute(
      exportRoute(routes),
      buildContext({
        path: "/api/v1/sessions/session-1/flow-export",
        params: { id: "session-1" },
        body: VALID_BODY,
      }),
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual(FLOW_RESULT);
    expect(exportFlow).toHaveBeenCalledWith("session-1", {
      name: "dlq-reconcile",
      description: "a description",
      overwrite: true,
    });
  });

  test("returns 400 naming the missing ':id' route parameter, without calling the writer", async () => {
    const { routes, exportFlow } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        exportRoute(routes),
        buildContext({
          path: "/api/v1/sessions//flow-export",
          body: VALID_BODY,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("':id'");
    expect(exportFlow).not.toHaveBeenCalled();
  });

  test("rejects a body missing 'name', naming the field, without calling the writer", async () => {
    const { routes, exportFlow } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        exportRoute(routes),
        buildContext({
          path: "/api/v1/sessions/session-1/flow-export",
          params: { id: "session-1" },
          body: { description: "no name here" },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("name");
    expect(exportFlow).not.toHaveBeenCalled();
  });

  test.each([
    ["a non-object body", "not an object"],
    ["a null body", null],
    ["an array body", []],
  ])("rejects %s as ERR_CONSOLE_BAD_REQUEST", async (_label, body) => {
    const { routes, exportFlow } = buildRoutes();

    const thrown = await captureThrown(() =>
      runRoute(
        exportRoute(routes),
        buildContext({
          path: "/api/v1/sessions/session-1/flow-export",
          params: { id: "session-1" },
          body,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(exportFlow).not.toHaveBeenCalled();
  });

  // See this file's own header for why an omitted key, not `description:
  // undefined`, is the asserted shape.
  test("description/overwrite both absent: the writer receives overwrite: false and no description key", async () => {
    const { routes, exportFlow } = buildRoutes();

    await runRoute(
      exportRoute(routes),
      buildContext({
        path: "/api/v1/sessions/session-1/flow-export",
        params: { id: "session-1" },
        body: { name: "dlq-reconcile" },
      }),
    );

    expect(exportFlow).toHaveBeenCalledTimes(1);
    const [, request] = exportFlow.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(request["overwrite"]).toBe(false);
    expect(Object.hasOwn(request, "description")).toBe(false);
  });

  // INVARIANT: every reference/name/collision decision belongs to the
  // WRITER, propagated unchanged — the route validates the body's shape and
  // nothing about the session or the target file. Mirrors
  // `routes-session-bindings.test.ts`'s own equivalent case.
  test.each([
    "ERR_CONSOLE_SESSION_NOT_FOUND",
    "ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY",
    "ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET",
    "ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS",
  ] as const)("propagates the writer's %s unchanged", async (code) => {
    const failure = new M3LConsoleError(code, "from the writer");
    const { routes } = buildRoutes({ exportThrows: failure });

    const thrown = await captureThrown(() =>
      runRoute(
        exportRoute(routes),
        buildContext({
          path: "/api/v1/sessions/session-1/flow-export",
          params: { id: "session-1" },
          body: VALID_BODY,
        }),
      ),
    );

    expect(thrown).toBe(failure);
  });
});
