/**
 * Tests for `boot/human-action-audit`'s GATE behaviour (X7b, ADR-0070):
 * the record-before-act ordering, refusal when the trail is unwritable,
 * compensation after a thrown handler, and the boot-time exhaustiveness
 * guard that pays for moving the audit decision out of the route modules.
 *
 * Per-route projection lives in the sibling
 * `boot-human-action-projection.test.ts`; this file is about WHEN an entry is
 * written and what happens when writing fails.
 *
 * @packageDocumentation
 */

import { describe, expect, test, vi } from "vitest";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import {
  applyHumanActionAudit,
  assertHumanActionSpecsAreLive,
} from "../src/boot/human-action-audit.js";
import {
  HUMAN_ACTION_SPECS,
  humanActionSpecKey,
} from "../src/boot/human-action-specs.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createRequestContext,
  withBody,
  withOperator,
  withParams,
} from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { createBuiltInRoutes } from "../src/http/routes/built-in.js";
import type {
  M3LRunLauncherPort,
  M3LRunReaderPort,
  M3LRunReportPort,
} from "../src/http/routes/runs.js";
import type { M3LRunStreamRegistryPort } from "../src/http/routes/run-stream.js";
import type { M3LScriptCatalogPort } from "../src/http/routes/scripts.js";
import type {
  SessionRouteReaderPort,
  SessionRouteWriterPort,
} from "../src/http/routes/sessions.js";
import type { M3LTelemetryReaderPort } from "../src/http/routes/telemetry.js";
import type { M3LConsoleResult } from "../src/http/stream-response.js";
import type { M3LRoute } from "../src/http/router.js";
import { createDrainController } from "../src/lifecycle/drain.js";
import { createEventStreamHub } from "../src/stream/event-stream.js";

/** A recording port; `failWith` makes every write reject. */
function createFakePort(failWith?: Error): M3LHumanActionAuditPort & {
  readonly records: M3LHumanActionRecord[];
} {
  const records: M3LHumanActionRecord[] = [];
  return {
    records,
    record(record: M3LHumanActionRecord): Promise<void> {
      records.push(record);
      return failWith === undefined
        ? Promise.resolve()
        : Promise.reject(failWith);
    },
  };
}

/** A port whose FIRST write succeeds and whose second (compensating) write fails. */
function createPortFailingOnCompensation(failWith: Error): {
  readonly port: M3LHumanActionAuditPort;
  readonly records: M3LHumanActionRecord[];
} {
  const records: M3LHumanActionRecord[] = [];
  return {
    records,
    port: {
      record(record: M3LHumanActionRecord): Promise<void> {
        records.push(record);
        return records.length === 1
          ? Promise.resolve()
          : Promise.reject(failWith);
      },
    },
  };
}

const OK: M3LConsoleResult = { status: 200, headers: {}, body: "ok" };

/** A `POST /api/v1/runs` context carrying `body` and a resolved operator. */
function launchContext(body: unknown): M3LRequestContext {
  const base = createRequestContext({
    method: "POST",
    url: "http://127.0.0.1/api/v1/runs",
    headers: { "x-correlation-id": "corr-1" },
    signal: new AbortController().signal,
  });
  return withBody(
    withOperator(withParams(base, {}), {
      name: "ada",
      email: "ada@example.invalid",
    }),
    body,
  );
}

/**
 * Invokes a decorated handler and returns whatever it threw, or `undefined`.
 *
 * `M3LConsoleHandler` may return a value OR a promise, so the result is
 * awaited rather than `.catch`ed — a decorated handler is always async, but
 * the TYPE is the union and the test must honour it.
 */
