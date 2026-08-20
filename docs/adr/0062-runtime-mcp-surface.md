# 0062. Runtime MCP surface: `packages/m3l-mcp`

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

Stage 2 of the agent-operator programme (ADR-0058) makes the m3l fleet
operable by **any** MCP client — Claude Code or the Agent SDK on Bedrock,
the desktop app, a future cloud-hosted agent — not only by the repo's own
agent-operator script.

The repo already runs an MCP server, but the wrong one for this job:
`bin/mcp-server.mjs` (ADR-0030) is the **dev-time repo-maintenance**
surface (verify, docs-sync, scaffold, worktree…), stdio, hub-only, with
`@modelcontextprotocol/sdk` as a root devDependency. Runtime fleet
operation is a different product surface with a different lifecycle,
different consumers, and — per the audit — no overlap in tools: nothing in
the dev server invokes a script, monitors a run, or reads a run result.

## Decision drivers

- **The CLI's zero-runtime-dependency invariant must hold** — the MCP SDK
  cannot become an `m3l-cli` dependency.
- **Intent-grouped tools, not a command mirror** (research snapshot S1/S7:
  "fewer, well-described tools consistently outperform exhaustive API
  mirrors") — the same rule ADR-0030 already applied dev-time.
- **One policy, one audit trail**: the MCP surface must enforce ADR-0060
  verdicts and write ADR-0061 entries identically to the script loop.
- **stdio first**: the fleet's operator is local today; remote transport is
  a distribution decision with auth/exposure consequences.

## Considered options

1. **Extend `bin/mcp-server.mjs`.** Rejected: mixes dev-time hub tooling
   with a runtime operator surface, and `bin/` is not a distributable
   package.
2. **`m3l mcp` command inside the CLI.** Rejected: either adds the SDK as a
   CLI runtime dependency (invariant break) or hand-rolls the MCP protocol
   (standing maintenance risk).
3. **A new workspace package `packages/m3l-mcp`.** Chosen.

## Decision

We chose **option 3**. **`packages/m3l-mcp`** is a new workspace package —
the same governance registration path `m3l-cli` walked (root tsconfig
reference, knip workspace, ESLint zones, coverage config) — holding
`@modelcontextprotocol/sdk` as **its own** dependency plus
`@m3l-automation/m3l-common` (and `m3l-cli` internals as needed) via
`workspace:*`. Contract bounds, shaped at implementation (V10):

- **Transport: stdio.** Remote/HTTP (stateless per the MCP 2026-07-28
  spec) is **recorded but gated** behind a dedicated future ADR that must
  settle transport, authentication, and exposure posture — the
  U14/ADR-0057 gate pattern. Nothing in the stdio design may preclude it.
- **Tools are intent-grouped operations**, explicitly not one tool per CLI
  command — e.g. a discovery/introspection tool (wrapping list+inspect,
  operation-aware once ADR-0055 ships), a run tool (returning ADR-0063's
  structured envelope, dry-run-capable), a flow tool (post-U10), and a
  health tool (doctor). Exact grouping is settled at implementation
  against operator experience from Stage 1.
- **Policy and audit are non-optional**: every tool call passes through
  ADR-0060 (an `escalate` verdict surfaces as an MCP error naming the
  human-approval requirement — the server never prompts) and lands in
  ADR-0061's decision log with the MCP client named as the agent identity
  source.
- **Split with the dev-time server recorded**: `bin/mcp-server.mjs` keeps
  repo-maintenance scope; `packages/m3l-mcp` owns runtime fleet operation
  (ADR-0030's 2026-08-20 amendment states the boundary).
- **Publishing**: whether `m3l-mcp` joins ADR-0057's private-registry
  publish set is **deferred** to whichever of V10/U13 lands second, via an
  ADR-0057 Update then — not decided here.

## Consequences

- **Positive:** any MCP client can operate the fleet under exactly the
  same policy and audit as the repo's own agent; the CLI stays zero-dep;
  the dev-time/runtime boundary is explicit before the first tool exists,
  instead of being discovered by a future audit.
- **Negative / trade-offs:** a third workspace package to govern (gates,
  coverage, docs); two MCP servers to keep conceptually distinct; stdio
  scope means cloud-hosted clients wait on the gated remote ADR.
- **Semver impact:** none from this ADR (docs only). V10 adds a new
  private workspace package; `m3l-common`'s exports map is untouched.

## Links

- Programme: [ADR-0058](./0058-agent-operator-programme.md). Enforces:
  [ADR-0060](./0060-agent-policy-layer.md),
  [ADR-0061](./0061-agent-decision-log.md). Consumes:
  [ADR-0063](./0063-cli-structured-run-results.md) envelopes,
  [ADR-0055](./0055-declarative-operation-introspection.md) operation
  schemas (soft).
- Boundary: [ADR-0030](./0030-targeted-workflow-tooling-and-mcp.md) (its
  2026-08-20 amendment scopes dev-time vs runtime).
- Gate pattern precedent: [ADR-0057](./0057-private-registry-distribution.md).
- Research: [`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md).
