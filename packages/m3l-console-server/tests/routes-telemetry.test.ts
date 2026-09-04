/**
 * Tests for src/http/routes/telemetry.ts — `createTelemetryRoutes` (X8
 * slice 4a: `GET /api/v1/telemetry`).
 * `src/http/routes/telemetry.ts` does not exist yet; this suite is RED
 * until the implementation lands.
 *
 * DECISIONS THIS SUITE BAKES IN (per the slice-4a contract in
 * `docs/logs` context handed to this suite's author — see the hub's
 * scratchpad contract for the full rationale):
 *
 * 1. `createTelemetryRoutes(reader)` takes ONE narrow LOCAL port
 *    ({@link M3LTelemetryReaderPort}) declared inside
 *    `http/routes/telemetry.ts` (never imported from `store/` — zone rules
 *    forbid `http -> store`), mirroring
 *    `store/telemetry-repository-types.ts`'s `M3LConsoleTelemetryRepository.list`
 *    field for field. `main.ts` passes `store.telemetry` straight through
 *    with no adapter, per the contract's decision 1.
 * 2. `GET /api/v1/telemetry` responds with `reader.list(...)`'s result
 *    verbatim — a bare JSON array, mirroring `GET /api/v1/runs`'s own
 *    bare-array convention (decision 2: raw rollup buckets, no derived
 *    layer).
 * 3. The module declares and exports its own `GRANULARITY_VALUES`/
 *    `METRIC_VALUES` vocabularies (the same "declare a local copy because
 *    `http/` cannot import `store/`" pattern `routes-runs.test.ts` drift-
 *    guards for `RUN_STATUS_VALUES`) plus a NEW `MAX_LIST_LIMIT` cap that
 *    `runs.ts`/`sessions.ts` deliberately do not have (decision 3).
 * 4. `MAX_LIST_LIMIT` is imported and asserted against directly rather than
 *    hard-coded as `1000` in this suite, so the boundary case cannot drift
 *    silently from the source.
 *
 * Every case drives a returned route's `handler` directly against a plain
 * `M3LRequestContext`-shaped fixture — no real socket, no real `node:http`
 * server, matching `tests/routes-runs.test.ts`'s established pattern.
 *
 * JUDGEMENT CALL: the contract does not name the exact rejection message
 * text for each validation rule (only `routes-runs.test.ts`'s sibling
 * modules' conventions are given). This suite therefore asserts only the
 * `code` (`ERR_CONSOLE_BAD_REQUEST`) and, for the truncation case, that the
 * message excludes the untruncated hostile string — never a specific
 * message string — so the implementer is free to phrase messages as long as
 * the code and truncation behavior hold.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createTelemetryRoutes,
  GRANULARITY_VALUES,
  METRIC_VALUES,
  MAX_LIST_LIMIT,
} from "../src/http/routes/telemetry.js";
import type { M3LTelemetryReaderPort } from "../src/http/routes/telemetry.js";
import type { M3LRoute } from "../src/http/router.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { isStreamResponse } from "../src/http/stream-response.js";
import type {
  M3LTelemetryGranularity,
  M3LTelemetryMetric,
} from "../src/store/telemetry-repository-types.js";
import {
  TELEMETRY_GRANULARITIES,
  TELEMETRY_METRICS,
} from "../src/store/telemetry-validation.js";

/** One fixture rollup bucket, matching `M3LTelemetryBucket`'s field set. */
interface FakeBucket {
  readonly granularity: string;
  readonly bucketStartMs: number;
  readonly metric: string;
  readonly route: string;
  readonly script: string;
  readonly operation: string;
  readonly outcome: string;
  readonly posture: string;
  readonly sampleCount: number;
  readonly sumValue: number | undefined;
  readonly minValue: number | undefined;
  readonly maxValue: number | undefined;
}

const BUCKET_ONE: FakeBucket = {
  granularity: "minute",
  bucketStartMs: 60_000,
  metric: "http.request",
  route: "/api/v1/runs",
  script: "",
  operation: "",
  outcome: "2xx",
  posture: "",
  sampleCount: 3,
  sumValue: 360,
  minValue: 100,
  maxValue: 160,
};

/**
 * Builds a bare fixture reader whose `list` is a `vi.fn()` spy.
 *
 * `Omit`ted from the port and re-declared as its mock type: since 8.68.0
 * `@typescript-eslint/unbound-method` walks every intersection constituent
 * and reports if *any* declares the member with method shorthand, so an
 * intact `M3LTelemetryReaderPort` constituent would flag every
 * `expect(reader.list)...` assertion here (mirrors `routes-runs.test.ts`'s
 * `buildRegistry`).
 */
function buildReader(rows: readonly FakeBucket[] = []): Omit<
  M3LTelemetryReaderPort,
  "list"
