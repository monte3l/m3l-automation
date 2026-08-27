/**
 * Tests for src/http/origin-guard.ts — `createOriginGuard`
 * (m3l-console-server X2b contract). `src/http/origin-guard.ts` does not
 * exist yet; this suite is RED until implementation lands.
 *
 * DNS-rebinding control: MEASURED against a real `node:http` server on Node
 * v26.7.0, a request carrying `Host: evil.example` reaches the handler with
 * a 200 — Node does nothing about a hostile `Host` header, so this guard is
 * the ONLY control against it. No real sockets are used here; the guard is
 * exercised purely through `M3LRequestContext.headers`.
 */
import { describe, expect, test } from "vitest";

import { createRequestContext } from "../src/http/context.js";
import type { M3LRequestContext } from "../src/http/context.js";
import {
  M3LConsoleError,
  isConsoleError,
} from "../src/errors/console-error.js";
import { createOriginGuard } from "../src/http/origin-guard.js";
import type { M3LConsoleHandler } from "../src/http/middleware.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";

/**
 * Builds a minimal context carrying the given (already lower-cased, as
 * `node:http` produces them) headers.
 */
function buildContext(
  headers: Readonly<Record<string, string | undefined>> = {},
): M3LRequestContext {
  return createRequestContext({
    method: "GET",
    url: "/api/v1/runs",
    headers,
    signal: new AbortController().signal,
  });
}

/** A trivially valid success response, distinguishable by identity. */
function okResponse(): M3LConsoleResponse {
  return { status: 200, headers: { "x-marker": "1" }, body: "ok" };
}

describe("createOriginGuard — Host header, loopback accepted", () => {
  test.each<[string]>([
    ["127.0.0.1"],
    ["127.0.0.1:8787"],
    ["localhost"],
    ["localhost:9000"],
    ["[::1]:8787"],
    ["[::1]"],
    ["127.0.0.2"],
  ])(
    "accepts Host: %s, calling next exactly once and returning its response unchanged",
    async (hostValue) => {
      const guard = createOriginGuard();
      let calls = 0;
      const response = okResponse();
      const next: M3LConsoleHandler = () => {
        calls += 1;
        return response;
      };

      const result = await guard(buildContext({ host: hostValue }), next);

      expect(calls).toBe(1);
      expect(result).toBe(response);
    },
  );
});

describe("createOriginGuard — Host header, non-loopback rejected", () => {
  test.each<[string]>([
    ["evil.example"],
    ["evil.example:8787"],
    ["192.168.1.5"],
    ["0.0.0.0"],
  ])(
    "rejects Host: %s with ERR_CONSOLE_BAD_REQUEST and never calls next",
    async (hostValue) => {
      const guard = createOriginGuard();
      let called = false;
      const next: M3LConsoleHandler = () => {
        called = true;
        return okResponse();
      };

      let thrown: unknown;
      try {
        await guard(buildContext({ host: hostValue }), next);
      } catch (error) {
        thrown = error;
      }

      expect(isConsoleError(thrown)).toBe(true);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(called).toBe(false);
    },
  );
});

describe("createOriginGuard — Host header, malformed port suffix rejected (security audit finding)", () => {
  // MEASURED on a real (unmocked) `node:http` server on Node v26.7.0: both
  // `127.0.0.1:8787.evil.example` and `localhost:80.evil.example` reached the
  // handler with a 200. `extractHostname` split at the LAST colon
  // unconditionally and treated whatever preceded it as the hostname — so
  // `127.0.0.1:8787.evil.example` split into hostname `127.0.0.1` (the
  // `8787.evil.example` port suffix was silently discarded), passing the
  // loopback check even though the authority as a whole names an attacker
  // domain. A port is digits; anything else means the authority is malformed
  // and must fail closed rather than have its bogus "port" silently dropped.
  test.each<[string]>([
    ["127.0.0.1:8787.evil.example"],
    ["localhost:80.evil.example"],
    ["127.0.0.1:80x"],
    ["127.0.0.1:"],
  ])(
    "rejects Host: %s with ERR_CONSOLE_BAD_REQUEST rather than treating the malformed suffix as a droppable port",
    async (hostValue) => {
      const guard = createOriginGuard();
      let called = false;
      const next: M3LConsoleHandler = () => {
        called = true;
        return okResponse();
      };

      let thrown: unknown;
      try {
        await guard(buildContext({ host: hostValue }), next);
      } catch (error) {
        thrown = error;
      }

      expect(isConsoleError(thrown)).toBe(true);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(called).toBe(false);
    },
  );
});

