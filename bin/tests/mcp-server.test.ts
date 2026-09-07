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

/** The `{ content, isError }` envelope every tool handler resolves to. */
type ToolResult = {
  content: { type: string; text: string }[];
  isError: boolean;
};

const h = vi.hoisted(() => {
  const registerTool = vi.fn();
  const connect = vi.fn((_transport: unknown) => Promise.resolve());
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

  test("registers every TOOLS entry exactly once with its name/config, wrapped in a function that delegates to the real handler (commit_lint verified directly)", async () => {
    await main();
    expect(h.registerTool).toHaveBeenCalledTimes(TOOLS.length);

    // The registration loop wraps each handler in a fresh async closure (to
    // thread the per-call resolved repo root through), so the third argument
    // can no longer be asserted by reference equality to `tool.handler` —
    // only that a call was registered, by value, for every tool's name/config,
    // with a function in the third slot.
    TOOLS.forEach((tool, index) => {
      const call = h.registerTool.mock.calls[index] as
        [string, unknown, unknown] | undefined;
      expect(call?.[0]).toBe(tool.name);
      expect(call?.[1]).toBe(tool.config);
      expect(typeof call?.[2]).toBe("function");
    });

    // Representative behavioral check: commit_lint's needsRoot is false, so
    // its wrapper never calls resolveRepoRoot() — invoking it directly with a
    // real message exercises the real delegation to commitLint without
    // needing to mock server.getClientCapabilities()/listRoots() for this
    // assertion.
    const commitLintIndex = TOOLS.findIndex(
      (tool) => tool.name === "commit_lint",
    );
    expect(commitLintIndex).toBeGreaterThanOrEqual(0);
    const commitLintCall = h.registerTool.mock.calls[commitLintIndex] as [
      string,
      unknown,
      (args: Record<string, unknown>) => Promise<ToolResult>,
    ];
    const wrapper = commitLintCall[2];
    const message =
      "feat(core): add a widget\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";
    const wrapperResult = await wrapper({ message });
    const directResult = await TOOLS[commitLintIndex]?.handler({ message });
    expect(wrapperResult).toEqual(directResult);
    expect(wrapperResult.isError).toBe(false);
    const block = wrapperResult.content[0];
    expect(block).toBeDefined();
    const payload = JSON.parse(block?.text ?? "{}") as Record<string, unknown>;
    expect(payload["valid"]).toBe(true);
  });

  test("constructs the McpServer with the server's own name/version identity", async () => {
    await main();
    expect(h.McpServerCtor).toHaveBeenCalledWith(
      { name: "m3l", version: "2.0.0" },
      expect.objectContaining({ instructions: expect.any(String) }),
    );
    const call = h.McpServerCtor.mock.calls[0] as
      [unknown, { instructions: string }] | undefined;
    expect(call?.[1]?.instructions.length).toBeGreaterThan(0);
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
