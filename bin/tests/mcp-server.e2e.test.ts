// Real protocol-level test for bin/mcp-server.mjs — spawns the actual server
// as a child process and talks real MCP over stdio, with NO mocking of the
// SDK (unlike mcp-server.test.ts, which mocks
// @modelcontextprotocol/sdk/server/{mcp,stdio}.js to unit-test the
// registration loop in isolation). This closes the exact gap ADR-0096's
// audit found: "A server that fails to start, or a tool whose schema a
// client rejects, passes all existing tests" — nothing short of a real
// client/server handshake over a real stdio transport can observe that.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// These two subpaths resolve via the SDK's "./*" wildcard export (verified
// at runtime and under `pnpm typecheck`, same mechanism bin/mcp-server.mjs
// already relies on for @modelcontextprotocol/sdk/server/mcp.js) —
// eslint-import-resolver-typescript does not follow this subpath-pattern
// export when linting a .ts file, so both need a narrow disable.
// eslint-disable-next-line import-x/no-unresolved -- see rationale above.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import-x/no-unresolved -- see rationale above.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Same dirname()-hop pattern as check-mcp.test.ts / adr-claims.test.ts: this
// file lives at bin/tests/, the repo root is two hops up from bin/.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const TOOL_CALL_TIMEOUT = 15000;

let client: Client;
let transport: StdioClientTransport;

beforeEach(() => {
  transport = new StdioClientTransport({
    command: "node",
    args: ["bin/mcp-server.mjs"],
    cwd: repoRoot,
  });
  client = new Client(
    { name: "e2e-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
});

afterEach(async () => {
  // client.close() (Protocol#close) awaits transport.close(), which itself
  // ends the child's stdin and races a `close` process event against a 2s
  // unref'd timeout (node_modules/@modelcontextprotocol/sdk/dist/esm/client/
  // stdio.js) — so no orphaned server process survives a failing test, even
  // one that failed before any tool call completed.
  await client.close();
});

describe("m3l MCP server — real stdio protocol round trip", () => {
  test(
    "connects and lists exactly the 6 registered tools by name",
    async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "adr_query",
          "catalog_query",
          "commands_query",
          "commit_lint",
          "hooks_query",
          "logs_query",
        ].sort(),
      );
    },
    TOOL_CALL_TIMEOUT,
  );

  test(
    "every listed tool carries annotations.readOnlyHint: true and a non-empty title, straight off the wire",
    async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(typeof tool.title).toBe("string");
        expect((tool.title ?? "").length).toBeGreaterThan(0);
      }
    },
    TOOL_CALL_TIMEOUT,
  );

  test(
    "the server declares a non-empty 'instructions' string at initialize",
    async () => {
      await client.connect(transport);
      const instructions = client.getInstructions();
      expect(typeof instructions).toBe("string");
      expect((instructions ?? "").length).toBeGreaterThan(0);
    },
    TOOL_CALL_TIMEOUT,
  );

  test(
    "adr_query({ id: '0030' }) round-trips through the real server and returns ADR-0030's live status",
    async () => {
      await client.connect(transport);
      const result = await client.callTool({
        name: "adr_query",
        arguments: { id: "0030" },
      });
      expect(result.isError).toBeFalsy();
      const block = (result.content as { type: string; text: string }[])[0];
      expect(block).toBeDefined();
      const payload = JSON.parse(block?.text ?? "{}") as {
        total: number;
        results: { id: string; status: string }[];
      };
      expect(payload.total).toBe(1);
      expect(payload.results[0]?.id).toBe("0030");
      // Deliberately not pinned to ADR-0030's exact status text (e.g.
      // "Partially-superseded") — a later status change to that one ADR
      // would fail this transport-round-trip test for a reason unrelated to
      // what it exists to prove. A non-empty string is enough to show the
      // handler parsed the live docs/adr/ corpus (which has a real status
      // per entry) rather than returning a stub.
      expect(typeof payload.results[0]?.status).toBe("string");
      expect((payload.results[0]?.status ?? "").length).toBeGreaterThan(0);
    },
    TOOL_CALL_TIMEOUT,
  );

  test(
    "commands_query with neither 'name' nor 'query' → isError: true with a non-empty corrective message, not a silently-accepted malformed call",
    async () => {
      await client.connect(transport);
      const result = await client.callTool({
        name: "commands_query",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const block = (result.content as { type: string; text: string }[])[0];
      expect(block).toBeDefined();
      const payload = JSON.parse(block?.text ?? "{}") as { error?: string };
      expect(typeof payload.error).toBe("string");
      expect((payload.error ?? "").length).toBeGreaterThan(0);
      expect(payload.error).toContain("requires at least one of");
    },
    TOOL_CALL_TIMEOUT,
  );
});