> & {
  list: Mock<M3LTelemetryReaderPort["list"]>;
} {
  return {
    list: vi.fn<M3LTelemetryReaderPort["list"]>().mockReturnValue(rows),
  };
}

/**
 * Narrows the reader's captured first call argument away from
 * `noUncheckedIndexedAccess`'s implied `| undefined`, without a type
 * assertion — the caller must have already confirmed `reader.list` was
 * invoked (e.g. via `toHaveBeenCalledTimes`/`toHaveBeenCalledWith`).
 */
function firstListQuery(
  reader: ReturnType<typeof buildReader>,
): Parameters<M3LTelemetryReaderPort["list"]>[0] {
  const [call] = reader.list.mock.calls;
  if (call === undefined) {
    throw new Error("reader.list was not called");
  }
  return call[0];
}

/** Options for {@link buildContext}. */
interface BuildContextOptions {
  readonly path: string;
}

/** Builds a request context for driving a route handler directly. */
function buildContext(options: BuildContextOptions): M3LRequestContext {
  return createRequestContext({
    method: "GET",
    url: options.path,
    headers: {},
    signal: new AbortController().signal,
  });
}

/**
 * Builds a request context whose `query.get` is a counting fake rather than
 * a real `URLSearchParams`, so a test can assert each key was read exactly
 * once. Cast through `unknown` because only `get` is exercised by the
 * module under test — never a full `URLSearchParams` re-implementation.
 */
