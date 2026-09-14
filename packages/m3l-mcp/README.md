# @m3l-automation/m3l-mcp

Runtime MCP surface for the m3l fleet (ADR-0062): a stdio MCP server whose
purpose is to expose intent-grouped fleet operations to **any** MCP client —
Claude Code, the Agent SDK on Bedrock, the desktop app — under exactly the
same authorization and audit trail as the repo's own `agent-operator` script,
with every tool call passing through the ADR-0060 policy layer and landing in
the ADR-0061 decision log.

**That is the target, not the current state** — see
[What exists today](#what-exists-today) before wiring a client to this. The
package is mid-wave and currently exposes no tools at all.

## This is not `bin/mcp-server.mjs`

The repo runs **two** MCP servers, and conflating them is the mistake
ADR-0030's 2026-08-20 amendment exists to prevent:

|                            | `bin/mcp-server.mjs`                  | this package                 |
| -------------------------- | ------------------------------------- | ---------------------------- |
| Scope                      | dev-time repo maintenance             | runtime fleet operation      |
| Tools                      | read-only metadata lookups (ADR-0096) | discovery, run, flow, health |
| Mutates?                   | never                                 | yes, under policy            |
| Registered in `.mcp.json`? | yes, as `m3l`                         | **no** — deliberately        |
| SDK dependency             | root devDependency                    | this package's own           |

This server is **not** registered in the repo's own `.mcp.json`. It is a
product surface for external clients, not a tool for sessions working in this
repo — registering it would hand every Claude Code session in the checkout
mutating fleet tools. Slice V10d adds a `bin/check-mcp.mjs` assertion so that
absence is mechanically enforced rather than left to convention; until then it
holds by convention only.

## Usage

```bash
pnpm mcp:serve
```

The server speaks JSON-RPC over stdio, so running it in a terminal is only
useful for a smoke test — it expects a client on the other end. An MCP client
is wired to it by command:

```json
{
  "mcpServers": {
    "m3l-ops": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/m3l-mcp/bin/m3l-mcp.mjs"]
    }
  }
}
```

## Before the first run

A policy file must exist — `data/input/agent-policy.json`, the same file and
the same ADR-0060 declaration `agent-operator` reads. There is deliberately
**no fallback policy**: a missing, malformed, or structurally invalid file
makes the server refuse to serve rather than degrade to a built-in grant. The
only way to run with authority is to declare it in a reviewable file.

Two behaviours that look like bugs and are not:

- **Log entries carry no model id.** MCP's `initialize` handshake carries
  `clientInfo` (name and version) but nothing identifying the model, so
  ADR-0061 entries record `identity.name` as `mcp:<client>@<version>` and omit
  `modelId`.
- **A policy declaring token, cost, or loop budgets escalates every call.** A
  stdio server has no model loop to measure, so those budgets are
  unobservable and the policy layer fails closed under its `.unobservable`
  rules. Declare only the budgets this surface can actually observe
  (`invocationsPerRun`, `invocationsPerDay`).

## What exists today

This package is mid-wave. **Slice V10b — the current state — is the skeleton
only:** the stdio composition root (`createM3LMcpServer` /
`startM3LMcpServer`), the error type, and a tool registry that is
deliberately **empty**. It exposes no tools and enforces no policy yet,
because there is nothing yet to enforce it on.

Concretely, and stated so nobody reads the sections above as already
shipped: `gateTool`, the policy load, the decision-log write, the
verdict-to-response mapping, and all four tools (`fleet_health`,
`fleet_describe`, `fleet_run`, `fleet_flow`) are **not implemented**. The
policy-file and unobservable-budget behaviour described under "Before the
first run" is the contract those slices must satisfy — it is not live
behaviour today. Slice sequence and status:
[`docs/plans/2026-09-14-v10-runtime-mcp-surface.md`](../../docs/plans/2026-09-14-v10-runtime-mcp-surface.md).

## Contract

`docs/reference/mcp.md` is the contract page — tool schemas, configuration,
the policy/audit guarantees, and the verdict-to-response mapping. It lands
with slice V10d.

## Design notes

The first is in force now; the other two are decided (ADR-0062's 2026-09-14
Update) and bind the slice that implements them.

- **A `GatedToolRegistration` cannot be constructed outside its module —
  structurally, and already true.** Be precise about what that does and does
  not buy. What it buys: the type is keyed off a `unique symbol` that
  `src/tools/registry.ts` never exports, so no code outside that module can
  name the brand, and therefore no object literal can satisfy the type no
  matter how exactly it copies the field shape. Slice V10c's `gateTool` mints
  entries from inside that module, which is what makes it the only possible
  producer of a registry entry. What it does **not** buy: it is not a
  guarantee that no ungated tool can ever reach the SDK. The SDK's
  `McpServer#registerTool` is public, so a caller holding a server object can
  still register something that never passed the gate — the returned
  `M3LMcpServerHandle` narrows that method away from the _type_, which stops
  it happening by accident, but a JavaScript caller or a cast still reaches
  it. The brand governs what can be put **in the registry**; enforcing the
  boundary at registration time needs the runtime check recorded for V10c.
  The brand deliberately is **not** exported: exporting it would let
  any caller hand-build a "gated" entry and would reduce this guarantee to a
  naming convention.
- **A refusal must be returned, never thrown** (binds slice V10c).
  `McpServer` converts every handler throw into `{ isError: true }` itself,
  discarding any structured payload — so refusals have to be constructed and
  returned, carrying `structuredContent: { verdict, rule }` for a client to
  branch on programmatically rather than by parsing prose.
- **Refusal messages must be module constants** (binds slice V10c). The text
  reaches the model verbatim with no redaction, so it must never interpolate a
  script name, a filesystem path, or a caught error's message.
