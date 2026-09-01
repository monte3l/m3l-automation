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
import { applyHumanActionAudit } from "../src/boot/human-action-audit.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createRequestContext,
  withBody,
  withOperator,
  withParams,
} from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleResult } from "../src/http/stream-response.js";
import type { M3LRoute } from "../src/http/router.js";

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
});
