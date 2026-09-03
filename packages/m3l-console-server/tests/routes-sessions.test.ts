/**
 * Tests for src/http/routes/sessions.ts — `createSessionRoutes` (X6
 * workbench-sessions, slice 4 Part B round 2, issue #554).
 * `src/http/routes/sessions.ts` does not exist yet; this suite is RED until
 * the implementation lands.
 *
 * DECISIONS THIS SUITE BAKES IN (confirm with the hub before GREEN if a
 * different shape is preferred):
 *
 * 1. `createSessionRoutes(options)` takes `{ reader, writer }`, two narrow
 *    LOCAL structural ports (declared inside `http/routes/sessions.ts`,
 *    never imported from `sessions/` or `store/` — zone rules forbid
 *    `http -> sessions`/`http -> store`, even type-only), mirroring
 *    `runs.ts`'s own `{ orchestrator, registry }` dual-collaborator
 *    convention. `reader` covers `getSession`/`listSessions`; `writer`
 *    covers `createSession`/`closeSession`/`addStep`/`raiseDecision`/
 *    `answerDecision` — the real `M3LSessionService` (verified against
 *    `sessions/service.ts`) satisfies both structurally at the `main.ts`
 *    wiring site (a later round, not touched here).
 * 2. `GET /api/v1/sessions` responds with a bare JSON array (no envelope);
 *    every success response in this module is `jsonResponse(status, <raw
 *    result>)`.
 * 3. `http/routes/sessions.ts` declares AND EXPORTS its own accepted
 *    `?status=` vocabulary as `SESSION_STATUS_VALUES` — `store/
 *    sessions-repository-types.ts`'s `M3LSessionStatus` is a type alias with
 *    no runtime array to drift-guard against (unlike `runs.ts`'s
 *    `RUN_STATUSES`), so this suite instead pins the exact literal list.
 * 4. `answerDecision(id, answer)` takes only the decision id — verified
 *    against the real `sessions/service.ts`, which does NOT take a session
 *    id for this call. `POST /api/v1/sessions/:id/decisions/:decisionId`'s
 *    `:id` route param is therefore unused by the handler; only `:decisionId`
 *    reaches `writer.answerDecision`.
 * 5. `raiseDecision` is synchronous on the real service (not `Promise`
 *    -returning); `addStep` is the one write method the handler must
 *    `await`.
 *
 * Every case drives a returned route's `handler` directly against a plain
 * `M3LRequestContext`-shaped fixture — no real socket, matching
 * `tests/routes-runs.test.ts`'s established pattern.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Mock } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import type { M3LRoute } from "../src/http/router.js";
import {
  createSessionRoutes,
  SESSION_STATUS_VALUES,
} from "../src/http/routes/sessions.js";
import { isStreamResponse } from "../src/http/stream-response.js";
import type { M3LSessionStatus } from "../src/store/sessions-repository-types.js";

/**
 * One fixture session row. `status` is pinned to `"open"` — the only status
 * `createSession` ever returns (mirrors `M3LSessionRouteRecord`) — since no
 * fixture in this file ever needs a `"closed"` row; a status other than
 * `"open"` is only ever exercised as a bare `?status=` query string, not as
 * a row shape.
 */
interface FakeSessionRow {
  readonly id: string;
  readonly operator: string;
  readonly correlationId: string;
  readonly status: "open";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** One fixture session step row. */
interface FakeStepRow {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly operation: string;
}

/** One fixture step-summary row, resembling `M3LSessionStepSummary` (no `resultRef`, a `hasResult` boolean instead). */
interface FakeStepSummaryRow {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly operation: string;
  readonly hasResult: boolean;
}

/** One fixture run handle, mirroring `M3LSessionRunHandle`'s field set. */
interface FakeRunHandle {
  readonly id: string;
  readonly status: "queued" | "running";
}

/** One fixture `addStep` result, mirroring `M3LSessionAddStepResult`. */
interface FakeAddStepResult {
  readonly step: FakeStepRow;
  readonly handle: FakeRunHandle;
}

/** One fixture decision row. */
interface FakeDecisionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly stepId: string;
  readonly prompt: string;
  readonly status: "pending" | "answered";
}

