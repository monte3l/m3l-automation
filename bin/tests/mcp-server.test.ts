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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TOOLS } from "../lib/mcp-tools.mjs";

/** The `{ content, isError }` envelope every tool handler resolves to. */
type ToolResult = {
  content: { type: string; text: string }[];
  isError: boolean;
};

const h = vi.hoisted(() => {
  const registerTool = vi.fn();
  const connect = vi.fn((_transport: unknown) => Promise.resolve());
  // Defaults mirror a client that declares no `roots` capability — the
  // common case — so resolveRepoRoot() falls back to the static root and
  // every pre-existing test (which never configures these) is unaffected.
  const getClientCapabilities = vi.fn(
    (): { roots?: unknown } | undefined => undefined,
  );
  const listRoots = vi.fn(() =>
    Promise.resolve<{ roots?: { uri: string }[] }>({ roots: [] }),
  );
  const McpServerCtor = vi.fn(function (
    this: unknown,
    config: Record<string, unknown>,
  ) {
    return {
      registerTool,
      connect,
      config,
      server: { getClientCapabilities, listRoots },
    };
  });
  const StdioServerTransportCtor = vi.fn();
  return {
    registerTool,
    connect,
    getClientCapabilities,
    listRoots,
    McpServerCtor,
    StdioServerTransportCtor,
  };
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
  // main() invocations in the same file. getClientCapabilities/listRoots get
  // their default (no-roots-capability) implementation re-applied explicitly
  // — clearAllMocks does not undo a mockReturnValue/mockResolvedValue a test
  // installed, so a test that overrides them must not leak into the next one.
  beforeEach(() => {
    vi.clearAllMocks();
    h.getClientCapabilities.mockReturnValue(undefined);
    h.listRoots.mockResolvedValue({ roots: [] });
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

  describe("needsRoot: true delegation (regression: ADR-0096's stale-cwd-after-EnterWorktree bug)", () => {
    let fixtureRoot: string;

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    });

    // The client-resolved root (from listRoots()) is deliberately DIFFERENT
    // content than the real repo's own ADR-0001, so a wrapper that stops
    // passing `{ root: repoRoot }` (passes `{}` or nothing) would read the
    // real repo instead and this assertion would fail — the same regression
    // the bug this test guards against would reintroduce.
    test("adr_query's wrapper passes the client-resolved root through to the handler, not the static load-time root", async () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "mcp-server-root-test-"));
      mkdirSync(join(fixtureRoot, "docs", "adr"), { recursive: true });
      writeFileSync(
        join(fixtureRoot, "docs", "adr", "0001-fixture.md"),
        "# 0001. Fixture ADR\n\n- **Status:** Accepted\n",
      );
      h.getClientCapabilities.mockReturnValue({ roots: {} });
      h.listRoots.mockResolvedValue({
        roots: [{ uri: pathToFileURL(fixtureRoot).href }],
      });

      await main();
      const adrQueryIndex = TOOLS.findIndex(
        (tool) => tool.name === "adr_query",
      );
      expect(adrQueryIndex).toBeGreaterThanOrEqual(0);
      const call = h.registerTool.mock.calls[adrQueryIndex] as [
        string,
        unknown,
        (args: Record<string, unknown>) => Promise<ToolResult>,
      ];
      const wrapper = call[2];

      const result = await wrapper({ id: "0001" });
      expect(result.isError).toBe(false);
      const block = result.content[0];
      expect(block).toBeDefined();
      const payload = JSON.parse(block?.text ?? "{}") as {
        total: number;
        results: { id: string; title: string }[];
      };
      expect(payload.total).toBe(1);
      expect(payload.results[0]?.id).toBe("0001");
      expect(payload.results[0]?.title).toBe("Fixture ADR");
    });
  });
});
