/**
 * Tests for src/http/routes/scripts.ts — `createScriptRoutes` (X10b:
 * console-server script discovery).
 * `src/http/routes/scripts.ts` does not exist yet; this suite is RED until
 * the implementation lands.
 *
 * DECISIONS THIS SUITE BAKES IN (per the X10b contract):
 *
 * 1. `createScriptRoutes({ catalog })` takes one narrow LOCAL port
 *    ({@link M3LScriptCatalogPort}) declared inside `http/routes/scripts.ts`
 *    (never imported from `runs/` — zone rules forbid `http -> runs`),
 *    mirroring `runs/descriptors.ts`'s `M3LScriptCatalog.list`/`.describe`
 *    field for field.
 * 2. `GET /api/v1/scripts` responds with `catalog.list()`'s result verbatim
 *    (a bare JSON array, mirroring `GET /api/v1/runs`'s own bare-array
 *    convention).
 * 3. `GET /api/v1/scripts/:name` validates `:name` itself, BEFORE the
 *    catalog is ever called — a THIRD verbatim duplication of
 *    `runs/parameters.ts`'s `SCRIPT_NAME_PATTERN` (the first being
 *    `runs/parameters.ts` itself, the second `http/routes/runs.ts`'s own
 *    private copy) — for the same zone reason `http/routes/runs.ts`
 *    documents for its own copy. Exported as `SCRIPT_ROUTE_NAME_PATTERN` so
 *    this suite can drift-guard all three copies against each other,
 *    exactly as `routes-runs.test.ts` drift-guards `RUN_STATUS_VALUES`. This
 *    requires `http/routes/runs.ts`'s own currently-private
 *    `SCRIPT_NAME_PATTERN` to become an export too — both modules already
 *    live in the same `http` zone, so exporting it crosses no zone
 *    boundary.
 *
 * Every case drives a returned route's `handler` directly against a plain
 * `M3LRequestContext`-shaped fixture — no real socket, no real `node:http`
 * server, matching `tests/routes-runs.test.ts`'s established pattern.
 */
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { httpStatusForCode } from "../src/http/envelope.js";
import {
  createScriptRoutes,
  SCRIPT_ROUTE_NAME_PATTERN,
} from "../src/http/routes/scripts.js";
import type { M3LScriptCatalogPort } from "../src/http/routes/scripts.js";
import { SCRIPT_NAME_PATTERN as PARAMETERS_SCRIPT_NAME_PATTERN } from "../src/runs/parameters.js";
import { SCRIPT_NAME_PATTERN as RUNS_ROUTE_SCRIPT_NAME_PATTERN } from "../src/http/routes/runs.js";
import type { M3LRoute } from "../src/http/router.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { isStreamResponse } from "../src/http/stream-response.js";

/** A NUL byte embedded mid-string — built via `fromCharCode` rather than a
 * literal `\x00` escape, so this source file never carries a raw control
 * byte (only the printable call below does, at runtime). */
const NUL_BYTE = String.fromCharCode(0);

/** One fixture script summary, matching `M3LScriptSummary`'s field set. */
interface FakeScriptSummary {
  readonly name: string;
  readonly description: string;
  readonly hasCommandModule: boolean;
  readonly executionMode: "spawn" | "in-process";
}

/** One fixture script detail, matching `M3LScriptDetail`'s field set. */
interface FakeScriptDetail extends FakeScriptSummary {
  readonly parameters: readonly unknown[];
  readonly operations: readonly unknown[];
}

const SUMMARY_ETL: FakeScriptSummary = {
  name: "sqs-etl",
  description: "moves rows from sqs to a table",
  hasCommandModule: true,
  executionMode: "in-process",
};

const DETAIL_ETL: FakeScriptDetail = {
  ...SUMMARY_ETL,
  parameters: [],
  operations: [],
};

