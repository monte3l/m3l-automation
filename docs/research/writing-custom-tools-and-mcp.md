# Writing custom tools and MCP servers (TypeScript)

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> 19 official Anthropic sources. Synthesized: 2026-07-16.
> Sources: [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
> [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
> [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
> [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
> [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
> [SRE agent cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-03-the-site-reliability-agent),
> [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
> [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
> [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp),
> [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript),
> [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk),
> [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp),
> [Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more),
> [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
> [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
> [Skills explained](https://claude.com/blog/skills-explained),
> [Extending Claude's capabilities with skills and MCP servers](https://claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers),
> [Building agents that reach production systems with MCP](https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp),
> [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

## Consensus / best practices

### Tool design (what makes a good tool)

- Tool descriptions are the single highest-leverage factor — "by far the most
  important factor in tool performance." 3–4+ sentences: what it does, when to
  use / not use, what each parameter means, caveats. Unambiguous parameter
  names (`user_id`, not `user`). [S1, S2, S6, S7]
- Fewer, workflow-shaped tools beat exhaustive API mirrors. Consolidate related
  operations (one tool with an `action` parameter rather than N micro-tools);
  selection accuracy degrades past ~30–50 loaded tools. Namespace by
  service/resource (`asana_projects_search`). [S1, S2, S18]
- Context efficiency is the governing constraint: return only high-signal
  fields, semantic stable identifiers, pagination/filtering/truncation with
  sensible defaults, optionally a `response_format: detailed|concise`
  parameter. [S1, S2, S6]
- Errors must be actionable — return specific, corrective messages (in the
  Agent SDK, `isError: true` with a composed message), never opaque codes.
  Poka-yoke the schema so misuse is hard (e.g. absolute file paths after
  observing relative-path mistakes). [S1, S6, S8]
- Evaluate tools with realistic agent tasks and iterate — Anthropic "spent more
  time optimizing tools than the overall prompt" for its SWE-bench agent.
  Tool-use examples lift complex-parameter accuracy 72% → 90%. [S6, S1, S3]

### TypeScript mechanics (how to build one)

- In-process custom tools: Agent SDK `createSdkMcpServer()` + the `tool()`
  helper with Zod schemas (`.describe()` on every field); the handler returns
  `{ content, isError? }`. Tools are named `mcp__<server>__<tool>`; grant via
  `allowedTools` — prefer scoped allowlists over permission modes
  (`acceptEdits` does not auto-approve MCP tools). [S7, S8, S9, S10]
- External MCP servers: stdio for local processes, HTTP for remote (SSE is
  deprecated); project-scope configuration lives in a checked-in `.mcp.json`;
  first use triggers Claude Code's trust approval. Secrets go through `${VAR}`
  env expansion or OAuth — never literal keys in shared config. [S9, S12, S19]
- Selection rule of thumb: custom/SDK tools for **frequent, high-priority agent
  actions**; external MCP for **pre-built third-party integrations**; plain
  Bash/CLI for **ad-hoc, flexible work**. [S11, S19]

### When NOT to build tools

- Skills teach _how_ (procedural knowledge); MCP provides _access_ (external
  systems and data); hooks give deterministic enforcement; CLAUDE.md carries
  facts. Don't reach for MCP where a skill, hook, or CLI already fits.
  [S5, S13, S16, S17]
- Start simple; add complexity only when it demonstrably improves outcomes.
  Minimal, unambiguous tool sets avoid "context rot" and decision paralysis.
  For large tool inventories, prefer deferred loading (Tool Search — ~85% token
  reduction) or code execution / programmatic tool calling (~37–98% token
  reduction) over loading every definition upfront. [S6, S15, S3, S4, S14]

## Contradictions / drift

- No hard contradictions. One mild tension: S11 says "prioritize custom tools
  and MCP before resorting to complex Bash scripts," while S6/S15 push "start
  simple, minimal tool sets." Reconciled by S11's own framing: custom tools are
  for _frequent, high-priority_ actions; Bash remains correct for ad-hoc work.
  The current docs (S7–S10, S12) are the most authoritative for mechanics.

## Coverage gaps

- No TypeScript/Node-specific MCP-server style guide beyond the Agent SDK docs
  (the MCP TypeScript SDK lives under `github.com/modelcontextprotocol`,
  outside the official-Anthropic source allowlist).
- No formal playbook for "does a tool earn its context cost," no
  Bash-vs-dedicated-tool decision tree, and no tool versioning/deprecation
  guidance.

## Sources

- S1: Writing effective tools for AI agents —
  <https://www.anthropic.com/engineering/writing-tools-for-agents>
- S2: Define tools —
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- S3: Introducing advanced tool use —
  <https://www.anthropic.com/engineering/advanced-tool-use>
- S4: Code execution with MCP —
  <https://www.anthropic.com/engineering/code-execution-with-mcp>
- S5: Skill authoring best practices —
  <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
- S6: Building effective agents —
  <https://www.anthropic.com/engineering/building-effective-agents>
- S7: The site reliability agent (Claude SDK Cookbook) —
  <https://platform.claude.com/cookbook/claude-agent-sdk-03-the-site-reliability-agent>
- S8: Agent SDK custom tools —
  <https://code.claude.com/docs/en/agent-sdk/custom-tools>
- S9: Agent SDK permissions —
  <https://code.claude.com/docs/en/agent-sdk/permissions>
- S10: TypeScript SDK reference —
  <https://code.claude.com/docs/en/agent-sdk/typescript>
- S11: Building agents with the Claude Agent SDK —
  <https://claude.com/blog/building-agents-with-the-claude-agent-sdk>
- S12: Connect Claude Code to tools via MCP —
  <https://code.claude.com/docs/en/mcp>
- S13: Steering Claude Code —
  <https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more>
- S14: Tool search tool —
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool>
- S15: Effective context engineering for AI agents —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- S16: Skills explained —
  <https://claude.com/blog/skills-explained>
- S17: Extending Claude's capabilities with skills and MCP servers —
  <https://claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers>
- S18: Building agents that reach production systems with MCP —
  <https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp>
- S19: Agent SDK MCP integration —
  <https://code.claude.com/docs/en/agent-sdk/mcp>

Additional docs consulted without distinct claims cited above:
implement/parallel/strict tool use, tool runner, server tools, fine-grained
tool streaming, Claude Code permissions/hooks/plugins/security/managed-MCP
pages, the sandboxing engineering post, and the remote-MCP and
enterprise-managed-auth announcements.