describe("createOriginGuard — the bound port is deliberately not compared", () => {
  // Under ADR-0071 the console runs behind compose, and a published-to-
  // container port remap (e.g. `9000:8787`) would otherwise reject every
  // legitimate request. The hostname is the entire rebinding defence; an
  // attacker who can reach the listener already knows its port, so
  // comparing it buys nothing.
  test("accepts Host: localhost:9000 even though the guard has no notion of which port the server actually bound", async () => {
    const guard = createOriginGuard();
    const response = okResponse();
    const next: M3LConsoleHandler = () => response;

    const result = await guard(buildContext({ host: "localhost:9000" }), next);

    expect(result).toBe(response);
  });
});

describe("createOriginGuard — Host header absent", () => {
  test("rejects a request with no Host header, without throwing a raw TypeError", async () => {
    const guard = createOriginGuard();
    const next: M3LConsoleHandler = () => okResponse();

    let thrown: unknown;
    try {
      await guard(buildContext({}), next);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

describe("createOriginGuard — Origin header absent", () => {
  test("allows a loopback request that omits Origin entirely (curl / same-origin navigations)", async () => {
    const guard = createOriginGuard();
    const response = okResponse();
    const next: M3LConsoleHandler = () => response;

    const result = await guard(buildContext({ host: "127.0.0.1:8787" }), next);

    expect(result).toBe(response);
  });
});

describe("createOriginGuard — Origin header, loopback accepted", () => {
  test.each<[string]>([["http://localhost:5173"], ["http://127.0.0.1:8787"]])(
    "accepts a loopback Host alongside Origin: %s",
    async (originValue) => {
      const guard = createOriginGuard();
      const response = okResponse();
      const next: M3LConsoleHandler = () => response;

      const result = await guard(
        buildContext({ host: "127.0.0.1:8787", origin: originValue }),
        next,
      );

      expect(result).toBe(response);
    },
  );
});

describe("createOriginGuard — Origin header, non-loopback rejected", () => {
  test("rejects Origin: https://evil.example even though Host is loopback", async () => {
    const guard = createOriginGuard();
    let called = false;
    const next: M3LConsoleHandler = () => {
      called = true;
      return okResponse();
    };

    let thrown: unknown;
    try {
      await guard(
        buildContext({
          host: "127.0.0.1:8787",
          origin: "https://evil.example",
        }),
        next,
      );
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(called).toBe(false);
  });
});

describe('createOriginGuard — Origin: "null" is the literal three-character string, not a nullish value', () => {
  // A truthiness check on `ctx.headers.origin` (`if (origin) { ... }`) would
  // treat the literal string `"null"` as present-and-non-empty and then fail
  // to parse it as a loopback URL, OR — worse — a check written the other
  // way (`if (!origin) return allow`) followed by a naive falsy-origin
  // shortcut could wave it through outright. Either way this is the
  // sandboxed/`file://`-origin rebinding case and MUST be rejected.
  test('rejects Origin: "null" rather than treating it as absent', async () => {
    const guard = createOriginGuard();
    let called = false;
    const next: M3LConsoleHandler = () => {
      called = true;
      return okResponse();
    };

    let thrown: unknown;
    try {
      await guard(
        buildContext({ host: "127.0.0.1:8787", origin: "null" }),
        next,
      );
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(called).toBe(false);
  });
});

describe("createOriginGuard — Origin header that does not parse as a URL", () => {
  test("rejects an unparseable Origin rather than silently ignoring it", async () => {
    const guard = createOriginGuard();
    let called = false;
    const next: M3LConsoleHandler = () => {
      called = true;
      return okResponse();
    };

    let thrown: unknown;
    try {
      await guard(
        buildContext({ host: "127.0.0.1:8787", origin: "not a url" }),
        next,
      );
    } catch (error) {
      thrown = error;
    }

    expect(isConsoleError(thrown)).toBe(true);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(called).toBe(false);
  });
});

describe("createOriginGuard — rejection message never echoes the offending header value", () => {
  test.each<[string, Readonly<Record<string, string | undefined>>]>([
    ["Host", { host: "evil.example" }],
    ["Origin", { host: "127.0.0.1", origin: "https://evil.example" }],
  ])(
    "the %s rejection's error.message omits the raw header value",
    async (_label, headers) => {
      const guard = createOriginGuard();
      const next: M3LConsoleHandler = () => okResponse();

      let thrown: unknown;
      try {
        await guard(buildContext(headers), next);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).message).not.toContain("evil.example");
    },
  );
});
