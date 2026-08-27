/**
 * Tests for src/main.ts — `createConsoleRuntime`, the composition root
 * (m3l-console-server X2a contract). No socket binding, no signal handlers
 * at this slice; the logger is exercised through injected fakes, never the
 * real stdout during a normal test run.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime } from "../src/main.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LRoute } from "../src/http/router.js";

/** A minimal valid env: only the required operator name set. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    ...overrides,
  };
}

/** A recording `M3LLoggerHandler` fake — the sanctioned test-double pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

describe("createConsoleRuntime — resolved config", () => {
  test("returns the config resolved from the injected env", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_PORT: "9090" }),
      handlers: [handler],
    });

    expect(runtime.config).toEqual({
      host: "127.0.0.1",
      port: 9090,
      operatorName: "ada",
      operatorEmail: undefined,
      drainTimeoutMs: 15000,
      logLevel: "info",
    });
  });

  test("returns a Core.M3LLogger instance", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime.logger).toBeInstanceOf(Core.M3LLogger);
  });
});

describe("createConsoleRuntime — posture log line", () => {
  test("a supplied handler receives exactly one info-level posture event", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_PORT: "8080" }),
      handlers: [handler],
    });

    expect(handler.events).toHaveLength(1);
    expect(handler.events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });

  test("the posture event names host, port, operator name, drain timeout, and log level", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({
        M3L_CONSOLE_HOST: "localhost",
        M3L_CONSOLE_PORT: "8080",
        M3L_CONSOLE_OPERATOR_NAME: "grace",
        M3L_CONSOLE_DRAIN_TIMEOUT_MS: "5000",
        M3L_CONSOLE_LOG_LEVEL: "debug",
      }),
      handlers: [handler],
    });

    const [event] = handler.events;
    const rendered = JSON.stringify(event);
    expect(rendered).toContain("localhost");
    expect(rendered).toContain("8080");
    expect(rendered).toContain("grace");
    expect(rendered).toContain("5000");
    expect(rendered).toContain("debug");
  });

  test("never logs the operator email, even when one is configured", () => {
    const handler = new RecordingHandler();

    createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_EMAIL: "ada@example.com" }),
      handlers: [handler],
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("ada@example.com");
  });
});

describe("createConsoleRuntime — logger secrets port (operator email leak regression)", () => {
  // The security review PROVED this leak against a real M3LLogger:
  // `operatorEmail`/`email` is NOT in m3l-common's built-in
  // `SENSITIVE_KEY_NAMES` set, so a later layer doing something as ordinary
  // as `logger.info(msg, { ...runtime.config })` printed the operator's
  // email verbatim before `main.ts` wired a `secrets` port onto the
  // constructed `M3LLogger`. This reproduces that exact call shape through
  // the runtime's own logger, not a fresh one, so it fails if the `secrets`
  // port is ever removed from `createConsoleRuntime`.
  test("redacts the operator email when a caller logs the spread runtime config, while a non-secret field still appears", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_EMAIL: "ada@example.com" }),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered spread", { ...runtime.config });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("ada@example.com");
    expect(rendered).toContain("127.0.0.1");
  });
});

describe("createConsoleRuntime — logger secrets port covers headers/cookie", () => {
  // `M3LRequestContext` now carries `headers` (see tests/context.test.ts).
  // Pinning `isSecret("cookie")`/`isSecret("headers")` indirectly through
  // observable logger output, since `runtimeSecrets` is a module-private
  // const in main.ts, not an exported symbol.
  test("isSecret treats a top-level 'cookie' field as secret, independent of any headers wrapping", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered field", {
      cookie: "TOPLEVEL-COOKIE-CANARY",
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("TOPLEVEL-COOKIE-CANARY");
  });

  test("isSecret treats a top-level 'headers' field as secret, even when its nested keys are otherwise unremarkable", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    runtime.logger.info("caller-triggered field", {
      headers: { pragma: "NO-CACHE-CANARY" },
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain("NO-CACHE-CANARY");
  });
});

describe("createConsoleRuntime — logger secrets port (request-headers leak regression)", () => {
  // MEASURED against a real M3LLogger: redaction recurses and DOES redact a
  // nested `authorization` header (it's in the library's built-in
  // `SENSITIVE_KEY_NAMES`), but `cookie` is NOT in that set and leaked
  // verbatim. Adding `headers` to `M3LRequestContext` therefore makes an
  // ordinary `logger.info(msg, { ...ctx })` print a session cookie in full —
  // the same class of defect as the operator-email leak above, fixed the
  // same structural way: widen `runtimeSecrets` rather than rely on every
  // future call site remembering not to spread `ctx.headers` into a log
  // call. Reproduces the exact call shape through the runtime's own logger,
  // not a fresh one, so it fails if the `secrets` port is ever narrowed.
  test("redacts a nested cookie AND a nested authorization header, while a non-secret sibling field still appears", () => {
    const handler = new RecordingHandler();
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });
    handler.reset();

    const cookieValue = "sid=CANARY-SESSION-COOKIE-1";
    const authValue = "Bearer CANARY-AUTH-TOKEN-2";

    runtime.logger.info("caller-triggered spread of a request context", {
      method: "GET",
      headers: { cookie: cookieValue, authorization: authValue },
    });

    const rendered = JSON.stringify(handler.events);
    expect(rendered).not.toContain(cookieValue);
    expect(rendered).not.toContain(authValue);
    expect(rendered).toContain("GET");
  });
});

describe("createConsoleRuntime — default handler path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("without an explicit handlers option, writes one JSON line to process.stdout via the default M3LJsonLoggerHandler", () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    createConsoleRuntime({ env: buildEnv() });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [written] = writeSpy.mock.calls[0] as [string];
    const parsed: unknown = JSON.parse(written);
    expect(parsed).toMatchObject({ category: "info" });
  });
});

describe("createConsoleRuntime — env option omitted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("resolves configuration from the real process.env when no env option is supplied", () => {
    vi.stubEnv("M3L_CONSOLE_OPERATOR_NAME", "ada");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const runtime = createConsoleRuntime();

    expect(runtime.config.operatorName).toBe("ada");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createConsoleRuntime — config failure propagates", () => {
  test("throws the underlying M3LConsoleError instead of swallowing it, when the operator name is missing", () => {
    expect(() =>
      createConsoleRuntime({
        env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: undefined }),
      }),
    ).toThrow(M3LConsoleError);
  });

  test("never binds a socket or otherwise produces a listening side effect", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime).not.toHaveProperty("server");
    expect(runtime).not.toHaveProperty("close");
  });

  test("registers no process signal handler — process.listenerCount for SIGTERM/SIGINT is unchanged across the call", () => {
    const handler = new RecordingHandler();
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    createConsoleRuntime({ env: buildEnv(), handlers: [handler] });

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });
});

describe("createConsoleRuntime — operator composition", () => {
  test("builds the operator from the resolved config's operatorName/operatorEmail", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({
        M3L_CONSOLE_OPERATOR_NAME: "grace",
        M3L_CONSOLE_OPERATOR_EMAIL: "grace@example.com",
      }),
      handlers: [handler],
    });

    expect(runtime.operator).toEqual({
      name: "grace",
      email: "grace@example.com",
    });
    expect(runtime.operator.name).toBe(runtime.config.operatorName);
    expect(runtime.operator.email).toBe(runtime.config.operatorEmail);
  });

  test("operatorProvider is the single-operator provider, and resolve() returns the same operator profile", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: "ada" }),
      handlers: [handler],
    });

    expect(runtime.operatorProvider.kind).toBe("single-operator");
    expect(runtime.operatorProvider.resolve({})).toEqual(runtime.operator);
  });
});

describe("createConsoleRuntime — routes option reaches the router", () => {
  test("a routes array passed through options is reachable via runtime.router", () => {
    const handler = new RecordingHandler();
    const route: M3LRoute = {
      method: "GET",
      path: "/api/v1/health",
      auth: "exempt",
      handler: () => ({ status: 200, headers: {}, body: "ok" }),
    };

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      routes: [route],
    });

    expect(runtime.router.routes).toEqual([route]);
    expect(runtime.router.lookup("GET", "/api/v1/health")).toMatchObject({
      outcome: "matched",
    });
  });
});

describe("createConsoleRuntime — rejects an auth: 'required' route (no auth middleware wired in yet)", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID when a route declares auth: 'required'", () => {
    const handler = new RecordingHandler();
    const route: M3LRoute = {
      method: "GET",
      path: "/api/v1/runs",
      auth: "required",
      handler: () => ({ status: 200, headers: {}, body: "ok" }),
    };

    expect(() =>
      createConsoleRuntime({
        env: buildEnv(),
        handlers: [handler],
        routes: [route],
      }),
    ).toThrow(M3LConsoleError);

    let thrown: unknown;
    try {
      createConsoleRuntime({
        env: buildEnv(),
        handlers: [handler],
        routes: [route],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect((thrown as M3LConsoleError).message).toContain("GET /api/v1/runs");
  });
});

describe("createConsoleRuntime — drain signal", () => {
  test("runtime.signal is an unaborted AbortSignal at construction", () => {
    const handler = new RecordingHandler();

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
    });

    expect(runtime.signal).toBeInstanceOf(AbortSignal);
    expect(runtime.signal.aborted).toBe(false);
  });
});
