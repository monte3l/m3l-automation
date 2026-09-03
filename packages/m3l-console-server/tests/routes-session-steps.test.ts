/**
 * Tests for `src/http/routes/session-steps.ts` — X11's session-steps
 * drill-down read: `GET /api/v1/sessions/:id/steps`.
 *
 * The handler is driven directly against `M3LRequestContext` fixtures, no
 * real socket, matching `tests/routes-session-artifacts.test.ts`'s
 * established shape.
 *
 * The route itself is thin on purpose, and these tests pin exactly that: it
 * validates its one route param, delegates to the reader, and returns the
 * result verbatim, with no envelope. Every not-found decision belongs to the
 * service — `tests/sessions-service-reads.test.ts` owns those — and the case
 * below proving a reader rejection propagates UNCHANGED is what keeps the
 * route from growing its own opinion about them.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createSessionStepsRoutes } from "../src/http/routes/session-steps.js";
import type { M3LRoute } from "../src/http/router.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/**
 * One fixture step-summary row, resembling `M3LSessionStepSummary`.
 * Optional fields with no value are OMITTED, not set to `undefined` — the
 * route serializes via `jsonResponse` -> `Core.safeJsonStringify`, which
 * turns an `undefined` property value into `null`, so a fixture literal
 * setting one to `undefined` would never round-trip equal to the parsed
 * response body. Mirrors `STEP_ROW`/`SESSION_ROW` in
 * `tests/routes-sessions.test.ts`.
 */
const STEP_1 = {
  id: "step-1",
  sessionId: "session-7",
  ordinal: 1,
  operation: "sqs-etl",
  parameters: { mode: "batch" },
  runId: "run-1",
  status: "success",
  hasResult: true,
  queuedAtMs: 1_000,
  startedAtMs: 1_100,
  endedAtMs: 1_200,
  outcome: "success",
};

const STEP_2 = {
  id: "step-2",
  sessionId: "session-7",
  ordinal: 2,
  operation: "s3-copy",
  parameters: { mode: "single" },
  status: "queued",
  hasResult: false,
  queuedAtMs: 2_000,
};

/** The one route this module registers, plus the reader it was built over. */
function buildRoute(list: () => readonly unknown[]): {
  readonly route: M3LRoute;
  readonly listStepsForSession: Mock<(sessionId: string) => readonly unknown[]>;
} {
  const listStepsForSession = vi.fn(list);
  const routes = createSessionStepsRoutes({
    reader: { listStepsForSession },
  });
  const route = routes[0];
  if (route === undefined) throw new Error("no route was registered");
  return { route, listStepsForSession };
}

/** Builds a request context carrying `params`. */
function buildContext(
  params: Readonly<Record<string, string>>,
): M3LRequestContext {
  const base = createRequestContext({
    method: "GET",
    url: "/api/v1/sessions/session-7/steps",
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

describe("createSessionStepsRoutes — route table shape", () => {
  test("registers one GET route at /api/v1/sessions/:id/steps, auth: 'required'", () => {
    const { route } = buildRoute(() => []);

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/sessions/:id/steps");
    expect(route.auth).toBe("required");
  });
});

describe("GET /api/v1/sessions/:id/steps", () => {
  test("returns 200 with the reader's array verbatim, no envelope", async () => {
    const { route, listStepsForSession } = buildRoute(() => [STEP_1, STEP_2]);

    const response = await runRoute(route, buildContext({ id: "session-7" }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([STEP_1, STEP_2]);
    expect(listStepsForSession).toHaveBeenCalledWith("session-7");
  });

  test("returns 200 with an empty array for a session with no steps", async () => {
    const { route } = buildRoute(() => []);

    const response = await runRoute(route, buildContext({ id: "session-7" }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  test("returns 400 naming the missing ':id' route parameter, without calling the reader", async () => {
    const { route, listStepsForSession } = buildRoute(() => []);

    const thrown = await captureThrown(() => runRoute(route, buildContext({})));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("':id'");
    expect(listStepsForSession).not.toHaveBeenCalled();
  });

  // INVARIANT: the route owns NO not-found logic. A session-not-found
  // decision belongs to the service, mirroring
  // `routes-session-artifacts.test.ts`'s own comment on the same boundary.
  // Mutation-tested: catching the throw here and re-raising a route-local
  // error fails this.
  test("propagates a reader-thrown ERR_CONSOLE_SESSION_NOT_FOUND unchanged", async () => {
    const failure = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      "no such session",
    );
    const { route } = buildRoute(() => {
      throw failure;
    });

    const thrown = await captureThrown(() =>
      runRoute(route, buildContext({ id: "session-7" })),
    );

    expect(thrown).toBe(failure);
  });
});
