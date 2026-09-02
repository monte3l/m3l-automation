/**
 * Tests for src/http/routes/runs.ts — `createRunRoutes` (X4 slice 7a).
 * `src/http/routes/runs.ts` does not exist yet; this suite is RED until the
 * implementation lands.
 *
 * DECISIONS THIS SUITE BAKES IN (contract left these open — confirm with the
 * hub before GREEN, per the slice-7a addendum):
 *
 * 1. `M3LRequestContext` (http/context.ts) ALREADY carries a parsed request
 *    body (`body?: unknown`, wired by PR #731's `withBody`/`http/body.ts`) —
 *    this suite drives it directly, no widened fixture type needed.
 * 2. `createRunRoutes(options)` takes `{ orchestrator, registry }`, two
 *    narrow LOCAL ports (declared inside `http/routes/runs.ts`, never
 *    imported from `runs/`) mirroring `M3LRunOrchestrator.launch` and
 *    `M3LRunRegistry.list`/`.get` field-for-field, so the real objects
 *    satisfy them structurally at the `main.ts` wiring site.
 * 3. `GET /api/v1/runs` responds with a bare JSON array of rows (not an
 *    `{ runs: [...] }` envelope).
 * 4. The route validates `scriptName`/`confirmed`/`dryRun`/`parameters`
 *    itself (it cannot import `runs/parameters.ts`'s `parseRunRequest` —
 *    zone rules forbid `http -> runs`), duplicating those same rules.
 * 5. (Addendum Correction 1) `http/routes/runs.ts` declares AND EXPORTS its
 *    own accepted `?status=` vocabulary as `RUN_STATUS_VALUES` — `http/` may
 *    not import `store/run-status.ts`'s `RUN_STATUSES`, even type-only, so
 *    the module must duplicate the list and this suite guards the
 *    duplication from drift (see the dedicated describe block below). This
 *    suite fixes the export's name; confirm it with the hub before GREEN if
 *    a different name is preferred.
 *
 * Every case drives a returned route's `handler` directly against a plain
 * `M3LRequestContext`-shaped fixture — no real socket, no real `node:http`
 * server, matching `tests/health.test.ts`'s established pattern.
 */
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRunRoutes, RUN_STATUS_VALUES } from "../src/http/routes/runs.js";
import type { M3LRoute } from "../src/http/router.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { isStreamResponse } from "../src/http/stream-response.js";
import { RUN_STATUSES } from "../src/store/run-status.js";

/** One fixture run handle, matching `M3LRunHandle`'s field set exactly. */
interface FakeRunHandle {
  readonly id: string;
  readonly scriptName: string;
  readonly status: "queued" | "running";
  readonly dryRun: boolean;
  readonly executionMode: "spawn" | "in-process";
}

/** One fixture run row, matching `M3LRunRecord`'s field set. */
interface FakeRunRow {
  readonly id: string;
  readonly script: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly executionMode: string;
  readonly parameters: unknown;
  readonly operator: string;
  readonly correlationId: string;
  readonly queuedAtMs: number;
}

/** The local launcher port `createRunRoutes` depends on — mirrors `M3LRunOrchestrator.launch`. */
interface FakeLauncher {
  launch(request: {
    readonly body: {
      readonly scriptName: string;
      readonly confirmed: boolean;
      readonly dryRun: boolean;
      readonly parameters: Readonly<Record<string, string>>;
    };
    readonly operator: string;
    readonly correlationId: string;
  }): FakeRunHandle;
}

/** The local reader port `createRunRoutes` depends on — mirrors `M3LRunRegistry.list`/`.get`. */
interface FakeRegistry {
  list(query: {
    readonly status?: string;
    readonly limit: number;
  }): readonly FakeRunRow[];
  get(id: string): FakeRunRow | undefined;
}

/**
 * Builds a bare fixture launcher whose `launch` returns `handle`.
 *
 * `launch` is `Omit`ted from `FakeLauncher` before the `vi.fn()` member is
 * intersected in (mirrors `tests/auth-middleware.test.ts`'s `buildProvider`),
 * so an `expect(orchestrator.launch)...` assertion reads the mock function's
 * own type. Leaving `FakeLauncher` whole is not enough: since 8.68.0
 * `@typescript-eslint/unbound-method` walks every intersection constituent and
 * reports if *any* of them declares the member with method shorthand, so the
 * interface side alone would flag all of these assertions — even though they
 * only inspect the mock and never call it, so no `this`-scoping hazard exists.
 * The mock type is parameterized (not a bare `ReturnType<typeof vi.fn>`)
 * because with `FakeLauncher`'s own signature `Omit`ted away, nothing else
 * keeps the fixture assignable to `M3LRunLauncherPort` at the injection site.
 */
