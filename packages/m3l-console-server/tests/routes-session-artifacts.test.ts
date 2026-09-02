/**
 * Tests for `src/http/routes/session-artifacts.ts` — X7d's
 * `GET /api/v1/sessions/:id/steps/:stepId/artifact`.
 *
 * The handler is driven directly against `M3LRequestContext` fixtures, no
 * real socket, matching `tests/routes-runs.test.ts`'s established shape.
 *
 * The route itself is thin on purpose, and these tests pin exactly that: it
 * validates its two route params, delegates, and returns the value verbatim.
 * Every not-found decision belongs to the service — `tests/sessions-service.test.ts`
 * owns those — and the case below proving a service rejection propagates
 * UNCHANGED is what keeps the route from growing its own opinion about them.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createSessionArtifactRoutes } from "../src/http/routes/session-artifacts.js";
import type { M3LRoute } from "../src/http/router.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/** The one route this module registers, plus the reader it was built over. */
function buildRoute(read: () => Promise<unknown>): {
  readonly route: M3LRoute;
  readonly readStepArtifact: Mock<
    (sessionId: string, stepId: string) => Promise<unknown>
  >;
} {
  const readStepArtifact = vi.fn(read);
  const routes = createSessionArtifactRoutes({
    reader: { readStepArtifact },
  });
  const route = routes[0];
  if (route === undefined) throw new Error("no route was registered");
  return { route, readStepArtifact };
}

/** Builds a request context carrying `params`. */
function buildContext(
  params: Readonly<Record<string, string>>,
): M3LRequestContext {
  const base = createRequestContext({
    method: "GET",
    url: "/api/v1/sessions/session-1/steps/step-1/artifact",
    headers: {},
    signal: new AbortController().signal,
  });
  return {
    ...base,
    params,
    operator: { name: "ada", email: undefined },
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

describe("createSessionArtifactRoutes — route table shape", () => {
  test("registers one GET route at the step-artifact path, auth: 'required'", () => {
    const { route } = buildRoute(() => Promise.resolve({}));

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/sessions/:id/steps/:stepId/artifact");
    expect(route.auth).toBe("required");
  });
});

describe("GET /api/v1/sessions/:id/steps/:stepId/artifact", () => {
  test("returns 200 with the artifact's value, passing both route params through", async () => {
    const { route, readStepArtifact } = buildRoute(() =>
      Promise.resolve({ queues: ["a", "b"] }),
    );

    const response = await runRoute(
      route,
      buildContext({ id: "session-7", stepId: "step-3" }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ queues: ["a", "b"] });
    expect(readStepArtifact).toHaveBeenCalledWith("session-7", "step-3");
  });

  // INVARIANT: an inline artifact and a file-backed one must be
  // indistinguishable to a caller — the placement decision is the artifact
  // store's, driven by size, and a client that could tell them apart would
  // start depending on it. Mutation-tested: wrapping the value in an
  // envelope (`{ value }`) fails here.
  test("returns the value itself, with no envelope around it", async () => {
    const { route } = buildRoute(() =>
      Promise.resolve(["just", "an", "array"]),
    );

    const response = await runRoute(
      route,
      buildContext({ id: "session-1", stepId: "step-1" }),
    );

    expect(JSON.parse(response.body)).toEqual(["just", "an", "array"]);
  });

  test("serves a primitive artifact value unchanged", async () => {
    const { route } = buildRoute(() => Promise.resolve(42));

    const response = await runRoute(
      route,
      buildContext({ id: "session-1", stepId: "step-1" }),
    );

    expect(JSON.parse(response.body)).toBe(42);
  });

  test.each([
    ["id", { stepId: "step-1" }],
    ["stepId", { id: "session-1" }],
  ])(
    "returns 400 naming the missing ':%s' route parameter, without calling the reader",
    async (name, params) => {
      const { route, readStepArtifact } = buildRoute(() => Promise.resolve({}));

      const thrown = await captureThrown(() =>
        runRoute(route, buildContext(params)),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect((thrown as M3LConsoleError).message).toContain(`':${name}'`);
      expect(readStepArtifact).not.toHaveBeenCalled();
    },
  );

  // INVARIANT: the route owns NO not-found logic. Every 404 decision — and
  // in particular the choice to make "belongs to another session" and "does
  // not exist" indistinguishable — lives in the service, on one side of the
  // boundary. Mutation-tested: catching the rejection here and re-raising a
  // route-local error fails this.
  test.each([
    "ERR_CONSOLE_SESSION_NOT_FOUND",
    "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
  ] as const)("propagates the service's %s unchanged", async (code) => {
    const failure = new M3LConsoleError(code, "from the service");
    const { route } = buildRoute(() => Promise.reject(failure));

    const thrown = await captureThrown(() =>
      runRoute(route, buildContext({ id: "session-1", stepId: "step-1" })),
    );

    expect(thrown).toBe(failure);
  });
});