/** One fixture binding row, mirroring `M3LSessionBindingRecord`'s field set. */
interface FakeBindingRow {
  readonly id: string;
  readonly sessionId: string;
  readonly reference: string;
  readonly expectedType: "string" | "number" | "boolean" | "object";
  readonly multiSelect: boolean;
  readonly createdAtMs: number;
}

/** One well-shaped `addStep` input binding, as the route would build it. */
interface FakeAddStepBinding {
  readonly reference: string;
  readonly expectedType: "string" | "number" | "boolean" | "object";
  readonly multiSelect: boolean;
  readonly parameterName: string;
}

/** One well-shaped `addStep` input, as the route would build it. */
interface FakeAddStepInput {
  readonly operation: string;
  readonly bindings: readonly FakeAddStepBinding[];
  readonly confirmed: boolean;
  readonly dryRun: boolean;
  readonly operator: string;
  readonly correlationId: string;
}

/** The local reader port `createSessionRoutes` depends on. */
interface FakeReader {
  getSession(id: string): FakeSessionRow | undefined;
  listSessions(query: {
    readonly status?: "open" | "closed";
    readonly operator?: string;
    readonly limit: number;
  }): readonly FakeSessionRow[];
  listBindingsForSession(sessionId: string): readonly FakeBindingRow[];
  readStepArtifact(sessionId: string, stepId: string): Promise<unknown>;
  listDecisionsForSession(sessionId: string): readonly FakeDecisionRow[];
  listStepsForSession(sessionId: string): readonly FakeStepSummaryRow[];
}

/** The local writer port `createSessionRoutes` depends on. */
interface FakeWriter {
  selectBinding(sessionId: string, binding: unknown): Promise<unknown>;
  createSession(operator: string, correlationId: string): FakeSessionRow;
  closeSession(id: string): boolean;
  reopenSession(id: string): boolean;
  addStep(
    sessionId: string,
    input: FakeAddStepInput,
  ): Promise<FakeAddStepResult>;
  raiseDecision(
    sessionId: string,
    stepId: string,
    prompt: string,
    options?: unknown,
  ): FakeDecisionRow;
  answerDecision(id: string, answer: unknown): boolean;
}

/**
 * Builds a bare fixture reader whose mocked members are `Omit`ted from
 * `FakeReader` and re-declared as their mock types (mirrors
 * `tests/routes-runs.test.ts`'s `buildRegistry`) so `expect(reader.get...)`
 * assertions read the mock's own type. Since 8.68.0
 * `@typescript-eslint/unbound-method` walks every intersection constituent and
 * reports if *any* declares the member with method shorthand, so an intact
 * `FakeReader` constituent would flag them all. The mock types are
 * parameterized because, with `FakeReader`'s signatures `Omit`ted away,
 * nothing else keeps the fixture assignable to the port it stands in for.
 */
function buildReader(
  overrides: {
    readonly get?: FakeSessionRow;
    readonly list?: readonly FakeSessionRow[];
    readonly bindings?: readonly FakeBindingRow[];
    readonly decisions?: readonly FakeDecisionRow[];
  } = {},
): Omit<
  FakeReader,
  | "getSession"
  | "listSessions"
  | "listBindingsForSession"
  | "listDecisionsForSession"
  | "listStepsForSession"