function buildCountingContext(values: Readonly<Record<string, string>>): {
  readonly ctx: M3LRequestContext;
  readonly counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const query = {
    get(name: string): string | null {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const value = values[name];
      return value ?? null;
    },
  } as unknown as URLSearchParams;
  const base = buildContext({ path: "/api/v1/telemetry" });
  return { ctx: { ...base, query }, counts };
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

/** Runs `route`'s handler against `ctx`, narrowing away the stream arm — this route is always buffered. */
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

/** Parses a response body as JSON. */
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

describe("createTelemetryRoutes — route table shape", () => {
  test("registers exactly one route: GET /api/v1/telemetry, auth: 'required'", () => {
    const routes = createTelemetryRoutes({ reader: buildReader() });

    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(route?.method).toBe("GET");
    expect(route?.path).toBe("/api/v1/telemetry");
    expect(route?.auth).toBe("required");
  });
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — happy path", () => {
  test("returns 200 with the reader's rows verbatim as a bare JSON array", async () => {
    const reader = buildReader([BUCKET_ONE]);
    const routes = createTelemetryRoutes({ reader });

    const response = await runRoute(
      findRoute(routes, "GET", "/api/v1/telemetry"),
      buildContext({ path: "/api/v1/telemetry?granularity=minute" }),
    );

    expect(response.status).toBe(200);
    expect(parseBody(response)).toEqual([BUCKET_ONE]);
  });

  test("with only ?granularity= given, the query passed to the reader has granularity + default limit and no other keys", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/telemetry"),
      buildContext({ path: "/api/v1/telemetry?granularity=minute" }),
    );

    expect(reader.list).toHaveBeenCalledTimes(1);
    const query = firstListQuery(reader);
    expect(query["granularity"]).toBe("minute");
    expect(query["limit"]).toBe(50);
    expect(Object.hasOwn(query, "metric")).toBe(false);
    expect(Object.hasOwn(query, "fromMs")).toBe(false);
    expect(Object.hasOwn(query, "toMs")).toBe(false);
  });
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — every optional param threads through", () => {
  test("passes metric/fromMs/toMs/limit through, with fromMs/toMs as numbers", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/telemetry"),
      buildContext({
        path: "/api/v1/telemetry?granularity=hour&metric=run.finished&fromMs=1000&toMs=2000&limit=10",
      }),
    );

    expect(reader.list).toHaveBeenCalledWith({
      granularity: "hour",
      metric: "run.finished",
      fromMs: 1000,
      toMs: 2000,
      limit: 10,
    });
    const query = firstListQuery(reader);
    expect(typeof query["fromMs"]).toBe("number");
    expect(typeof query["toMs"]).toBe("number");
  });
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — granularity vocabulary is enumerated", () => {
  test.each(GRANULARITY_VALUES)(
    "accepts ?granularity=%s",
    async (granularity) => {
      const reader = buildReader();
      const routes = createTelemetryRoutes({ reader });

      await runRoute(
        findRoute(routes, "GET", "/api/v1/telemetry"),
        buildContext({ path: `/api/v1/telemetry?granularity=${granularity}` }),
      );

      expect(reader.list).toHaveBeenCalledWith(
        expect.objectContaining({ granularity }),
      );
    },
  );
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — metric vocabulary is enumerated", () => {
  test.each(METRIC_VALUES)("accepts ?metric=%s", async (metric) => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/telemetry"),
      buildContext({
        path: `/api/v1/telemetry?granularity=minute&metric=${metric}`,
      }),
    );

    expect(reader.list).toHaveBeenCalledWith(
      expect.objectContaining({ metric }),
    );
  });
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — rejections", () => {
  /** Drives a rejection case and asserts the code, plus that the reader was never called. */
  async function expectRejected(path: string): Promise<M3LConsoleError> {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/telemetry"),
        buildContext({ path }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(reader.list).not.toHaveBeenCalled();
    return thrown as M3LConsoleError;
  }

  test("rejects a request with no ?granularity= at all", async () => {
    await expectRejected("/api/v1/telemetry");
  });

  test("rejects an unknown ?granularity= value", async () => {
    await expectRejected("/api/v1/telemetry?granularity=week");
  });

  test("rejects an unknown ?metric= value", async () => {
    await expectRejected(
      "/api/v1/telemetry?granularity=minute&metric=bogus.metric",
    );
  });

  test.each([
    ["non-numeric", "abc"],
    ["fractional", "1.5"],
    ["negative", "-1"],
    ["beyond Number.MAX_SAFE_INTEGER", String(Number.MAX_SAFE_INTEGER + 1)],
  ])("rejects a %s ?fromMs=", async (_label, fromMs) => {
    await expectRejected(
      `/api/v1/telemetry?granularity=minute&fromMs=${fromMs}`,
    );
  });

  test("rejects a non-numeric ?toMs=", async () => {
    await expectRejected("/api/v1/telemetry?granularity=minute&toMs=abc");
  });

  test("rejects ?fromMs= greater than ?toMs=", async () => {
    await expectRejected(
      "/api/v1/telemetry?granularity=minute&fromMs=2000&toMs=1000",
    );
  });

  test.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
  ])("rejects a %s ?limit=", async (_label, limit) => {
    await expectRejected(`/api/v1/telemetry?granularity=minute&limit=${limit}`);
  });

  test(`rejects ?limit=${MAX_LIST_LIMIT + 1} (one past the cap)`, async () => {
    await expectRejected(
      `/api/v1/telemetry?granularity=minute&limit=${MAX_LIST_LIMIT + 1}`,
    );
  });

  test("accepts ?limit=MAX_LIST_LIMIT exactly (the cap itself is not rejected)", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });

    await runRoute(
      findRoute(routes, "GET", "/api/v1/telemetry"),
      buildContext({
        path: `/api/v1/telemetry?granularity=minute&limit=${MAX_LIST_LIMIT}`,
      }),
    );

    expect(reader.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_LIST_LIMIT }),
    );
  });

  /**
   * Raw values `Number(...)` coerces successfully but the documented
   * contract (`docs/reference/console.md`: "Positive integer, at most
   * `1000`" / "Non-negative safe integer") never intended to accept —
   * whitespace, a leading `+`, hex/exponent notation, a trailing `.0`, and
   * the two non-finite literals `Number` itself parses. Each raw value is
   * run through `encodeURIComponent` at the call site: `URLSearchParams`
   * (which backs `ctx.query`) decodes an un-encoded `+` as a space and
   * trims un-encoded surrounding whitespace, so encoding is what makes the
   * raw value actually reach `ctx.query.get(...)` unchanged.
   *
   * `"1e400"`, `"Infinity"`, and `"NaN"` are already rejected today (they
   * coerce to a non-finite `Number`, which already fails the existing
   * `Number.isSafeInteger`/`Number.isInteger` checks) — kept here anyway as
   * a standing pin now that a single digit-shape rule is expected to cover
   * all nine cases in one pass, not as a fold-in of a distinct pre-existing
   * gap.
   */
  const DIGIT_SHAPE_REJECTIONS: readonly (readonly [
    label: string,
    raw: string,
  ])[] = [
    ["an empty string", ""],
    ["surrounded by whitespace", " 5 "],
    ["a leading plus sign", "+5"],
    ["hex notation", "0x10"],
    ["exponent notation", "1e3"],
    ["a trailing decimal zero", "1000.0"],
    ["an overflowing exponent", "1e400"],
    ["the literal Infinity", "Infinity"],
    ["the literal NaN", "NaN"],
  ];

  test.each(DIGIT_SHAPE_REJECTIONS)(
    "rejects a ?fromMs= that is %s, and never calls the reader",
    async (_label, raw) => {
      await expectRejected(
        `/api/v1/telemetry?granularity=minute&fromMs=${encodeURIComponent(raw)}`,
      );
    },
  );

  test.each(DIGIT_SHAPE_REJECTIONS)(
    "rejects a ?toMs= that is %s, and never calls the reader",
    async (_label, raw) => {
      await expectRejected(
        `/api/v1/telemetry?granularity=minute&toMs=${encodeURIComponent(raw)}`,
      );
    },
  );

  test.each(DIGIT_SHAPE_REJECTIONS)(
    "rejects a ?limit= that is %s, and never calls the reader",
    async (_label, raw) => {
      await expectRejected(
        `/api/v1/telemetry?granularity=minute&limit=${encodeURIComponent(raw)}`,
      );
    },
  );
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — echoed caller input is truncated", () => {
  test("an over-long unknown ?granularity= value is truncated in the error message, and the full string never appears", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });
    const overlong = "x".repeat(500);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/telemetry"),
        buildContext({
          path: `/api/v1/telemetry?granularity=${overlong}`,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlong);
  });

  test("an over-long unknown ?metric= value is truncated in the error message, and the full string never appears", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });
    const overlong = "y".repeat(500);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/telemetry"),
        buildContext({
          path: `/api/v1/telemetry?granularity=minute&metric=${overlong}`,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlong);
  });

  test("an over-long non-numeric ?limit= value is truncated in the error message, and the full string never appears", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });
    const overlong = "z".repeat(500);

    const thrown = await captureThrown(() =>
      runRoute(
        findRoute(routes, "GET", "/api/v1/telemetry"),
        buildContext({
          path: `/api/v1/telemetry?granularity=minute&limit=${overlong}`,
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).not.toContain(overlong);
  });
});

