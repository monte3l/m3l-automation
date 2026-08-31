/**
 * Tests for src/http/auth-middleware.ts — `createAuthMiddleware` resolves
 * the operator for a request via an injected `M3LOperatorProvider`, gated
 * by the matched route's `accessMode`. `src/http/auth-middleware.ts` does
 * not exist yet; this suite is RED until implementation lands.
 */
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  M3LOperatorProfile,
  M3LOperatorProvider,
} from "../src/auth/identity.js";
import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import { createAuthMiddleware } from "../src/http/auth-middleware.js";
import { createRequestContext, withAccessMode } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import type { M3LConsoleHandler } from "../src/http/middleware.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";

/** A minimal, deterministic request context for middleware tests. */
function buildContext(): M3LRequestContext {
  return createRequestContext({
    method: "GET",
    url: "/api/v1/runs",
    headers: {},
    signal: new AbortController().signal,
  });
}

/** A trivially valid success response. */
function okResponse(): M3LConsoleResponse {
  return { status: 200, headers: {}, body: "ok" };
}

/**
 * Builds a stub `M3LOperatorProvider` whose `resolve` returns `result`.
 *
 * `resolve` is `Omit`ted from the port and re-declared as the mock's own type
 * so an `expect(provider.resolve)...` assertion reads that mock type. Keeping
 * `M3LOperatorProvider` whole is not enough: since 8.68.0
 * `@typescript-eslint/unbound-method` walks every intersection constituent and
 * reports if *any* of them declares the member with method shorthand, so the
 * port side alone would flag all of these assertions — even though they only
 * inspect the mock and never call it, so no `this`-scoping hazard exists. The
 * mock type is parameterized (not a bare `ReturnType<typeof vi.fn>`) because
 * with the port's own signature `Omit`ted away, nothing else keeps the stub
 * assignable to `M3LOperatorProvider` at the injection site.
 */
function buildProvider(result: M3LOperatorProfile | undefined): Omit<
  M3LOperatorProvider,
  "resolve"
> & {
  resolve: Mock<M3LOperatorProvider["resolve"]>;
} {
  return {
    kind: "test-provider",
    resolve: vi.fn<M3LOperatorProvider["resolve"]>(() => result),
  };
}

describe("createAuthMiddleware — accessMode 'exempt'", () => {
  test("passes through without calling provider.resolve, since a liveness probe must not need a session", async () => {
    const provider = buildProvider({ name: "ada", email: undefined });
    const ctx = withAccessMode(buildContext(), "exempt");
    const handler: M3LConsoleHandler = () => okResponse();

    const middleware = createAuthMiddleware(provider);
    const response = await middleware(ctx, handler);

    expect(provider.resolve).not.toHaveBeenCalled();
    expect(response).toEqual(okResponse());
  });
});

describe("createAuthMiddleware — accessMode 'required', provider resolves", () => {
  test("next receives a context whose operator is the resolved profile, and the original ctx is unmutated", async () => {
    const profile: M3LOperatorProfile = { name: "ada", email: undefined };
    const provider = buildProvider(profile);
    const ctx = withAccessMode(buildContext(), "required");
    let observedOperator: M3LOperatorProfile | undefined;
    const handler: M3LConsoleHandler = (nextCtx) => {
      observedOperator = nextCtx.operator;
      return okResponse();
    };

    const middleware = createAuthMiddleware(provider);
    await middleware(ctx, handler);

    expect(observedOperator).toEqual(profile);
    expect(ctx.operator).toBeUndefined();
  });
});

describe("createAuthMiddleware — accessMode 'required', provider resolves nothing", () => {
  test("throws ERR_CONSOLE_UNAUTHENTICATED and next is not called", async () => {
    const provider = buildProvider(undefined);
    const ctx = withAccessMode(buildContext(), "required");
    let handlerCalls = 0;
    const handler: M3LConsoleHandler = () => {
      handlerCalls += 1;
      return okResponse();
    };

    const middleware = createAuthMiddleware(provider);

    let thrown: unknown;
    try {
      await middleware(ctx, handler);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNAUTHENTICATED",
    );
    expect(handlerCalls).toBe(0);
  });
});

describe("createAuthMiddleware — accessMode undefined (routing has not matched)", () => {
  // A `preRouting` middleware always observes `ctx.accessMode === undefined`
  // (see http/context.ts's `withAccessMode` doc and http/handler.ts's
  // `dispatch`, which only sets `accessMode` after a route has matched).
  // `undefined` therefore cannot be trusted as "exempt" — that would let an
  // unmatched/pre-routing request bypass authentication entirely. Failing
  // closed (treating it the same as "required", not the same as "exempt")
  // is the only safe reading of an unset access mode.
  test("fails closed: treated as not-authenticated-and-not-exempt, so provider.resolve is still consulted", async () => {
    const provider = buildProvider({ name: "ada", email: undefined });
    const ctx = buildContext();
    expect(ctx.accessMode).toBeUndefined();
    const handler: M3LConsoleHandler = () => okResponse();

    const middleware = createAuthMiddleware(provider);
    await middleware(ctx, handler);

    expect(provider.resolve).toHaveBeenCalled();
  });

  test("fails closed: an unresolved provider still throws ERR_CONSOLE_UNAUTHENTICATED rather than passing through", async () => {
    const provider = buildProvider(undefined);
    const ctx = buildContext();
    let handlerCalls = 0;
    const handler: M3LConsoleHandler = () => {
      handlerCalls += 1;
      return okResponse();
    };

    const middleware = createAuthMiddleware(provider);

    let thrown: unknown;
    try {
      await middleware(ctx, handler);
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNAUTHENTICATED",
    );
    expect(handlerCalls).toBe(0);
  });
});