> & {
  getSession: Mock<FakeReader["getSession"]>;
  listSessions: Mock<FakeReader["listSessions"]>;
  listBindingsForSession: Mock<FakeReader["listBindingsForSession"]>;
  listDecisionsForSession: Mock<FakeReader["listDecisionsForSession"]>;
  listStepsForSession: Mock<FakeReader["listStepsForSession"]>;
} {
  return {
    // X7d's read lives on the SAME port but is served by its own route
    // module; these suites never drive it — `routes-session-artifacts.test.ts`
    // does.
    readStepArtifact: () => Promise.resolve(undefined),
    getSession: vi
      .fn<FakeReader["getSession"]>()
      .mockReturnValue(overrides.get),
    listSessions: vi
      .fn<FakeReader["listSessions"]>()
      .mockReturnValue(overrides.list ?? []),
    listBindingsForSession: vi
      .fn<FakeReader["listBindingsForSession"]>()
      .mockReturnValue(overrides.bindings ?? []),
    listDecisionsForSession: vi
      .fn<FakeReader["listDecisionsForSession"]>()
      .mockReturnValue(overrides.decisions ?? []),
    // X11's read lives on the SAME port but is served by its own route
    // module; these suites never drive it — `routes-session-steps.test.ts`
    // does.
    listStepsForSession: vi
      .fn<FakeReader["listStepsForSession"]>()
      .mockReturnValue([]),
  };
}

/** Builds a bare fixture writer, retyped the same way as {@link buildReader}. */
function buildWriter(
  overrides: {
    readonly created?: FakeSessionRow;
    readonly closeResult?: boolean;
    readonly reopenResult?: boolean;
    readonly addStepResult?: FakeAddStepResult;
    readonly decision?: FakeDecisionRow;
    readonly answerResult?: boolean;
  } = {},
): Omit<
  FakeWriter,
  | "createSession"
  | "closeSession"
  | "reopenSession"
  | "addStep"
  | "raiseDecision"
  | "answerDecision"
> & {
  createSession: Mock<FakeWriter["createSession"]>;
  closeSession: Mock<FakeWriter["closeSession"]>;
  reopenSession: Mock<FakeWriter["reopenSession"]>;
  addStep: Mock<FakeWriter["addStep"]>;
  raiseDecision: Mock<FakeWriter["raiseDecision"]>;
  answerDecision: Mock<FakeWriter["answerDecision"]>;
} {
  return {
    // X7d's write lives on the SAME port but is served by its own route
    // module; these suites never drive it — `routes-session-bindings.test.ts`
    // does.
    selectBinding: () => Promise.resolve({ id: "binding-1" }),
    createSession: vi
      .fn<FakeWriter["createSession"]>()
      .mockReturnValue(overrides.created ?? SESSION_ROW),
    closeSession: vi
      .fn<FakeWriter["closeSession"]>()
      .mockReturnValue(overrides.closeResult ?? true),
    reopenSession: vi
      .fn<FakeWriter["reopenSession"]>()
      .mockReturnValue(overrides.reopenResult ?? true),
    addStep: vi
      .fn<FakeWriter["addStep"]>()
      .mockResolvedValue(overrides.addStepResult ?? ADD_STEP_RESULT),
    raiseDecision: vi
      .fn<FakeWriter["raiseDecision"]>()
      .mockReturnValue(overrides.decision ?? DECISION),
    answerDecision: vi
      .fn<FakeWriter["answerDecision"]>()
      .mockReturnValue(overrides.answerResult ?? true),
  };
}

/** Options for {@link buildContext}. */
interface BuildContextOptions {
  readonly method?: string;
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly operatorName?: string;
}

