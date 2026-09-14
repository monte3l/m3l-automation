// Tests for src/main.ts (V10b, ADR-0062): createM3LMcpServer,
// startM3LMcpServer, and the INSTRUCTIONS string.
//
// Mirrors bin/tests/mcp-server.test.ts's approach: mock the two
// `@modelcontextprotocol/sdk` subpaths this module imports, with the mocked
// `McpServer` constructor returning a stub `{ registerTool, connect }`
// object. This proves both "createM3LMcpServer connects no transport" and
// "startM3LMcpServer calls connect exactly once" without touching real
// stdio and without needing to widen `M3LMcpServerDeps` with an extra
// injectable `connect`/transport field — mocking the SDK constructors is
// sufficient to observe both calls.
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { GatedToolRegistration } from "../src/tools/registry.js";

const h = vi.hoisted(() => {
  const registerTool = vi.fn();
  const connect = vi.fn((_transport: unknown) => Promise.resolve());
  const McpServerCtor = vi.fn(function (
    this: unknown,
    _serverInfo: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ) {
    return { registerTool, connect };
  });
  const StdioServerTransportCtor = vi.fn();
  return { registerTool, connect, McpServerCtor, StdioServerTransportCtor };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: h.McpServerCtor,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: h.StdioServerTransportCtor,
}));

import {
  createM3LMcpServer,
  INSTRUCTIONS,
  startM3LMcpServer,
  type M3LMcpServerDeps,
  type M3LMcpServerHandle,
} from "../src/main.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";

