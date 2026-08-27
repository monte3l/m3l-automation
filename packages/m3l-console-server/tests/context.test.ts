/**
 * Tests for src/http/context.ts — `createRequestContext`, `withOperator`,
 * and `withParams` (m3l-console-server X2b contract, wave 1).
 *
 * Security-critical: an inbound `x-correlation-id` flows straight into a log
 * line and a response header, so an unsafe value must be replaced, not
 * echoed — a log-injection and header-splitting vector otherwise.
 */
import { describe, expect, test } from "vitest";

import {
  CORRELATION_ID_HEADER,
  createRequestContext,
  withAccessMode,
  withOperator,
  withParams,
} from "../src/http/context.js";
import type { CreateRequestContextInput } from "../src/http/context.js";
import { errorResponse } from "../src/http/envelope.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LOperatorProfile } from "../src/auth/identity.js";
import type { M3LRouteAuth } from "../src/http/router.js";

/** Builds a minimal valid input, then applies `overrides` on top. */
function buildInput(
  overrides: Partial<CreateRequestContextInput> = {},
): CreateRequestContextInput {
  return {
    method: "GET",
    url: "/api/v1/runs",
    headers: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("CORRELATION_ID_HEADER", () => {
  test("is the literal 'x-correlation-id'", () => {
    expect(CORRELATION_ID_HEADER).toBe("x-correlation-id");
  });
});

describe("createRequestContext — correlation id safety", () => {
  test("reuses a safe inbound correlation id", () => {
    const ctx = createRequestContext(
      buildInput({ headers: { [CORRELATION_ID_HEADER]: "abc-123.def_456" } }),
    );

    expect(ctx.correlationId).toBe("abc-123.def_456");
  });

  test("accepts an inbound correlation id at exactly the 128-character boundary", () => {
    const boundary = "a".repeat(128);

    const ctx = createRequestContext(
      buildInput({ headers: { [CORRELATION_ID_HEADER]: boundary } }),
    );

    expect(ctx.correlationId).toBe(boundary);
  });

  test.each<[string, string]>([
    ["empty string", ""],
    ["contains a space", "a b"],
    ["exceeds the 128-character limit", "a".repeat(129)],
    [
      "contains CRLF (header-splitting / log-injection attempt)",
      "a\r\nX-Injected: 1",
    ],
    ["contains a disallowed character", "abc!"],
  ])(
    "replaces an unsafe inbound correlation id with a minted one (%s)",
    (_label, unsafeValue) => {
      const minted = "minted-safe-id";

      const ctx = createRequestContext(
        buildInput({
          headers: { [CORRELATION_ID_HEADER]: unsafeValue },
          newCorrelationId: () => minted,
        }),
      );

      expect(ctx.correlationId).toBe(minted);
    },
  );

  test("mints a correlation id via the default generator when no header is present and no override is given", () => {
    const ctx = createRequestContext(buildInput({ headers: {} }));

    // Default minting is `randomUUID()` from node:crypto — assert the shape
    // rather than binding this test to a specific implementation.
    expect(ctx.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("mints a fresh id each time an unsafe header is replaced, when no override is supplied", () => {
    const first = createRequestContext(
      buildInput({ headers: { [CORRELATION_ID_HEADER]: "bad header" } }),
    );
    const second = createRequestContext(
      buildInput({ headers: { [CORRELATION_ID_HEADER]: "bad header" } }),
    );

    expect(first.correlationId).not.toBe("bad header");
    expect(first.correlationId).not.toBe(second.correlationId);
  });
});

describe("createRequestContext — method, path, query", () => {
  test("parses method, path, and query string from the input url", () => {
    const ctx = createRequestContext(
      buildInput({
        method: "post",
        url: "/api/v1/runs?limit=10&cursor=abc",
      }),
    );

    expect(ctx.method).toBe("post");
    expect(ctx.path).toBe("/api/v1/runs");
    expect(ctx.query).toBeInstanceOf(URLSearchParams);
    expect(ctx.query.get("limit")).toBe("10");
    expect(ctx.query.get("cursor")).toBe("abc");
  });

  test.each<[string, string]>([
    ["/api/v1/runs/", "/api/v1/runs"],
    ["/", "/"],
    ["/api/v1/runs", "/api/v1/runs"],
  ])(
    "normalizes the parsed path for url %s to %s (trailing slash stripped, except root)",
    (url, expectedPath) => {
      const ctx = createRequestContext(buildInput({ url }));

      expect(ctx.path).toBe(expectedPath);
    },
  );

  test("surfaces a malformed url as ERR_CONSOLE_BAD_REQUEST rather than throwing a raw parse error", () => {
    let thrown: unknown;
    try {
      createRequestContext(buildInput({ url: "http://[invalid" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("the ERR_CONSOLE_BAD_REQUEST message never embeds the raw url (S2 — reflected-input hardening)", () => {
    const rawUrl = "http://[invalid?token=CANARY-SECRET-42";

    let thrown: unknown;
    try {
      createRequestContext(buildInput({ url: rawUrl }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).not.toContain(rawUrl);
    expect((thrown as M3LConsoleError).message).not.toContain(
      "CANARY-SECRET-42",
    );
  });

  test("the raw url never reaches the response body via the error envelope (S2)", () => {
    const rawUrl = "http://[invalid?token=CANARY-SECRET-42";

    let thrown: unknown;
    try {
      createRequestContext(buildInput({ url: rawUrl }));
    } catch (error) {
      thrown = error;
    }

    const response = errorResponse(thrown, "corr-envelope-leak");

    expect(response.body).not.toContain(rawUrl);
    expect(response.body).not.toContain("CANARY-SECRET-42");
  });
});

describe("createRequestContext — defaults", () => {
  test("defaults params to an empty object", () => {
    const ctx = createRequestContext(buildInput());

    expect(ctx.params).toEqual({});
  });

  test("defaults operator to undefined", () => {
    const ctx = createRequestContext(buildInput());

    expect(ctx.operator).toBeUndefined();
  });

  test("defaults accessMode to undefined — a fresh context has not been routed yet", () => {
    const ctx = createRequestContext(buildInput());

    expect(ctx.accessMode).toBeUndefined();
  });

  test("carries through the supplied AbortSignal unchanged", () => {
    const controller = new AbortController();

    const ctx = createRequestContext(buildInput({ signal: controller.signal }));

    expect(ctx.signal).toBe(controller.signal);
  });

  test("uses the injected now() for receivedAt", () => {
    const ctx = createRequestContext(buildInput({ now: () => 12345 }));

    expect(ctx.receivedAt).toBe(12345);
  });

  test("defaults receivedAt to the current time when now is not supplied", () => {
    const before = Date.now();

    const ctx = createRequestContext(buildInput());

    const after = Date.now();
    expect(ctx.receivedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.receivedAt).toBeLessThanOrEqual(after);
  });
});

describe("createRequestContext — headers", () => {
  // Headers were previously discarded after deriving the correlation id.
  // They are now carried on the context so a `preRouting` middleware (e.g.
  // an origin guard reading `Host`/`Origin`) has something to inspect.
  test("exposes the headers it was given", () => {
    const ctx = createRequestContext(
      buildInput({ headers: { host: "127.0.0.1", origin: "http://x" } }),
    );

    expect(ctx.headers).toEqual({ host: "127.0.0.1", origin: "http://x" });
  });

  test("the headers object is frozen", () => {
    const ctx = createRequestContext(
      buildInput({ headers: { host: "127.0.0.1" } }),
    );

    expect(Object.isFrozen(ctx.headers)).toBe(true);
  });

  test("is a copy, not a live alias — mutating the input map afterwards does not change the context's view", () => {
    const input: Record<string, string | undefined> = { host: "127.0.0.1" };

    const ctx = createRequestContext(buildInput({ headers: input }));
    input["host"] = "evil.example";
    input["injected"] = "new-header";

    expect(ctx.headers).toEqual({ host: "127.0.0.1" });
  });

  test("defaults to an empty object rather than undefined when no headers are given", () => {
    const ctx = createRequestContext(buildInput({ headers: {} }));

    expect(ctx.headers).toEqual({});
    expect(ctx.headers).not.toBeUndefined();
  });
});

describe("withOperator", () => {
  test("returns a new frozen context carrying the operator, without mutating the original", () => {
    const ctx = createRequestContext(buildInput());
    const operator: M3LOperatorProfile = { name: "ada", email: undefined };

    const next = withOperator(ctx, operator);

    expect(next).not.toBe(ctx);
    expect(next.operator).toEqual(operator);
    expect(ctx.operator).toBeUndefined();
    expect(Object.isFrozen(next)).toBe(true);
  });

  test("preserves every other field from the original context", () => {
    const ctx = createRequestContext(
      buildInput({ url: "/api/v1/runs?x=1", now: () => 999 }),
    );
    const operator: M3LOperatorProfile = { name: "grace", email: undefined };

    const next = withOperator(ctx, operator);

    expect(next.method).toBe(ctx.method);
    expect(next.path).toBe(ctx.path);
    expect(next.correlationId).toBe(ctx.correlationId);
    expect(next.receivedAt).toBe(999);
  });
});

describe("withParams", () => {
  test("returns a new frozen context carrying params, without mutating the original", () => {
    const ctx = createRequestContext(buildInput());
    const params = { id: "42" };

    const next = withParams(ctx, params);

    expect(next).not.toBe(ctx);
    expect(next.params).toEqual(params);
    expect(ctx.params).toEqual({});
    expect(Object.isFrozen(next)).toBe(true);
  });

  test("preserves an operator already attached by a prior withOperator call", () => {
    const ctx = createRequestContext(buildInput());
    const operator: M3LOperatorProfile = { name: "ada", email: undefined };

    const withOp = withOperator(ctx, operator);
    const withBoth = withParams(withOp, { id: "1" });

    expect(withBoth.operator).toEqual(operator);
    expect(withBoth.params).toEqual({ id: "1" });
  });
});

describe("withAccessMode", () => {
  test.each<M3LRouteAuth>(["required", "exempt"])(
    "returns a new frozen context carrying the access mode (%s), without mutating the original",
    (mode) => {
      const ctx = createRequestContext(buildInput());

      const next = withAccessMode(ctx, mode);

      expect(next).not.toBe(ctx);
      expect(next.accessMode).toBe(mode);
      expect(ctx.accessMode).toBeUndefined();
      expect(Object.isFrozen(next)).toBe(true);
    },
  );

  test("preserves every other field from the original context", () => {
    const ctx = createRequestContext(
      buildInput({ url: "/api/v1/runs?x=1", now: () => 999 }),
    );

    const next = withAccessMode(ctx, "required");

    expect(next.method).toBe(ctx.method);
    expect(next.path).toBe(ctx.path);
    expect(next.correlationId).toBe(ctx.correlationId);
    expect(next.receivedAt).toBe(999);
    expect(next.params).toEqual(ctx.params);
    expect(next.operator).toBe(ctx.operator);
    expect(next.signal).toBe(ctx.signal);
  });

  test("preserves params and operator already attached by prior withParams/withOperator calls", () => {
    const ctx = createRequestContext(buildInput());
    const operator: M3LOperatorProfile = { name: "ada", email: undefined };

    const withOp = withOperator(ctx, operator);
    const withBoth = withParams(withOp, { id: "1" });
    const withAll = withAccessMode(withBoth, "exempt");

    expect(withAll.operator).toEqual(operator);
    expect(withAll.params).toEqual({ id: "1" });
    expect(withAll.accessMode).toBe("exempt");
  });
});