/** Builds a request context for driving a route handler directly. */
function buildContext(options: BuildContextOptions): M3LRequestContext {
  const base = createRequestContext({
    method: options.method ?? "GET",
    url: options.path,
    headers: {},
    signal: new AbortController().signal,
  });
  return {
    ...base,
    params: options.params ?? {},
    operator:
      options.operatorName === undefined
        ? undefined
        : { name: options.operatorName, email: undefined },
    body: options.body,
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

/** Runs `route`'s handler against `ctx`, narrowing away the stream arm — every route here is buffered. */
async function runRoute(
  route: M3LRoute,
  ctx: M3LRequestContext,
): Promise<M3LConsoleResponse> {
  const result = await route.handler(ctx);
  if (isStreamResponse(result)) {
    throw new Error(
      `expected a buffered response from ${route.method} ${route.path}, got a stream`,
    );
  }
  return result;
}

/** Parses a response body as JSON, typed loosely for field-presence checks. */
function parseBody(response: M3LConsoleResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** Captures a thrown value from an async call without losing its type. */
async function captureThrown(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

const SESSION_ROW: FakeSessionRow = {
  id: "session-1",
  operator: "ada",
  correlationId: "corr-1",
  status: "open",
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
};

const STEP_ROW: FakeStepRow = {
  id: "step-1",
  sessionId: "session-1",
  ordinal: 1,
  operation: "sqs-etl",
};

const RUN_HANDLE: FakeRunHandle = { id: "run-1", status: "running" };

const ADD_STEP_RESULT: FakeAddStepResult = {
  step: STEP_ROW,
  handle: RUN_HANDLE,
};

const DECISION: FakeDecisionRow = {
  id: "decision-1",
  sessionId: "session-1",
  stepId: "step-1",
  prompt: "pick a queue",
  status: "pending",
};

const VALID_BINDING: FakeAddStepBinding = {
  reference: "step-1.output.Queues[0]",
  expectedType: "string",
  multiSelect: false,
  parameterName: "queueName",
};

describe("createSessionRoutes — route table shape", () => {
  test("registers all 9 session routes, all auth: 'required'", () => {
    const routes = createSessionRoutes({
      reader: buildReader(),
      writer: buildWriter(),
    });

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`).sort(),
    ).toEqual(
      [
        "POST /api/v1/sessions",
        "GET /api/v1/sessions",
        "GET /api/v1/sessions/:id",
        "POST /api/v1/sessions/:id/steps",
        "POST /api/v1/sessions/:id/steps/:stepId/decision",
        "POST /api/v1/sessions/:id/decisions/:decisionId",
        "GET /api/v1/sessions/:id/decisions",
        "POST /api/v1/sessions/:id/close",
        "POST /api/v1/sessions/:id/reopen",
      ].sort(),
    );
    for (const route of routes) {
      expect(route.auth).toBe("required");
    }
  });
});

describe("createSessionRoutes — POST /api/v1/sessions", () => {
  test("returns 201 with the created session row", async () => {
    const writer = buildWriter({ created: SESSION_ROW });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions",
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(201);
    expect(parseBody(response)).toEqual(SESSION_ROW);
    expect(writer.createSession).toHaveBeenCalledWith(
      "ada",
      expect.any(String),
    );
  });

  test("throws ERR_CONSOLE_UNAUTHENTICATED when no operator resolved, without calling the writer", async () => {
    const writer = buildWriter();
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/sessions"),
        buildContext({ method: "POST", path: "/api/v1/sessions" }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNAUTHENTICATED",
    );
    expect(writer.createSession).not.toHaveBeenCalled();
  });
});

describe("createSessionRoutes — GET /api/v1/sessions", () => {
  test("returns 200 with the bare row array", async () => {
    const reader = buildReader({ list: [SESSION_ROW] });
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions"),
      buildContext({ path: "/api/v1/sessions", operatorName: "ada" }),
    );

    expect(response.status).toBe(200);
    const body = parseBody(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "session-1" });
  });

  test("passes ?status=, ?operator= and ?limit= through to the reader", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions"),
      buildContext({
        path: "/api/v1/sessions?status=open&operator=ada&limit=5",
        operatorName: "ada",
      }),
    );

    expect(reader.listSessions).toHaveBeenCalledWith({
      status: "open",
      operator: "ada",
      limit: 5,
    });
  });

  test("omits status/operator from the query when absent, and still resolves a numeric limit", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions"),
      buildContext({ path: "/api/v1/sessions", operatorName: "ada" }),
    );

    const call: unknown = reader.listSessions.mock.calls[0]?.[0];
    expect(call).toMatchObject({});
    expect((call as { status?: unknown }).status).toBeUndefined();
    expect((call as { operator?: unknown }).operator).toBeUndefined();
    expect(typeof (call as { limit: unknown }).limit).toBe("number");
  });

  test.each(["open", "closed"] as const)(
    "passes a valid ?status=%s straight through to the reader",
    async (status) => {
      const reader = buildReader();
      const routes = createSessionRoutes({ reader, writer: buildWriter() });

      await runRoute(
        findRoute(routes, "GET", "/api/v1/sessions"),
        buildContext({
          path: `/api/v1/sessions?status=${status}`,
          operatorName: "ada",
        }),
      );

      expect(reader.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    },
  );

  test("the exported SESSION_STATUS_VALUES vocabulary is exactly ['open', 'closed']", () => {
    expect(new Set(SESSION_STATUS_VALUES)).toEqual(new Set(["open", "closed"]));
    expect(SESSION_STATUS_VALUES).toHaveLength(2);
  });

  test("SESSION_STATUS_VALUES stays in sync with the real M3LSessionStatus union", () => {
    expectTypeOf<M3LSessionStatus>().toEqualTypeOf<
      (typeof SESSION_STATUS_VALUES)[number]
    >();
  });

  test("rejects an unrecognised ?status= with 400 ERR_CONSOLE_BAD_REQUEST, without calling the reader", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions"),
        buildContext({
          path: "/api/v1/sessions?status=nonsense",
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(reader.listSessions).not.toHaveBeenCalled();
  });

  test("does not echo an unbounded caller-supplied ?status= string back in the error message", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });
    const overlongGarbage = "x".repeat(500);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions"),
        buildContext({
          path: `/api/v1/sessions?status=${overlongGarbage}`,
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlongGarbage);
    expect(message.length).toBeLessThan(200);
  });

  test.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-integer", "1.5"],
  ])(
    "rejects a %s ?limit= with 400 ERR_CONSOLE_BAD_REQUEST, without calling the reader",
    async (_label, limit) => {
      const reader = buildReader();
      const routes = createSessionRoutes({ reader, writer: buildWriter() });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "GET", "/api/v1/sessions"),
          buildContext({
            path: `/api/v1/sessions?limit=${limit}`,
            operatorName: "ada",
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(reader.listSessions).not.toHaveBeenCalled();
    },
  );
});

describe("createSessionRoutes — GET /api/v1/sessions/:id", () => {
  test("returns 200 with the row for a known id", async () => {
    const reader = buildReader({ get: SESSION_ROW });
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions/:id"),
      buildContext({
        path: "/api/v1/sessions/session-1",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["id"]).toBe("session-1");
    expect(reader.getSession).toHaveBeenCalledWith("session-1");
  });

  test("returns 404 ERR_CONSOLE_SESSION_NOT_FOUND for an unknown id", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions/:id"),
        buildContext({
          path: "/api/v1/sessions/nope",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });
});

describe("createSessionRoutes — POST /api/v1/sessions/:id/steps", () => {
  const VALID_BODY = {
    operation: "sqs-etl",
    bindings: [VALID_BINDING],
    confirmed: true,
    dryRun: false,
  };

  test("awaits writer.addStep and returns 201 with the raw M3LSessionAddStepResult", async () => {
    const writer = buildWriter({ addStepResult: ADD_STEP_RESULT });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/steps"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/steps",
        params: { id: "session-1" },
        operatorName: "ada",
        body: VALID_BODY,
      }),
    );

    expect(response.status).toBe(201);
    expect(parseBody(response)).toEqual(ADD_STEP_RESULT);
    expect(writer.addStep).toHaveBeenCalledWith("session-1", {
      operation: "sqs-etl",
      bindings: [VALID_BINDING],
      confirmed: true,
      dryRun: false,
      operator: "ada",
      correlationId: expect.any(String) as string,
    });
  });

  test("throws ERR_CONSOLE_UNAUTHENTICATED when no operator resolved, without calling the writer", async () => {
    const writer = buildWriter();
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/sessions/:id/steps"),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/steps",
          params: { id: "session-1" },
          body: VALID_BODY,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNAUTHENTICATED",
    );
    expect(writer.addStep).not.toHaveBeenCalled();
  });

  test.each([
    ["missing operation", { ...VALID_BODY, operation: undefined }],
    ["non-string operation", { ...VALID_BODY, operation: 42 }],
    ["empty operation", { ...VALID_BODY, operation: "" }],
    ["non-array bindings", { ...VALID_BODY, bindings: "oops" }],
    [
      "a binding entry with a non-string reference",
      { ...VALID_BODY, bindings: [{ ...VALID_BINDING, reference: 42 }] },
    ],
    [
      "a binding entry with an empty reference",
      { ...VALID_BODY, bindings: [{ ...VALID_BINDING, reference: "" }] },
    ],
    [
      "a binding entry with an empty parameterName",
      { ...VALID_BODY, bindings: [{ ...VALID_BINDING, parameterName: "" }] },
    ],
    [
      "a binding entry with an unrecognised expectedType",
      {
        ...VALID_BODY,
        bindings: [{ ...VALID_BINDING, expectedType: "array" }],
      },
    ],
    [
      "a binding entry with a non-boolean multiSelect",
      { ...VALID_BODY, bindings: [{ ...VALID_BINDING, multiSelect: "yes" }] },
    ],
    ["non-boolean confirmed", { ...VALID_BODY, confirmed: "yes" }],
    ["non-boolean dryRun", { ...VALID_BODY, dryRun: "no" }],
    ["a non-object body", "oops"],
  ])(
    "rejects a %s body with 400 ERR_CONSOLE_BAD_REQUEST, without ever calling the writer",
    async (_label, body) => {
      const writer = buildWriter();
      const routes = createSessionRoutes({ reader: buildReader(), writer });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "POST", "/api/v1/sessions/:id/steps"),
          buildContext({
            method: "POST",
            path: "/api/v1/sessions/session-1/steps",
            params: { id: "session-1" },
            operatorName: "ada",
            body,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(writer.addStep).not.toHaveBeenCalled();
    },
  );

  test("accepts an empty bindings array", async () => {
    const writer = buildWriter({ addStepResult: ADD_STEP_RESULT });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/steps"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/steps",
        params: { id: "session-1" },
        operatorName: "ada",
        body: { ...VALID_BODY, bindings: [] },
      }),
    );

    expect(response.status).toBe(201);
    expect(writer.addStep).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ bindings: [] }),
    );
  });

  test.each([
    "ERR_CONSOLE_SESSION_NOT_FOUND",
    "ERR_CONSOLE_SESSION_CLOSED",
  ] as const)(
    "propagates a rejected %s from writer.addStep unchanged, not swallowed or rewrapped",
    async (code) => {
      const original = new M3LConsoleError(code, "propagated unchanged");
      const writer = buildWriter();
      writer.addStep.mockRejectedValue(original);
      const routes = createSessionRoutes({ reader: buildReader(), writer });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "POST", "/api/v1/sessions/:id/steps"),
          buildContext({
            method: "POST",
            path: "/api/v1/sessions/session-1/steps",
            params: { id: "session-1" },
            operatorName: "ada",
            body: VALID_BODY,
          }),
        ),
      );

      expect(thrown).toBe(original);
    },
  );
});

describe("createSessionRoutes — POST /api/v1/sessions/:id/steps/:stepId/decision", () => {
  test("returns 201 with the raw decision record", async () => {
    const writer = buildWriter({ decision: DECISION });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/steps/:stepId/decision"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/steps/step-1/decision",
        params: { id: "session-1", stepId: "step-1" },
        operatorName: "ada",
        body: { prompt: "pick a queue" },
      }),
    );

    expect(response.status).toBe(201);
    expect(parseBody(response)).toEqual(DECISION);
    expect(writer.raiseDecision).toHaveBeenCalledWith(
      "session-1",
      "step-1",
      "pick a queue",
      undefined,
    );
  });

  test("passes an optional options value through to writer.raiseDecision", async () => {
    const writer = buildWriter({ decision: DECISION });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/steps/:stepId/decision"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/steps/step-1/decision",
        params: { id: "session-1", stepId: "step-1" },
        operatorName: "ada",
        body: { prompt: "pick a queue", options: { choices: ["a", "b"] } },
      }),
    );

    expect(writer.raiseDecision).toHaveBeenCalledWith(
      "session-1",
      "step-1",
      "pick a queue",
      { choices: ["a", "b"] },
    );
  });

  test.each([
    ["missing prompt", {}],
    ["empty prompt", { prompt: "" }],
    ["non-string prompt", { prompt: 42 }],
  ])(
    "rejects a %s body with 400 ERR_CONSOLE_BAD_REQUEST, without calling the writer",
    async (_label, body) => {
      const writer = buildWriter();
      const routes = createSessionRoutes({ reader: buildReader(), writer });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(
            routes,
            "POST",
            "/api/v1/sessions/:id/steps/:stepId/decision",
          ),
          buildContext({
            method: "POST",
            path: "/api/v1/sessions/session-1/steps/step-1/decision",
            params: { id: "session-1", stepId: "step-1" },
            operatorName: "ada",
            body,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(writer.raiseDecision).not.toHaveBeenCalled();
    },
  );

  test("propagates a thrown ERR_CONSOLE_SESSION_STEP_NOT_FOUND from writer.raiseDecision unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      "no such step",
    );
    const writer = buildWriter();
    writer.raiseDecision.mockImplementation(() => {
      throw original;
    });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(
          routes,
          "POST",
          "/api/v1/sessions/:id/steps/:stepId/decision",
        ),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/steps/step-1/decision",
          params: { id: "session-1", stepId: "step-1" },
          operatorName: "ada",
          body: { prompt: "pick a queue" },
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});

describe("createSessionRoutes — POST /api/v1/sessions/:id/decisions/:decisionId", () => {
  test("returns 200 with { applied } and calls writer.answerDecision with only the decision id, ignoring :id", async () => {
    const writer = buildWriter({ answerResult: true });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/decisions/:decisionId"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/decisions/decision-1",
        params: { id: "session-1", decisionId: "decision-1" },
        operatorName: "ada",
        body: { answer: "us-east-1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual({ applied: true });
    expect(writer.answerDecision).toHaveBeenCalledWith(
      "decision-1",
      "us-east-1",
    );
    expect(writer.answerDecision).not.toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
    );
  });

  test("accepts a body whose answer value is explicitly null", async () => {
    const writer = buildWriter({ answerResult: false });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/decisions/:decisionId"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/decisions/decision-1",
        params: { id: "session-1", decisionId: "decision-1" },
        operatorName: "ada",
        body: { answer: null },
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual({ applied: false });
    expect(writer.answerDecision).toHaveBeenCalledWith("decision-1", null);
  });

  test.each([
    ["a non-object body", "oops"],
    ["a body missing the 'answer' key entirely", {}],
  ])(
    "rejects %s with 400 ERR_CONSOLE_BAD_REQUEST, without calling the writer",
    async (_label, body) => {
      const writer = buildWriter();
      const routes = createSessionRoutes({ reader: buildReader(), writer });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(
            routes,
            "POST",
            "/api/v1/sessions/:id/decisions/:decisionId",
          ),
          buildContext({
            method: "POST",
            path: "/api/v1/sessions/session-1/decisions/decision-1",
            params: { id: "session-1", decisionId: "decision-1" },
            operatorName: "ada",
            body,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(writer.answerDecision).not.toHaveBeenCalled();
    },
  );

  test("propagates a thrown ERR_CONSOLE_SESSION_STEP_NOT_FOUND from writer.answerDecision unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      "no such decision",
    );
    const writer = buildWriter();
    writer.answerDecision.mockImplementation(() => {
      throw original;
    });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/sessions/:id/decisions/:decisionId"),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/session-1/decisions/nope",
          params: { id: "session-1", decisionId: "nope" },
          operatorName: "ada",
          body: { answer: "x" },
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});

describe("createSessionRoutes — GET /api/v1/sessions/:id/decisions", () => {
  test("returns 200 with the reader's decisions array verbatim", async () => {
    const reader = buildReader({ decisions: [DECISION] });
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions/:id/decisions"),
      buildContext({
        path: "/api/v1/sessions/session-1/decisions",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([DECISION]);
    expect(reader.listDecisionsForSession).toHaveBeenCalledWith("session-1");
  });

  test("returns 200 with an empty array for a session with no decisions", async () => {
    const reader = buildReader({ decisions: [] });
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/sessions/:id/decisions"),
      buildContext({
        path: "/api/v1/sessions/session-1/decisions",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  test("returns 400 naming the missing ':id' route parameter, without calling the reader", async () => {
    const reader = buildReader();
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions/:id/decisions"),
        buildContext({
          path: "/api/v1/sessions/decisions",
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("':id'");
    expect(reader.listDecisionsForSession).not.toHaveBeenCalled();
  });

  // INVARIANT: the route owns NO not-found logic. Mirrors the equivalent
  // "propagates unchanged" cases elsewhere in this file.
  test("propagates a thrown ERR_CONSOLE_SESSION_NOT_FOUND from reader.listDecisionsForSession unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      "no such session",
    );
    const reader = buildReader();
    reader.listDecisionsForSession.mockImplementation(() => {
      throw original;
    });
    const routes = createSessionRoutes({ reader, writer: buildWriter() });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/sessions/:id/decisions"),
        buildContext({
          path: "/api/v1/sessions/nope/decisions",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});

describe("createSessionRoutes — POST /api/v1/sessions/:id/close", () => {
  test("returns 200 with { applied } from writer.closeSession", async () => {
    const writer = buildWriter({ closeResult: true });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/close"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/close",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual({ applied: true });
    expect(writer.closeSession).toHaveBeenCalledWith("session-1");
  });

  test("returns { applied: false } when the session was already closed", async () => {
    const writer = buildWriter({ closeResult: false });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/close"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/close",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(parseBody(response)).toEqual({ applied: false });
  });

  test("propagates a thrown ERR_CONSOLE_SESSION_NOT_FOUND from writer.closeSession unchanged for an unknown id", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      "no such session",
    );
    const writer = buildWriter();
    writer.closeSession.mockImplementation(() => {
      throw original;
    });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/sessions/:id/close"),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/nope/close",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});

describe("createSessionRoutes — POST /api/v1/sessions/:id/reopen", () => {
  test("returns 200 with { applied } from writer.reopenSession", async () => {
    const writer = buildWriter({ reopenResult: true });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/reopen"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/reopen",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual({ applied: true });
    expect(writer.reopenSession).toHaveBeenCalledWith("session-1");
  });

  test("returns { applied: false } when the session was already open", async () => {
    const writer = buildWriter({ reopenResult: false });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/sessions/:id/reopen"),
      buildContext({
        method: "POST",
        path: "/api/v1/sessions/session-1/reopen",
        params: { id: "session-1" },
        operatorName: "ada",
      }),
    );

    expect(parseBody(response)).toEqual({ applied: false });
  });

  test("propagates a thrown ERR_CONSOLE_SESSION_NOT_FOUND from writer.reopenSession unchanged for an unknown id", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      "no such session",
    );
    const writer = buildWriter();
    writer.reopenSession.mockImplementation(() => {
      throw original;
    });
    const routes = createSessionRoutes({ reader: buildReader(), writer });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/sessions/:id/reopen"),
        buildContext({
          method: "POST",
          path: "/api/v1/sessions/nope/reopen",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});