/**
 * Builds a bare fixture catalog whose `list`/`describe` are `vi.fn()` spies,
 * so a test can assert call counts (in particular: zero calls, to prove a
 * rejected `:name` never reaches the catalog).
 *
 * Both members are `Omit`ted from the port and re-declared as their mock
 * types: since 8.68.0 `@typescript-eslint/unbound-method` walks every
 * intersection constituent and reports if *any* declares the member with
 * method shorthand, so an intact `M3LScriptCatalogPort` constituent would flag
 * every `expect(catalog.list)...` assertion here. The mock types are
 * parameterized because, with the port's signatures `Omit`ted away, nothing
 * else keeps the fixture assignable to the port at the injection site.
 */
function buildCatalog(
  overrides: {
    readonly list?: readonly FakeScriptSummary[];
    readonly describeImpl?: (name: string) => Promise<FakeScriptDetail>;
  } = {},
): Omit<M3LScriptCatalogPort, "list" | "describe"> & {
  list: Mock<M3LScriptCatalogPort["list"]>;
  describe: Mock<M3LScriptCatalogPort["describe"]>;
} {
  const describeImpl =
    overrides.describeImpl ?? (() => Promise.resolve(DETAIL_ETL));
  return {
    list: vi
      .fn<M3LScriptCatalogPort["list"]>()
      .mockReturnValue(overrides.list ?? [SUMMARY_ETL]),
    describe: vi
      .fn<M3LScriptCatalogPort["describe"]>()
      .mockImplementation(describeImpl),
  };
}

