// Registration-loop smoke test for bin/mcp-server.mjs — the thin composition
// root that constructs an McpServer, registers every entry from
// bin/lib/mcp-tools.mjs's TOOLS, and connects it over stdio. `main()` takes
// no injectable server argument (it constructs its own `McpServer` and
// `StdioServerTransport` internally), so — mirroring the hoisted
// vi.mock("node:child_process") pattern used in mcp-tools.test.ts — this
// mocks the two `@modelcontextprotocol/sdk` subpaths it imports, with the
// mocked `McpServer` constructor returning a stub `{ registerTool, connect }`
// object so the registration loop can be observed without ever touching real
// stdio (importing bin/mcp-server.mjs is safe on its own: the
// `process.argv[1] === fileURLToPath(import.meta.url)` guard means the
// module only calls `main()` itself when run directly, never on import).
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TOOLS } from "../lib/mcp-tools.mjs";

const h = vi.hoisted(() => {
  const registerTool = vi.fn();
  const connect = vi.fn(() => Promise.resolve());
  const McpServerCtor = vi.fn(function (
    this: unknown,
    config: Record<string, unknown>,
  ) {
    return { registerTool, connect, config };
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

import { main } from "../mcp-server.mjs";

describe("mcp-server main() registration loop", () => {
  // clearAllMocks (not resetAllMocks) — keeps McpServerCtor's mockImplementation
  // (the stub-object return) while dropping the prior test's call history, so
  // each test's "called exactly N times" assertion is not polluted by earlier
  // main() invocations in the same file.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("registers every TOOLS entry exactly once with its config and handler", async () => {
    await main();
    expect(h.registerTool).toHaveBeenCalledTimes(TOOLS.length);
    for (const tool of TOOLS) {
      expect(h.registerTool).toHaveBeenCalledWith(
        tool.name,
        tool.config,
        tool.handler,
      );
    }
  });

  test("constructs the McpServer with the server's own name/version identity", async () => {
    await main();
    expect(h.McpServerCtor).toHaveBeenCalledWith({
      name: "m3l",
      version: "1.0.0",
    });
  });

  test("connects exactly once over a StdioServerTransport instance", async () => {
    await main();
    expect(h.connect).toHaveBeenCalledTimes(1);
    const transportArg = h.connect.mock.calls[0]?.[0];
    expect(transportArg).toBeInstanceOf(h.StdioServerTransportCtor);
  });

  test("resolves to the constructed server instance", async () => {
    const server = await main();
    expect(server).toMatchObject({
      registerTool: h.registerTool,
      connect: h.connect,
    });
  });
});