function buildLauncher(
  handle: FakeRunHandle,
): Omit<FakeLauncher, "launch"> & { launch: Mock<FakeLauncher["launch"]> } {
  return { launch: vi.fn<FakeLauncher["launch"]>().mockReturnValue(handle) };
}

/** Builds a bare fixture registry, retyped the same way as {@link buildLauncher}. */
function buildRegistry(
  overrides: {
    readonly list?: readonly FakeRunRow[];
    readonly get?: FakeRunRow;
  } = {},
): Omit<FakeRegistry, "list" | "get"> & {
  list: Mock<FakeRegistry["list"]>;
  get: Mock<FakeRegistry["get"]>;
} {
  return {
    list: vi.fn<FakeRegistry["list"]>().mockReturnValue(overrides.list ?? []),
    get: vi.fn<FakeRegistry["get"]>().mockReturnValue(overrides.get),
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

const HANDLE_RUNNING: FakeRunHandle = {
  id: "run-1",
  scriptName: "sqs-etl",
  status: "running",
  dryRun: false,
  executionMode: "spawn",
};

/**
 * A run-report port that reports "no report for this run". The default for
 * every suite below that is not about the report route: those exercise the
 * launch/list/get handlers, which never touch it.
 *
 * `report` overrides what {@link M3LRunReportPort.read} resolves to; the
 * dedicated report describes below pass a real value.
 */
function buildReportReader(report?: unknown): {
  read: Mock<(runId: string) => Promise<unknown>>;
} {
  return { read: vi.fn(() => Promise.resolve(report)) };
}

describe("createRunRoutes — route table shape", () => {
  test("registers the four run routes, all auth: 'required'", () => {
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry: { list: vi.fn().mockReturnValue([]), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`).sort(),
    ).toEqual([
      "GET /api/v1/runs",
      "GET /api/v1/runs/:id",
      "GET /api/v1/runs/:id/report",
      "POST /api/v1/runs",
    ]);
    for (const route of routes) {
      expect(route.auth).toBe("required");
    }
  });
});

describe("createRunRoutes — POST /api/v1/runs", () => {
  test("returns 201 with the run handle on an accepted launch", async () => {
    const orchestrator = buildLauncher(HANDLE_RUNNING);
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/runs"),
      buildContext({
        method: "POST",
        path: "/api/v1/runs",
        operatorName: "ada",
        body: { scriptName: "sqs-etl" },
      }),
    );

    expect(response.status).toBe(201);
    const body = parseBody(response);
    expect(body["id"]).toBe("run-1");
    expect(body["scriptName"]).toBe("sqs-etl");
    expect(body["status"]).toBe("running");
    expect(body["dryRun"]).toBe(false);
    expect(body["executionMode"]).toBe("spawn");
  });

  test("returns 201 with status 'queued' when the governor queued the run", async () => {
    const orchestrator = buildLauncher({
      id: "run-2",
      scriptName: "sqs-etl",
      status: "queued",
      dryRun: false,
      executionMode: "spawn",
    });
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const response = await runRoute(
      findRoute(routes, "POST", "/api/v1/runs"),
      buildContext({
        method: "POST",
        path: "/api/v1/runs",
        operatorName: "ada",
        body: { scriptName: "sqs-etl" },
      }),
    );

    expect(response.status).toBe(201);
    expect(parseBody(response)["status"]).toBe("queued");
  });

  test.each([
    ["missing scriptName", {}],
    ["non-string scriptName", { scriptName: 42 }],
    ["non-kebab-case scriptName", { scriptName: "Not_Kebab" }],
    ["non-boolean confirmed", { scriptName: "sqs-etl", confirmed: "yes" }],
    ["non-boolean dryRun", { scriptName: "sqs-etl", dryRun: "no" }],
    [
      "non-plain-object parameters",
      { scriptName: "sqs-etl", parameters: ["a", "b"] },
    ],
  ])(
    "rejects a %s body with 400 ERR_CONSOLE_BAD_REQUEST, without ever calling the orchestrator",
    async (_label, body) => {
      const orchestrator = buildLauncher(HANDLE_RUNNING);
      const routes = createRunRoutes({
        orchestrator,
        registry: { list: vi.fn(), get: vi.fn() },
        reportReader: buildReportReader(),
      });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "POST", "/api/v1/runs"),
          buildContext({
            method: "POST",
            path: "/api/v1/runs",
            operatorName: "ada",
            body,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(orchestrator.launch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["an array", ["a", "b"]],
    ["a string", "oops"],
    ["null", null],
  ])(
    "rejects a body that is %s (not a JSON object) with 400 ERR_CONSOLE_BAD_REQUEST, without ever calling the orchestrator",
    async (_label, body) => {
      const orchestrator = buildLauncher(HANDLE_RUNNING);
      const routes = createRunRoutes({
        orchestrator,
        registry: { list: vi.fn(), get: vi.fn() },
        reportReader: buildReportReader(),
      });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "POST", "/api/v1/runs"),
          buildContext({
            method: "POST",
            path: "/api/v1/runs",
            operatorName: "ada",
            body,
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(orchestrator.launch).not.toHaveBeenCalled();
    },
  );

  test("rejects a non-string parameters value naming 'parameters.<key>' specifically", async () => {
    const orchestrator = buildLauncher(HANDLE_RUNNING);
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/runs"),
        buildContext({
          method: "POST",
          path: "/api/v1/runs",
          operatorName: "ada",
          body: { scriptName: "sqs-etl", parameters: { region: 42 } },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("parameters.region");
    expect(orchestrator.launch).not.toHaveBeenCalled();
  });

  test("passes a well-formed parameters object through to the orchestrator with its string values intact", async () => {
    // A plain stub (not a `vi.fn()` spy) capturing the received request: this
    // keeps `request` structurally typed off `FakeLauncher.launch` itself,
    // rather than off `vi.fn()`'s widened, unsafe-to-assign-from signature.
    let receivedParameters: Readonly<Record<string, string>> | undefined;
    const orchestrator: FakeLauncher = {
      launch: (request) => {
        receivedParameters = request.body.parameters;
        return HANDLE_RUNNING;
      },
    };
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    await runRoute(
      findRoute(routes, "POST", "/api/v1/runs"),
      buildContext({
        method: "POST",
        path: "/api/v1/runs",
        operatorName: "ada",
        body: {
          scriptName: "sqs-etl",
          parameters: { region: "us-east-1", table: "orders" },
        },
      }),
    );

    expect(receivedParameters).toEqual({
      region: "us-east-1",
      table: "orders",
    });
  });

  test("throws ERR_CONSOLE_UNAUTHENTICATED when no operator resolved for the request, without ever calling the orchestrator", async () => {
    const orchestrator = buildLauncher(HANDLE_RUNNING);
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/runs"),
        buildContext({
          method: "POST",
          path: "/api/v1/runs",
          body: { scriptName: "sqs-etl" },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNAUTHENTICATED",
    );
    expect(orchestrator.launch).not.toHaveBeenCalled();
  });

  test("propagates ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED unchanged (maps to 409 in the envelope, not reshaped here)", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      "confirmation required for a non-dry-run execution",
    );
    const orchestrator: FakeLauncher = {
      launch: vi.fn().mockImplementation(() => {
        throw original;
      }),
    };
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/runs"),
        buildContext({
          method: "POST",
          path: "/api/v1/runs",
          operatorName: "ada",
          body: { scriptName: "sqs-etl", dryRun: false },
        }),
      ),
    );

    expect(thrown).toBe(original);
  });

  test("propagates ERR_CONSOLE_RUN_CAPACITY_EXCEEDED unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
      "the run queue is full",
    );
    const orchestrator: FakeLauncher = {
      launch: vi.fn().mockImplementation(() => {
        throw original;
      }),
    };
    const routes = createRunRoutes({
      orchestrator,
      registry: { list: vi.fn(), get: vi.fn() },
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "POST", "/api/v1/runs"),
        buildContext({
          method: "POST",
          path: "/api/v1/runs",
          operatorName: "ada",
          body: { scriptName: "sqs-etl" },
        }),
      ),
    );

    expect(thrown).toBe(original);
  });
});

describe("createRunRoutes — GET /api/v1/runs", () => {
  const ROW: FakeRunRow = {
    id: "run-1",
    script: "sqs-etl",
    status: "running",
    dryRun: false,
    executionMode: "spawn",
    parameters: {},
    operator: "ada",
    correlationId: "corr-1",
    queuedAtMs: 1_000,
  };

  test("returns 200 with the row list", async () => {
    const registry = buildRegistry({ list: [ROW] });
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/runs"),
      buildContext({ path: "/api/v1/runs", operatorName: "ada" }),
    );

    expect(response.status).toBe(200);
    const body = parseBody(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "run-1" });
  });

  test("passes ?status= and ?limit= through to the registry", async () => {
    const registry = buildRegistry();
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/runs"),
      buildContext({
        path: "/api/v1/runs?status=queued&limit=5",
        operatorName: "ada",
      }),
    );

    expect(registry.list).toHaveBeenCalledWith({ status: "queued", limit: 5 });
  });

  test.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-integer", "1.5"],
  ])(
    "rejects a %s ?limit= with 400 ERR_CONSOLE_BAD_REQUEST, without calling the registry",
    async (_label, limit) => {
      const registry = buildRegistry();
      const routes = createRunRoutes({
        orchestrator: buildLauncher(HANDLE_RUNNING),
        registry,
        reportReader: buildReportReader(),
      });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "GET", "/api/v1/runs"),
          buildContext({
            path: `/api/v1/runs?limit=${limit}`,
            operatorName: "ada",
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(registry.list).not.toHaveBeenCalled();
    },
  );
});

describe("createRunRoutes — GET /api/v1/runs — ?status= vocabulary validation (Correction 1)", () => {
  test.each(RUN_STATUSES)(
    "passes a valid ?status=%s straight through to the registry",
    async (status) => {
      const registry = buildRegistry();
      const routes = createRunRoutes({
        orchestrator: buildLauncher(HANDLE_RUNNING),
        registry,
        reportReader: buildReportReader(),
      });

      await runRoute(
        findRoute(routes, "GET", "/api/v1/runs"),
        buildContext({
          path: `/api/v1/runs?status=${status}`,
          operatorName: "ada",
        }),
      );

      expect(registry.list).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    },
  );

  test("rejects an unrecognised ?status= with 400 ERR_CONSOLE_BAD_REQUEST, without ever calling the registry", async () => {
    const registry = buildRegistry();
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs"),
        buildContext({
          path: "/api/v1/runs?status=nonsense",
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(registry.list).not.toHaveBeenCalled();
  });

  test("does not echo an unbounded caller-supplied ?status= string back in the error message", async () => {
    const registry = buildRegistry();
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });
    const overlongGarbage = "x".repeat(500);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs"),
        buildContext({
          path: `/api/v1/runs?status=${overlongGarbage}`,
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlongGarbage);
    expect(message.length).toBeLessThan(200);
  });

  test("the route's exported RUN_STATUS_VALUES vocabulary matches store/run-status's RUN_STATUSES exactly (drift guard)", () => {
    // Zone rules restrict src -> tests, never tests -> src, so this test may
    // legally import both the http-local duplicate and the store's real
    // vocabulary — converting a silent-drift duplication into a failing
    // test the day someone adds a status without updating both places.
    expect(new Set(RUN_STATUS_VALUES)).toEqual(new Set(RUN_STATUSES));
    expect(RUN_STATUS_VALUES).toHaveLength(RUN_STATUSES.length);
  });
});

describe("createRunRoutes — GET /api/v1/runs/:id", () => {
  test("returns 200 with the row for a known id", async () => {
    const row: FakeRunRow = {
      id: "run-1",
      script: "sqs-etl",
      status: "success",
      dryRun: false,
      executionMode: "spawn",
      parameters: {},
      operator: "ada",
      correlationId: "corr-1",
      queuedAtMs: 1_000,
    };
    const registry = buildRegistry({ get: row });
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id"),
      buildContext({
        path: "/api/v1/runs/run-1",
        params: { id: "run-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)["id"]).toBe("run-1");
    expect(registry.get).toHaveBeenCalledWith("run-1");
  });

  test("returns 404 ERR_CONSOLE_RUN_NOT_FOUND for an unknown id", async () => {
    const registry = buildRegistry();
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id"),
        buildContext({
          path: "/api/v1/runs/nope",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_RUN_NOT_FOUND");
  });

  test("returns 400 ERR_CONSOLE_BAD_REQUEST naming the missing ':id' route parameter, without calling the registry", async () => {
    const registry = buildRegistry();
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: buildReportReader(),
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id"),
        buildContext({ path: "/api/v1/runs/", operatorName: "ada" }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(registry.get).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/runs/:id/report", () => {
  /** One terminal run row — the report route only reads its EXISTENCE. */
  const ROW_SUCCESS: FakeRunRow = {
    id: "run-1",
    script: "sqs-etl",
    status: "success",
    dryRun: false,
    executionMode: "spawn",
    parameters: {},
    operator: "ada",
    correlationId: "corr-1",
    queuedAtMs: 1_000,
  };

  /** Drives the report route for `runId` against a registry/reader pair. */
  function reportRoutes(
    row: FakeRunRow | undefined,
    report: unknown,
  ): {
    readonly routes: readonly M3LRoute[];
    readonly reader: ReturnType<typeof buildReportReader>;
  } {
    const reader = buildReportReader(report);
    return {
      reader,
      routes: createRunRoutes({
        orchestrator: buildLauncher(HANDLE_RUNNING),
        registry: buildRegistry(row === undefined ? {} : { get: row }),
        reportReader: reader,
      }),
    };
  }

  test("returns 200 with the reader's report verbatim", async () => {
    const { routes } = reportRoutes(ROW_SUCCESS, {
      outcome: "success",
      steps: [{ name: "dump" }],
    });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/runs/:id/report"),
      buildContext({
        path: "/api/v1/runs/run-1/report",
        params: { id: "run-1" },
        operatorName: "ada",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual({
      outcome: "success",
      steps: [{ name: "dump" }],
    });
  });

  // INVARIANT: an unknown run id is answered from the REGISTRY, before the
  // reader is consulted at all — otherwise a caller could probe the runs
  // output root for arbitrary ids. Mutation-tested: deleting the registry
  // check makes `reader.read` run for a run that does not exist.
  test("404s an unknown run id without ever calling the reader", async () => {
    const { routes, reader } = reportRoutes(undefined, { outcome: "success" });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/report"),
        buildContext({
          path: "/api/v1/runs/nope/report",
          params: { id: "nope" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_RUN_NOT_FOUND");
    expect((thrown as M3LConsoleError).message).toContain("no run found");
    expect(reader.read).not.toHaveBeenCalled();
  });

  // INVARIANT: a KNOWN run with nothing on disk gets a DIFFERENT message
  // under the same code — an operator polling a still-running run has to be
  // able to tell "not a run" from "not yet". Mutation-tested: collapsing the
  // two messages into one makes this fail.
  test("404s a known run with no persisted report, with its own message", async () => {
    const { routes, reader } = reportRoutes(ROW_SUCCESS, undefined);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/report"),
        buildContext({
          path: "/api/v1/runs/run-1/report",
          params: { id: "run-1" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_RUN_NOT_FOUND");
    expect((thrown as M3LConsoleError).message).toContain(
      "has no persisted report",
    );
    expect(reader.read).toHaveBeenCalledWith("run-1");
  });

  test("returns 400 naming the missing ':id' route parameter, without calling the registry or the reader", async () => {
    const reader = buildReportReader({ outcome: "success" });
    const registry = buildRegistry({ get: ROW_SUCCESS });
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry,
      reportReader: reader,
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/report"),
        buildContext({ path: "/api/v1/runs//report", operatorName: "ada" }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(registry.get).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });

  test("propagates a reader failure unchanged rather than reporting it as a 404", async () => {
    // A fault reading the report is NOT "this run has no report". Collapsing
    // the two would hide a broken output root behind a plausible 404 forever.
    const failure = new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "run 'run-1' has 2 output directories; exactly one is expected",
    );
    const routes = createRunRoutes({
      orchestrator: buildLauncher(HANDLE_RUNNING),
      registry: buildRegistry({ get: ROW_SUCCESS }),
      reportReader: { read: vi.fn(() => Promise.reject(failure)) },
    });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/runs/:id/report"),
        buildContext({
          path: "/api/v1/runs/run-1/report",
          params: { id: "run-1" },
          operatorName: "ada",
        }),
      ),
    );

    expect(thrown).toBe(failure);
  });
});
