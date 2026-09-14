/**
 * `main` — the composition root for the runtime MCP server (ADR-0062).
 * Builds an SDK `McpServer`, registers every {@link GatedToolRegistration}
 * from {@link TOOL_REGISTRY} (or an injected registry, for tests), and —
 * only in {@link startM3LMcpServer} — connects it over stdio. Construction
 * and connection are split on purpose: a test (or a future health check)
 * can build the server and inspect its registrations without ever touching
 * a real transport.
 *
 * @packageDocumentation
 */
import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TOOL_REGISTRY, type GatedToolRegistration } from "./tools/registry.js";

/**
 * Told to the client at `initialize` (the SDK's `instructions` capability).
 * Its job is disambiguation: the repo runs a second, unrelated MCP server
 * (`bin/mcp-server.mjs`, dev-time repo-maintenance tools, read-only) and
 * this string is what stops a client — or a person configuring one — from
 * conflating the two. See `packages/m3l-mcp/README.md` § "This is not
 * `bin/mcp-server.mjs`" for the full comparison.
 */
export const INSTRUCTIONS: string =
  "Runtime fleet-operations surface for the m3l fleet (ADR-0062): discovery, " +
  "run, flow, and health tools that MAY mutate fleet state, gated by the " +
  "ADR-0060 policy layer and recorded in the ADR-0061 decision log. This is " +
  "not the repo's dev-time maintenance server (bin/mcp-server.mjs) — that " +
  "one is read-only and scoped to this checkout; this one operates the " +
  "fleet itself.";

/**
 * Dependencies {@link createM3LMcpServer} and {@link startM3LMcpServer}
 * accept. `registry` defaults to {@link TOOL_REGISTRY} when omitted — the
 * only injectable seam this slice needs is the tool list itself.
 *
 * @example
 * ```ts
 * import type { M3LMcpServerDeps } from "./main.js";
 *
 * const deps: M3LMcpServerDeps = { registry: [] };
 * ```
 */
export interface M3LMcpServerDeps {
  /** Overrides {@link TOOL_REGISTRY} when supplied (tests only, so far). */
  readonly registry?: readonly GatedToolRegistration[];
}

/**
 * Builds an `McpServer` and registers every entry of
 * `deps?.registry ?? TOOL_REGISTRY` against it. Connects **no** transport —
 * that is {@link startM3LMcpServer}'s job — so construction alone is safe
 * to call from a test without touching stdio.
 *
 * @param deps - See {@link M3LMcpServerDeps}.
 * @returns The constructed, not-yet-connected `McpServer`.
 *
 * @example
 * ```ts
 * import { createM3LMcpServer } from "./main.js";
 *
 * const server = createM3LMcpServer();
 * ```
 */
export function createM3LMcpServer(deps?: M3LMcpServerDeps): McpServer {
  // "1.0.0" is this server's own protocol identity (surfaced to MCP clients
  // during `initialize`), independent of the workspace's frozen
  // package.json "version" (0.0.0, ADR-0020) — manually bumped, same
  // convention as bin/mcp-server.mjs's own version string.
  const server = new McpServer(
    { name: "m3l-fleet", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );
  const registry = deps?.registry ?? TOOL_REGISTRY;
  for (const entry of registry) {
    // `entry.handler` is deliberately typed `(args: unknown) =>
    // Promise<unknown>` at this module's own boundary (see
    // `tools/registry.ts`) — the SDK's `ToolCallback` return shape
    // (`CallToolResult`) is a slice-V10c concern, produced by `gateTool`,
    // not by this composition root. The cast below crosses that boundary
    // at the single point the SDK requires it.
    server.registerTool(
      entry.name,
      entry.config,
      entry.handler as unknown as ToolCallback,
    );
  }
  return server;
}

/**
 * Builds the server via {@link createM3LMcpServer}, then connects it over
 * stdio. Connects exactly once.
 *
 * @param deps - See {@link M3LMcpServerDeps}.
 * @returns The connected `McpServer`.
 *
 * @example
 * ```ts
 * import { startM3LMcpServer } from "./main.js";
 *
 * await startM3LMcpServer();
 * ```
 */
export async function startM3LMcpServer(
  deps?: M3LMcpServerDeps,
): Promise<McpServer> {
  const server = createM3LMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