/** Options for {@link buildContext}. */
interface BuildContextOptions {
  readonly method?: string;
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
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
function parseBody(response: M3LConsoleResponse): unknown {
  return JSON.parse(response.body) as unknown;
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

describe("createScriptRoutes — route table shape", () => {
  test("registers GET /api/v1/scripts and GET /api/v1/scripts/:name, both auth: 'required'", () => {
    const routes = createScriptRoutes({ catalog: buildCatalog() });

    expect(
      routes.map((route: M3LRoute) => `${route.method} ${route.path}`).sort(),
    ).toEqual(["GET /api/v1/scripts", "GET /api/v1/scripts/:name"]);
    for (const route of routes) {
      expect(route.auth).toBe("required");
    }
  });
});

describe("createScriptRoutes — GET /api/v1/scripts", () => {
  test("returns 200 with catalog.list()'s result verbatim as a bare JSON array", async () => {
    const catalog = buildCatalog({ list: [SUMMARY_ETL] });
    const routes = createScriptRoutes({ catalog });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/scripts"),
      buildContext({ path: "/api/v1/scripts" }),
    );

    expect(response.status).toBe(200);
    const body = parseBody(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([SUMMARY_ETL]);
    expect(catalog.list).toHaveBeenCalledTimes(1);
  });

  test("returns 200 with an empty array when the catalog is empty", async () => {
    const catalog = buildCatalog({ list: [] });
    const routes = createScriptRoutes({ catalog });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/scripts"),
      buildContext({ path: "/api/v1/scripts" }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual([]);
  });
});

describe("createScriptRoutes — GET /api/v1/scripts/:name", () => {
  test("returns 200 with catalog.describe(name)'s awaited result", async () => {
    const catalog = buildCatalog({
      describeImpl: () => Promise.resolve(DETAIL_ETL),
    });
    const routes = createScriptRoutes({ catalog });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/scripts/:name"),
      buildContext({
        path: "/api/v1/scripts/sqs-etl",
        params: { name: "sqs-etl" },
      }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual(DETAIL_ETL);
    expect(catalog.describe).toHaveBeenCalledWith("sqs-etl");
  });
});

describe("createScriptRoutes — GET /api/v1/scripts/:name — validation rejects before the catalog is called", () => {
  test("missing ':name' route parameter returns 400 ERR_CONSOLE_BAD_REQUEST, without calling the catalog", async () => {
    const catalog = buildCatalog();
    const routes = createScriptRoutes({ catalog });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/scripts/:name"),
        buildContext({ path: "/api/v1/scripts/" }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain(
      "missing ':name' route parameter",
    );
    expect(catalog.describe).not.toHaveBeenCalled();
    expect(catalog.list).not.toHaveBeenCalled();
  });

  test.each([
    ["non-kebab-case (uppercase)", "Not-Kebab"],
    ["a relative traversal attempt", "../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a name containing a NUL byte", `abc${NUL_BYTE}def`],
  ])(
    "rejects %s with 400 ERR_CONSOLE_BAD_REQUEST, without ever calling the catalog",
    async (_label, name) => {
      const catalog = buildCatalog();
      const routes = createScriptRoutes({ catalog });

      const thrown = await captureThrown(() =>
        runRoute(
          findRoute(routes, "GET", "/api/v1/scripts/:name"),
          buildContext({
            path: `/api/v1/scripts/${encodeURIComponent(name)}`,
            params: { name },
          }),
        ),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(catalog.describe).not.toHaveBeenCalled();
      expect(catalog.list).not.toHaveBeenCalled();
    },
  );

  test("truncates a rejected name to at most 32 characters before echoing it into the message", async () => {
    const catalog = buildCatalog();
    const routes = createScriptRoutes({ catalog });
    const overlong = `Not-Kebab-${"x".repeat(60)}`;

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/scripts/:name"),
        buildContext({
          path: `/api/v1/scripts/${encodeURIComponent(overlong)}`,
          params: { name: overlong },
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlong);
    expect(message).toContain(overlong.slice(0, 32));
    expect(catalog.describe).not.toHaveBeenCalled();
  });
});

describe("createScriptRoutes — GET /api/v1/scripts/:name — catalog failures propagate unchanged", () => {
  test("propagates a 404 ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND raised by catalog.describe unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      "no launchable script named 'missing-script'",
    );
    const catalog = buildCatalog({
      describeImpl: () => Promise.reject(original),
    });
    const routes = createScriptRoutes({ catalog });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/scripts/:name"),
        buildContext({
          path: "/api/v1/scripts/missing-script",
          params: { name: "missing-script" },
        }),
      ),
    );

    expect(thrown).toBe(original);
    expect(httpStatusForCode((thrown as M3LConsoleError).code)).toBe(404);
  });

  test("propagates a 500 ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED raised by catalog.describe unchanged", async () => {
    const original = new M3LConsoleError(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
      "failed to introspect script 'sqs-etl'",
    );
    const catalog = buildCatalog({
      describeImpl: () => Promise.reject(original),
    });
    const routes = createScriptRoutes({ catalog });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/scripts/:name"),
        buildContext({
          path: "/api/v1/scripts/sqs-etl",
          params: { name: "sqs-etl" },
        }),
      ),
    );

    expect(thrown).toBe(original);
    expect(httpStatusForCode((thrown as M3LConsoleError).code)).toBe(500);
  });
});

describe("SCRIPT_ROUTE_NAME_PATTERN — drift guard", () => {
  // Zone rules restrict src -> tests, never tests -> src, so this test may
  // legally import all three copies of the duplicated pattern — converting
  // a silent-drift duplication into a failing test the day one copy changes
  // without the others.
  test("is character-for-character identical to runs/parameters.ts's SCRIPT_NAME_PATTERN and to http/routes/runs.ts's own copy", () => {
    expect(SCRIPT_ROUTE_NAME_PATTERN.source).toBe(
      PARAMETERS_SCRIPT_NAME_PATTERN.source,
    );
    expect(SCRIPT_ROUTE_NAME_PATTERN.flags).toBe(
      PARAMETERS_SCRIPT_NAME_PATTERN.flags,
    );
    expect(SCRIPT_ROUTE_NAME_PATTERN.source).toBe(
      RUNS_ROUTE_SCRIPT_NAME_PATTERN.source,
    );
    expect(SCRIPT_ROUTE_NAME_PATTERN.flags).toBe(
      RUNS_ROUTE_SCRIPT_NAME_PATTERN.flags,
    );
  });
});
