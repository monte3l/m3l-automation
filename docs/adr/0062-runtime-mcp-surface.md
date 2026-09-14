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

## Update (2026-09-14) — contract bounds settled at V10, and four clauses corrected

V10 opens. The Decision above left the tool grouping "settled at
implementation" and was written five ADRs before the constraints it depends
on moved. This Update settles the open bound and corrects four clauses that
an implementer would otherwise have to contradict silently.

**1. The tool grouping is four intent-grouped tools.** `fleet_health`
(doctor), `fleet_describe` (list + inspect, carrying the ADR-0055 operation
descriptors), `fleet_run` (ADR-0063 envelope, dry-run-capable), `fleet_flow`
(flow list + run). This is the Decision's own sketch, read literally; Stage 1
experience produced no reason to merge or split it. Folding `fleet_flow` into
`fleet_run` behind a `target` discriminant was considered and rejected: a
script action and a flow action grade differently under ADR-0060, so a union
input would put two policy shapes behind one schema.

**2. "An `escalate` verdict surfaces as an MCP error" means a tool result
with `isError: true`, not a JSON-RPC error.** The Decision's wording is not
achievable through the SDK surface this package uses. In the pinned
`@modelcontextprotocol/sdk` (1.30.0), `McpServer`'s `CallToolRequestSchema`
handler catches every thrown value and returns `createToolError(...)` —
`{ content: [{ type: "text", … }], isError: true }` — rethrowing only
`ErrorCode.UrlElicitationRequired`. Reaching a true JSON-RPC error response
would mean dropping `McpServer` for the low-level `Server` plus
`setRequestHandler`, giving up the SDK's schema validation and diverging from
the `bin/mcp-server.mjs` precedent this package otherwise mirrors — a large
cost for a distinction no MCP client acts on differently.

So a refusal is a tool result carrying `isError: true`, the fixed
human-approval message, and `structuredContent: { verdict, rule }` so a
client can separate `escalate` from `denied` programmatically rather than by
parsing prose. Two consequences bind the implementation: a refusal must be
**returned, never thrown** (a throw discards the `structuredContent`, because
`createToolError` builds the result itself), and because `validateToolOutput`
returns early once `isError` is set, refusal payloads are carried but not
schema-validated by the SDK — their shape is asserted in this package's own
tests instead. The Decision's substantive guarantee is unchanged: the server
still never prompts.

**3. The "`m3l-cli` internals as needed" clause is retired.** It is
unrealizable as written: `packages/m3l-cli/package.json` declares a `bin`
entry and no `exports` map, so `src/run/envelope.ts`, `src/run/execute.ts`
and `src/flow/envelope.ts` are unreachable from another package. Adding an
`exports` map to make them reachable was rejected — it would invert the
relationship, making this package a second CLI front-end that owns flag
partitioning, discovery and report lookup in-process, against an ungated
internal API, and would make it the direct parent of every spawned script
with no bounded-kill owner.

The surface therefore drives the **binary** with `--json`, which is what
ADR-0063 already designates: its envelope "is the result shape ADR-0062's MCP
run tool returns". The dependency stands as `@monte3l/m3l-common` via
`workspace:*` plus the SDK; `m3l-cli` is a spawned process, not an import.

**4. The library specifier is `@monte3l/m3l-common`.** The Decision names
`@m3l-automation/m3l-common`, which no longer resolves —
[ADR-0103](./0103-publish-scope-rename-and-staged-first-release.md) renamed
the published package's scope because GitHub Packages requires the npm scope
to equal the owning account. The `@m3l-automation` scope survives for the
private packages, so this package is `@m3l-automation/m3l-mcp`.

**5. `zod` is a second own dependency, not an implementation detail.** The
Decision frames the SDK as "its own dependency" (singular). The pinned SDK
declares `zod` a **non-optional** peer dependency, and `registerTool`'s
`inputSchema` takes a zod raw shape, so the package must declare it too. Both
versions match pins the workspace already holds, so this adds no new
resolution and no new supply-chain surface — but "one new dependency" was the
wrong count to review against.

### Two contract gaps V10 inherits rather than closes

- **ADR-0061's identity triple is only partly satisfiable here.** The
  Decision requires "the MCP client named as the agent identity source", and
  MCP's `initialize` handshake carries `clientInfo` (name, version) but no
  model identity. Entries therefore carry `identity.name` as
  `mcp:<client>@<version>` and omit `modelId` unless separately configured.
  That client-supplied string is untrusted input on a path into an audit
  line, so it is length-capped and stripped of control characters before use.
- **Token, cost, and loop budgets are unobservable from this surface.** An
  ADR-0060 policy declaring `budgets.tokensPerRun`, `costPerRun` or
  `loopIterations` will escalate every MCP call under the corresponding
  `.unobservable` rule, because a stdio server has no model loop to measure.
  This is correct fail-closed behaviour rather than a defect, and is
  documented on the contract page so an operator does not read it as one.

**Semver impact:** none. `m3l-common`'s exports map is untouched; the new
package is private (its publish-set membership is settled in
[ADR-0057](./0057-private-registry-distribution.md)'s 2026-09-14 Update).