describe("createTelemetryRoutes — GET /api/v1/telemetry — each query param is read exactly once", () => {
  test("granularity/metric/fromMs/toMs/limit are each read exactly once for a successful request", async () => {
    const reader = buildReader();
    const routes = createTelemetryRoutes({ reader });
    const { ctx, counts } = buildCountingContext({
      granularity: "hour",
      metric: "run.finished",
      fromMs: "1000",
      toMs: "2000",
      limit: "10",
    });

    await runRoute(findRoute(routes, "GET", "/api/v1/telemetry"), ctx);

    for (const key of ["granularity", "metric", "fromMs", "toMs", "limit"]) {
      expect(counts.get(key)).toBe(1);
    }
  });
});

describe("createTelemetryRoutes — vocabulary drift pins", () => {
  // Zone rules restrict src -> tests, never tests -> src, so this test may
  // legally import the store's own RUNTIME vocabulary tables alongside the
  // route module's runtime-value duplicate — comparing against
  // `Object.keys(TELEMETRY_GRANULARITIES)` (an independent source, not a
  // second hand-typed literal copy living in this file) is what makes this
  // pin fail under a plain `vitest run` the day the two sides drift; the
  // `expectTypeOf` pair below pins a DIFFERENT property (the tuple's element
  // TYPE), which only fires under `pnpm typecheck` and never a bare
  // `vitest run`. This test holds the CONTENTS property.
  test("GRANULARITY_VALUES matches store/telemetry-validation's TELEMETRY_GRANULARITIES exactly (drift guard)", () => {
    expect(new Set(GRANULARITY_VALUES)).toEqual(
      new Set(Object.keys(TELEMETRY_GRANULARITIES)),
    );
    expect(GRANULARITY_VALUES).toHaveLength(
      Object.keys(TELEMETRY_GRANULARITIES).length,
    );
  });

  // See the comment above this describe block's first test — same rationale,
  // same "contents, not element type" property, for the metric vocabulary.
  test("METRIC_VALUES matches store/telemetry-validation's TELEMETRY_METRICS exactly (drift guard)", () => {
    expect(new Set(METRIC_VALUES)).toEqual(
      new Set(Object.keys(TELEMETRY_METRICS)),
    );
    expect(METRIC_VALUES).toHaveLength(Object.keys(TELEMETRY_METRICS).length);
  });

  // Zone rules restrict src -> tests, never tests -> src, so this test may
  // legally import the store's own type-level unions alongside the route
  // module's runtime-value duplicates — pinning the DERIVED element type of
  // each exported const array against the store's own type is the strongest
  // guard available here, because the store side is a type, not a runtime
  // value: a future edit to either union (adding/removing a member on
  // either side without updating the other) fails this test at compile
  // time, not merely at the two runtime-set assertions above.
  test("GRANULARITY_VALUES' element type is exactly M3LTelemetryGranularity (type-level drift guard)", () => {
    expectTypeOf<
      (typeof GRANULARITY_VALUES)[number]
    >().toEqualTypeOf<M3LTelemetryGranularity>();
  });

  test("METRIC_VALUES' element type is exactly M3LTelemetryMetric (type-level drift guard)", () => {
    expectTypeOf<
      (typeof METRIC_VALUES)[number]
    >().toEqualTypeOf<M3LTelemetryMetric>();
  });
});