describe("INSTRUCTIONS", () => {
  test("is a non-empty string", () => {
    expect(typeof INSTRUCTIONS).toBe("string");
    expect(INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  test("mentions this is the runtime/fleet surface, distinguishing it from the dev-time server", () => {
    // A substring check, never the whole string — the exact wording is an
    // implementation detail, only the disambiguating content matters (README
    // "This is not bin/mcp-server.mjs").
    expect(INSTRUCTIONS.toLowerCase()).toContain("fleet");
  });
});

describe("createM3LMcpServer", () => {
  beforeEach(() => {
    // clearAllMocks (not resetAllMocks/mockReset) — preserves McpServerCtor's
    // baked-in implementation (the stub-object return) while dropping the
    // prior test's call history, matching bin/tests/mcp-server.test.ts's
    // documented reasoning for the same mock shape.
    vi.clearAllMocks();
  });

  test("registers exactly TOOL_REGISTRY.length tools with the real (empty) registry", () => {
    createM3LMcpServer();

    expect(h.registerTool).toHaveBeenCalledTimes(TOOL_REGISTRY.length);
    expect(TOOL_REGISTRY.length).toBe(0);
  });

  test("registers every entry of an injected registry", () => {
    // `as unknown as GatedToolRegistration[]` forges the brand
    // `src/tools/registry.ts` deliberately makes unforgeable (the brand
    // symbol is unexported, and no producer exists yet — `gateTool` ships
    // in slice V10c). Unavoidable here: this test needs a registry shaped
    // like the real thing without going through a producer that doesn't
    // exist yet. Goes away the moment `gateTool` lands.
    const fakeRegistry = [
      {
        name: "tool_one",
        config: {
          title: "Tool One",
          description: "does the first thing",
          annotations: { readOnlyHint: true },
        },
        handler: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
      {
        name: "tool_two",
        config: {
          title: "Tool Two",
          description: "does the second thing",
          annotations: { readOnlyHint: false },
        },
        handler: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
    ] as unknown as GatedToolRegistration[];

    createM3LMcpServer({ registry: fakeRegistry });

    expect(h.registerTool).toHaveBeenCalledTimes(2);
    const registeredNames = h.registerTool.mock.calls.map(
      (call) => (call as [string, unknown, unknown])[0],
    );
    expect(registeredNames).toEqual(["tool_one", "tool_two"]);
  });

  test("connects no transport — construction alone must not touch stdio", () => {
    createM3LMcpServer();

    expect(h.StdioServerTransportCtor).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  test("propagates a registerTool failure for one entry as the same error instance, and does not register later entries or connect anything", () => {
    const boom = new Error("registerTool boom");
    // `mockImplementationOnce` — consumed by the first `registerTool` call
    // only, so the second registry entry (which must never be reached) would
    // hit the default stub implementation if the loop kept going.
    h.registerTool.mockImplementationOnce(() => {
      throw boom;
    });
    const fakeRegistry = [
      {
        name: "tool_one",
        config: {
          title: "Tool One",
          description: "does the first thing",
          annotations: { readOnlyHint: true },
        },
        handler: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
      {
        name: "tool_two",
        config: {
          title: "Tool Two",
          description: "does the second thing",
          annotations: { readOnlyHint: false },
        },
        handler: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
    ] as unknown as GatedToolRegistration[];

    let thrown: unknown;
    try {
      createM3LMcpServer({ registry: fakeRegistry });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(h.registerTool).toHaveBeenCalledTimes(1);
    expect(h.StdioServerTransportCtor).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe("startM3LMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls connect exactly once, over a StdioServerTransport instance", async () => {
    await startM3LMcpServer();

    expect(h.connect).toHaveBeenCalledTimes(1);
    const transportArg = h.connect.mock.calls[0]?.[0];
    expect(transportArg).toBeInstanceOf(h.StdioServerTransportCtor);
  });

  test("resolves to the constructed server", async () => {
    const server = await startM3LMcpServer();

    expect(server).toMatchObject({
      registerTool: h.registerTool,
      connect: h.connect,
    });
  });

  test("registers an injected registry's tools before connecting", async () => {
    // Same forged-brand rationale as the `createM3LMcpServer` cast above —
    // unavoidable until `gateTool` (slice V10c) exists to produce a real
    // `GatedToolRegistration`.
    const fakeRegistry = [
      {
        name: "only_tool",
        config: {
          title: "Only Tool",
          description: "the only one",
          annotations: { readOnlyHint: true },
        },
        handler: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
    ] as unknown as GatedToolRegistration[];

    await startM3LMcpServer({ registry: fakeRegistry });

    expect(h.registerTool).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  test("propagates a connect rejection as the same error instance, unwrapped and unswallowed", async () => {
    const boom = new Error("connect boom");
    // `mockRejectedValueOnce` — a single-shot override consumed by the next
    // `connect` call only. That self-consuming behavior is exactly what
    // this test needs: `beforeEach`'s `vi.clearAllMocks()` drops call
    // history but keeps a mock's *persistent* implementation, so a
    // `mockRejectedValue` (no "Once") would silently poison every later
    // test's `connect` call in this file. Proven, not assumed, below: the
    // very next `startM3LMcpServer()` call in this same test resolves
    // normally again.
    h.connect.mockRejectedValueOnce(boom);

    await expect(startM3LMcpServer()).rejects.toBe(boom);

    await expect(startM3LMcpServer()).resolves.toMatchObject({
      connect: h.connect,
    });
  });
});

describe("M3LMcpServerDeps (type level)", () => {
  test("is exactly an optional readonly registry array", () => {
    expectTypeOf<M3LMcpServerDeps>().toEqualTypeOf<{
      readonly registry?: readonly GatedToolRegistration[];
    }>();
  });
});

describe("createM3LMcpServer / startM3LMcpServer return types", () => {
  test("both resolve to the narrowed M3LMcpServerHandle, not the raw McpServer", () => {
    expectTypeOf(
      createM3LMcpServer,
    ).returns.toEqualTypeOf<M3LMcpServerHandle>();
    expectTypeOf(startM3LMcpServer).returns.toEqualTypeOf<
      Promise<M3LMcpServerHandle>
    >();
  });
});