async function invokeAndCatch(
  route: M3LRoute | undefined,
  ctx: M3LRequestContext,
): Promise<unknown> {
  if (route === undefined) throw new Error("route was not decorated");
  try {
    await route.handler(ctx);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The one audited route these tests drive, with a caller-supplied handler. */
function launchRoute(handler: M3LRoute["handler"]): M3LRoute {
  return { method: "POST", path: "/api/v1/runs", auth: "required", handler };
}

const VALID_BODY = {
  scriptName: "sqs-etl",
  confirmed: true,
  dryRun: false,
  parameters: { queueUrl: "https://sqs.example.invalid/q" },
};

describe("ordering: the entry is written before the action", () => {
  // INVARIANT: a store mutation cannot be undone by a later failed append, so
  // recording FIRST is the only ordering that satisfies ADR-0070's "an
  // unauditable action is refused". Mutation-tested: moving the record after
  // the handler makes this fail.
  test("records before calling the handler", async () => {
    const order: string[] = [];
    const port: M3LHumanActionAuditPort = {
      record: () => {
        order.push("record");
        return Promise.resolve();
      },
    };
    const [route] = applyHumanActionAudit(
      [
        launchRoute(() => {
          order.push("handler");
          return OK;
        }),
      ],
      port,
    );

    await invokeAndCatch(route, launchContext(VALID_BODY));

    expect(order).toEqual(["record", "handler"]);
  });

  test("a rejected append refuses the action — the handler never runs", async () => {
    const handler = vi.fn(() => OK);
    const failure = new M3LConsoleError(
      "ERR_CONSOLE_AUDIT_WRITE_FAILED",
      "trail unwritable",
    );
    const [route] = applyHumanActionAudit(
      [launchRoute(handler)],
      createFakePort(failure),
    );

    expect(await invokeAndCatch(route, launchContext(VALID_BODY))).toBe(
      failure,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ["ERR_CONSOLE_AUDIT_WRITE_FAILED", "a 503 retryable"],
    ["ERR_CONSOLE_AUDIT_RECORD_INVALID", "a 400 caller fault"],
  ] as const)(
    "propagates %s unchanged so the envelope maps it (%s)",
    async (code, _shape) => {
      // No new status code is needed: `http/envelope.ts` already maps both.
      const failure = new M3LConsoleError(code, "audit failure");
      const [route] = applyHumanActionAudit(
        [launchRoute(() => OK)],
        createFakePort(failure),
      );

      const thrown = await invokeAndCatch(route, launchContext(VALID_BODY));

      expect(thrown).toBe(failure);
      expect((thrown as M3LConsoleError).code).toBe(code);
    },
  );
});

describe("compensation after a thrown handler", () => {
  test.each([
    ["ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED", "denied"],
    ["ERR_CONSOLE_RUN_CAPACITY_EXCEEDED", "rejected"],
    ["ERR_CONSOLE_BAD_REQUEST", "failed"],
  ] as const)("maps %s onto outcome %s", async (code, outcome) => {
    const domainError = new M3LConsoleError(code, "domain failure");
    const port = createFakePort();
    const [route] = applyHumanActionAudit(
      [
        launchRoute(() => {
          throw domainError;
        }),
      ],
      port,
    );

    expect(await invokeAndCatch(route, launchContext(VALID_BODY))).toBe(
      domainError,
    );
    expect(port.records).toHaveLength(2);
    expect(port.records[0]?.outcome).toBe("allowed");
    expect(port.records[1]?.outcome).toBe(outcome);
  });

  test("a non-console error compensates as failed", async () => {
    const domainError = new Error("something else");
    const port = createFakePort();
    const [route] = applyHumanActionAudit(
      [
        launchRoute(() => {
          throw domainError;
        }),
      ],
      port,
    );

    expect(await invokeAndCatch(route, launchContext(VALID_BODY))).toBe(
      domainError,
    );
    expect(port.records[1]?.outcome).toBe("failed");
  });

  // INVARIANT: a failure to record a failure must never REPLACE the error the
  // operator needs. The compensating write's own failure is chained onto the
  // domain error, and the domain error is what propagates.
  test("a failed compensating write chains onto, and never replaces, the domain error", async () => {
    const domainError = new M3LConsoleError(
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
      "at capacity",
    );
    const auditFailure = new M3LConsoleError(
      "ERR_CONSOLE_AUDIT_WRITE_FAILED",
      "trail unwritable",
    );
    const { port } = createPortFailingOnCompensation(auditFailure);
    const [route] = applyHumanActionAudit(
      [
        launchRoute(() => {
          throw domainError;
        }),
      ],
      port,
    );

    const thrown = await invokeAndCatch(route, launchContext(VALID_BODY));

    expect(thrown).toBe(domainError);
    expect((thrown as Error).cause).toBe(auditFailure);
  });
});

describe("the boot-time exhaustiveness guard", () => {
  // This is what pays for moving the audit decision out of the route
  // modules: an unaudited write route cannot ship.
  test("a write route with no spec throws at composition", () => {
    expect(() =>
      applyHumanActionAudit(
        [
          {
            method: "POST",
            path: "/api/v1/unspecified",
            auth: "required",
            handler: () => OK,
          },
        ],
        createFakePort(),
      ),
    ).toThrow(M3LConsoleError);
  });

  test.each(["PATCH", "PUT", "DELETE"])(
    "%s with no spec throws too — the guard is not POST-only",
    (method) => {
      expect(() =>
        applyHumanActionAudit(
          [
            {
              method,
              path: "/api/v1/whatever",
              auth: "required",
              handler: () => OK,
            },
          ],
          createFakePort(),
        ),
      ).toThrow(/no human-action audit spec/u);
    },
  );

  test("a GET with no spec passes through untouched", async () => {
    const handler = vi.fn(() => OK);
    const port = createFakePort();
    const [route] = applyHumanActionAudit(
      [{ method: "GET", path: "/api/v1/runs", auth: "required", handler }],
      port,
    );

    await invokeAndCatch(route, launchContext(undefined));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(port.records).toHaveLength(0);
  });
});

describe("the boot-time reconciliation (X8a)", () => {
  /**
   * Every `HUMAN_ACTION_SPECS` key, hand-typed to keep T1-T6 independent of
   * the real table's contents — only T7 reconciles against the real thing.
   */
  const ALL_HUMAN_ACTION_ROUTE_SIGNATURES: readonly {
    readonly method: string;
    readonly path: string;
  }[] = [
    { method: "POST", path: "/api/v1/runs" },
    { method: "POST", path: "/api/v1/runs/:id/cancel" },
    { method: "GET", path: "/api/v1/runs/:id/report" },
    { method: "GET", path: "/api/v1/runs/:id/stream" },
    { method: "POST", path: "/api/v1/sessions" },
    { method: "POST", path: "/api/v1/sessions/:id/steps" },
    { method: "POST", path: "/api/v1/sessions/:id/bindings" },
    // X13 Round B.
    { method: "POST", path: "/api/v1/sessions/:id/flow-export" },
    { method: "POST", path: "/api/v1/sessions/:id/steps/:stepId/decision" },
    { method: "POST", path: "/api/v1/sessions/:id/decisions/:decisionId" },
    { method: "POST", path: "/api/v1/sessions/:id/close" },
    { method: "POST", path: "/api/v1/sessions/:id/reopen" },
    { method: "GET", path: "/api/v1/sessions/:id/steps/:stepId/artifact" },
  ];

  /** Builds an `M3LRoute[]` from method/path signatures, each a no-op handler. */
  function routesFor(
    signatures: readonly { readonly method: string; readonly path: string }[],
  ): M3LRoute[] {
    return signatures.map(({ method, path }) => ({
      method,
      path,
      auth: "required",
      handler: () => OK,
    }));
  }

  /** Every signature in {@link ALL_HUMAN_ACTION_ROUTE_SIGNATURES} except `omit`. */
  function allExcept(
    omit: readonly { readonly method: string; readonly path: string }[],
  ): { readonly method: string; readonly path: string }[] {
    return ALL_HUMAN_ACTION_ROUTE_SIGNATURES.filter(
      (signature) =>
        !omit.some(
          (o) => o.method === signature.method && o.path === signature.path,
        ),
    );
  }

  // MUTATION KILLED: dropping the space in the key grammar (or swapping
  // method/path order) would still let T7 pass, since it only compares
  // `humanActionSpecKey` outputs against themselves via a `Set` — this pins
  // the literal format independently.
  test("humanActionSpecKey formats method and path as `METHOD path`", () => {
    expect(humanActionSpecKey({ method: "POST", path: "/api/v1/runs" })).toBe(
      "POST /api/v1/runs",
    );
  });

  // MUTATION KILLED: deleting the "any key not present is an orphan"
  // collection — a fully-covering table with exactly one key omitted must
  // throw, and the thrown message must name that one key.
  test("T1: a table missing exactly one specced route throws, naming it", () => {
    const routes = routesFor(
      allExcept([{ method: "POST", path: "/api/v1/runs/:id/cancel" }]),
    );

    expect(() =>
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: true }),
    ).toThrow(M3LConsoleError);

    let thrown: unknown;
    try {
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toMatch(
      /POST \/api\/v1\/runs\/:id\/cancel/u,
    );
  });

  // MUTATION KILLED: deleting the `!wiring.runs || !wiring.sessions` early
  // return. `http/routes/built-in.ts`'s own "no registered-but-always-404
  // middle state" guarantee (BuiltInRouteOptions.runs/.sessions TSDoc) means
  // a partially-wired console legitimately registers only a SUBSET of the
  // twelve keys — this is what stops the check from refusing to boot every
  // console that has neither run orchestration nor the session workbench
  // wired. A health-only table, with neither group wired, must not throw
  // even though none of the twelve keys are present.
  test("T2: neither runs nor sessions wired — a health-only table does not throw", () => {
    const routes: M3LRoute[] = [
      { method: "GET", path: "/health", auth: "exempt", handler: () => OK },
    ];

    expect(() =>
      assertHumanActionSpecsAreLive(routes, { runs: false, sessions: false }),
    ).not.toThrow();
  });

  // MUTATION KILLED: narrowing the per-key group check (`humanActionSpecGroup`)
  // back to an all-or-nothing `!wiring.runs || !wiring.sessions` gate — a
  // console with run orchestration but no session workbench must not throw
  // over the eight sessions-group keys it never registers, even though
  // reconciliation is now genuinely PER-GROUP rather than short-circuited
  // entirely. (This test alone cannot distinguish "correctly skips the
  // unwired group" from "skips everything" — T3b below is the one that
  // does; both must pass.)
  test("T3: only runs wired — the four runs-group routes alone do not throw", () => {
    const routes = routesFor(
      ALL_HUMAN_ACTION_ROUTE_SIGNATURES.filter((signature) =>
        signature.path.startsWith("/api/v1/runs"),
      ),
    );

    expect(() =>
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: false }),
    ).not.toThrow();
  });

  // MUTATION KILLED (and the whole point of the per-group fix over T3 alone):
  // reverting to the all-or-nothing `!wiring.runs || !wiring.sessions) return`
  // early return — under that OLD contract, a `runs`-only console missing one
  // of its own four runs-group routes never threw, because `sessions: false`
  // alone short-circuited the entire check. Reconciliation is now PER-GROUP,
  // so a `runs`-only console must still be held to its OWN wired group, with
  // the eight (entirely absent) sessions-group keys correctly skipped.
  test("T3b: only runs wired, missing one runs-group route, throws (sessions stays unchecked)", () => {
    const routes = routesFor(
      ALL_HUMAN_ACTION_ROUTE_SIGNATURES.filter(
        (signature) =>
          signature.path.startsWith("/api/v1/runs") &&
          !(
            signature.method === "POST" &&
            signature.path === "/api/v1/runs/:id/cancel"
          ),
      ),
    );

    let thrown: unknown;
    try {
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: false });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toMatch(
      /POST \/api\/v1\/runs\/:id\/cancel/u,
    );
  });

  // Symmetric to T3b, proving the per-group fix is not runs-only-biased: a
  // `sessions`-only console missing one of its own eight sessions-group
  // routes must throw too, with the four (entirely absent) runs-group keys
  // correctly skipped.
  test("T3c: only sessions wired, missing one sessions-group route, throws (runs stays unchecked)", () => {
    const routes = routesFor(
      ALL_HUMAN_ACTION_ROUTE_SIGNATURES.filter(
        (signature) =>
          signature.path.startsWith("/api/v1/sessions") &&
          !(
            signature.method === "POST" &&
            signature.path === "/api/v1/sessions/:id/reopen"
          ),
      ),
    );

    let thrown: unknown;
    try {
      assertHumanActionSpecsAreLive(routes, { runs: false, sessions: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toMatch(
      /POST \/api\/v1\/sessions\/:id\/reopen/u,
    );
  });

  // MUTATION KILLED: scoping the reconciliation to non-GET routes only — the
  // OLD `applyHumanActionAudit` guard's own shape, which only ever throws for
  // a non-GET route with no spec entry. This is exactly the case that old
  // guard could never catch: a GET view route (`view.run.report`) silently
  // missing its spec passed straight through, unaudited, with no boot-time
  // signal at all.
  test("T4: a table missing a GET view spec (view.run.report) throws", () => {
    const routes = routesFor(
      allExcept([{ method: "GET", path: "/api/v1/runs/:id/report" }]),
    );

    expect(() =>
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: true }),
    ).toThrow(M3LConsoleError);
  });

  // MUTATION KILLED: moving the throw INSIDE the collection loop (throwing
  // on the first orphan found, rather than after collecting every orphan) —
  // this table omits TWO specced routes and must surface BOTH in the SAME,
  // single thrown error, not fail on the first and never mention the second.
  test("T5: a table missing two specced routes throws ONE error naming both", () => {
    const routes = routesFor(
      allExcept([
        { method: "POST", path: "/api/v1/sessions/:id/close" },
        { method: "POST", path: "/api/v1/sessions/:id/reopen" },
      ]),
    );

    let thrown: unknown;
    try {
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).toMatch(/POST \/api\/v1\/sessions\/:id\/close/u);
    expect(message).toMatch(/POST \/api\/v1\/sessions\/:id\/reopen/u);
  });

  // MUTATION KILLED: a message regression that drops the "fix it here" file
  // reference — the thrown message must always point at
  // boot/human-action-specs.ts, the one file an orphaned spec is fixed in.
  test("T6: the thrown message names boot/human-action-specs.ts as the file to fix", () => {
    const routes = routesFor(
      allExcept([{ method: "POST", path: "/api/v1/runs/:id/cancel" }]),
    );

    let thrown: unknown;
    try {
      assertHumanActionSpecsAreLive(routes, { runs: true, sessions: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toMatch(
      /boot\/human-action-specs\.ts/u,
    );
  });

  // Fixtures below are COPIED (not imported — this repo's test rule
  // duplicates fixtures per file) from `routes-built-in.test.ts`'s
  // fully-wired fixture (~lines 405-447): fake orchestrator/registry/hub/
  // catalog/reportReader/sessionService/telemetryReader, plus a real
  // `createDrainController`.
  const fixtureLaunchHandle = {
    id: "run-1",
    scriptName: "sqs-etl",
    status: "running" as const,
    dryRun: false,
    executionMode: "spawn",
  };
  const fakeOrchestrator: M3LRunLauncherPort = {
    cancel: () => true,
    launch: () => fixtureLaunchHandle,
  };
  const fakeRegistry: M3LRunReaderPort & M3LRunStreamRegistryPort = {
    list: () => [],
    get: () => undefined,
  };
  const fakeCatalog: M3LScriptCatalogPort = {
    list: () => [],
    describe: () => Promise.resolve({}),
  };
  const fakeReportReader: M3LRunReportPort = {
    read: () => Promise.resolve(undefined),
  };
  // X13 Round B COORDINATION NOTE: once `SessionRouteWriterPort` gains its
  // new `exportFlow` method (and `createSessionFlowExportRoutes` is wired
  // into `buildSessionRoutes` in `http/routes/built-in.ts`), T7 below will
  // need this fixture to grow an `exportFlow` implementation too — that
  // cannot be pre-added here now: with the interface as it stands today, an
  // extra `exportFlow` key on this object literal is an excess-property
  // TS2353 error unrelated to any not-yet-existing module, which the RED
  // discipline forbids introducing ahead of time. Whoever lands the
  // `SessionRouteWriterPort` interface change must add `exportFlow` to this
  // fixture in the SAME pass, or this file stops compiling.
  const fakeSessionService: SessionRouteReaderPort & SessionRouteWriterPort = {
    getSession: () => undefined,
    listSessions: () => [],
    readStepArtifact: () => Promise.resolve(undefined),
    selectBinding: () => Promise.resolve({ id: "binding-1" }),
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
    listStepsForSession: () => [],
    listDecisionsForSession: () => [],
    exportFlow: () =>
      Promise.resolve({
        name: "x",
        yaml: "",
        steps: [],
        decisionsDropped: 0,
        path: "/x",
      }),
  };
  const fakeTelemetryReader: M3LTelemetryReaderPort = {
    list: () => [],
  };

  /** Builds the console's REAL, fully-wired built-in route table. */
  function buildRealRoutes(): readonly M3LRoute[] {
    const drain = createDrainController({ timeoutMs: 15_000 });
    const hub = createEventStreamHub<{ event: string }>({ bufferSize: 10 });
    return createBuiltInRoutes({
      drain,
      startedAt: Date.now(),
      routes: [],
      runs: {
        orchestrator: fakeOrchestrator,
        registry: fakeRegistry,
        hub,
        catalog: fakeCatalog,
        reportReader: fakeReportReader,
      },
      sessions: { reader: fakeSessionService, writer: fakeSessionService },
      telemetry: fakeTelemetryReader,
    });
  }

  // MUTATION KILLED: any real spec-key typo in `human-action-specs.ts` (a
  // stray `:id` vs a differently-named param, a trailing slash, a wrong
  // method) — this is the only test in the suite that reconciles against the
  // REAL route table `createBuiltInRoutes` produces, not a hand-typed
  // stand-in, so it is the one that makes the fix actually complete.
  test("T7: the real, fully-wired route table covers every HUMAN_ACTION_SPECS key", () => {
    const realRoutes = buildRealRoutes();
    // `humanActionSpecKey` — the PRODUCTION helper, not a re-inlined
    // template literal — is load-bearing here: it must be the exact same key
    // grammar `HUMAN_ACTION_SPECS` is keyed by, or this check could pass
    // while the real `assertHumanActionSpecsAreLive` call below still throws.
    const registeredKeys = new Set(realRoutes.map(humanActionSpecKey));

    const orphans = [...HUMAN_ACTION_SPECS.keys()].filter(
      (key) => !registeredKeys.has(key),
    );

    expect(orphans).toEqual([]);
    expect(() =>
      assertHumanActionSpecsAreLive(realRoutes, {
        runs: true,
        sessions: true,
      }),
    ).not.toThrow();
  });
});

describe("what a record may never carry", () => {
  // The whole point of the trail: parameter NAMES, never values. The value is
  // assembled at runtime from split literals so it cannot be matched by a
  // secret scanner or spotted by eye in the fixture — the same technique
  // `tests/diagnostics-run-report.test.ts` uses.
  test("the record carries parameter names but no parameter value", async () => {
    const secret = ["AKIA", "EXAMPLE", "NOTREAL"].join("");
    const port = createFakePort();
    const [route] = applyHumanActionAudit([launchRoute(() => OK)], port);

    await invokeAndCatch(
      route,
      launchContext({
        ...VALID_BODY,
        parameters: { accessKeyId: secret, queueUrl: "https://q.invalid" },
      }),
    );

    const serialized = JSON.stringify(port.records[0]);
    expect(port.records[0]?.parameterNames).toEqual([
      "accessKeyId",
      "queueUrl",
    ]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("https://q.invalid");
  });

  test("the record carries the request's operator and correlation id", async () => {
    const port = createFakePort();
    const [route] = applyHumanActionAudit([launchRoute(() => OK)], port);

    await invokeAndCatch(route, launchContext(VALID_BODY));

    expect(port.records[0]?.operator).toBe("ada");
    expect(port.records[0]?.operatorEmailDeclared).toBe(true);
    expect(port.records[0]?.correlationId).toBe("corr-1");
  });

  // INVARIANT: an audited route is `auth: "required"`, so reaching one with no
  // resolved operator is a wiring defect, not a caller fault — it must fail
  // loudly as ERR_CONSOLE_INTERNAL rather than record an unattributed entry.
  // Mutation-tested: dropping `operatorOf`'s guard makes this pass an
  // undefined operator into `humanActionRecordFrom` instead of throwing here.
  test("refuses an audited route reached with no resolved operator", async () => {
    const port = createFakePort();
    const [route] = applyHumanActionAudit([launchRoute(() => OK)], port);

    const thrown = await invokeAndCatch(
      route,
      withBody(
        withParams(
          createRequestContext({
            method: "POST",
            url: "http://127.0.0.1/api/v1/runs",
            headers: { "x-correlation-id": "corr-1" },
            signal: new AbortController().signal,
          }),
          {},
        ),
        VALID_BODY,
      ),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect((thrown as M3LConsoleError).message).toContain("POST /api/v1/runs");
    expect(port.records).toHaveLength(0);
  });
});
