# AI agents operating a CLI application (tooling, MCP, safety, Bedrock)

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> 27 official Anthropic sources. Synthesized: 2026-08-20.
> Sources: [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
> [Building effective AI agents](https://www.anthropic.com/research/building-effective-agents),
> [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
> [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
> [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
> [Bash tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool),
> [Building agents that reach production systems with MCP](https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp),
> [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
> [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk),
> [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector),
> [MCP 2026-07-28: stateless core](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude),
> [Enterprise-managed authorization for MCP](https://claude.com/blog/enterprise-managed-auth),
> [Introducing the Model Context Protocol](https://www.anthropic.com/news/model-context-protocol),
> [Framework for safe and trustworthy agents](https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents),
> [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode),
> [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing),
> [Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment),
> [CISO's guide to agentic AI](https://claude.com/blog/ciso-guide-to-agentic-ai),
> [Measuring agent autonomy](https://www.anthropic.com/news/measuring-agent-autonomy),
> [How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude),
> [Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock),
> [Claude on Amazon Bedrock (legacy)](https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy),
> [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
> [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
> [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
> [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching),
> [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

Backing research for the agent-operator programme (ADR-0058…0063): how an AI
agent should drive the m3l CLI, what the tool surface should look like, how
autonomy is bounded, and how Claude runs on AWS Bedrock. Complements the
2026-07-16 [writing-custom-tools-and-mcp](./writing-custom-tools-and-mcp.md)
snapshot (dev-time tool authoring); this one is about a **runtime operator**.

## Consensus / best practices

**Tool surface design** [S1, S2, S4, S7]

- Tool descriptions are "by far the most important factor in tool
  performance" — 3–4 sentences each: what it does, when to use it, what each
  parameter means, caveats. Invest in tools like a human-computer interface;
  the SWE-bench team "spent more time optimizing tools than the overall
  prompt".
- **Group tools around intent, not endpoints**: "fewer, well-described tools
  consistently outperform exhaustive API mirrors". One tool that completes a
  task beats primitives the agent must orchestrate.
- Namespace tools by service/resource (`m3l_*`); unambiguous parameter names;
  return semantic, stable identifiers and high-signal, token-efficient
  results (pagination/filter/truncation with sensible defaults; optional
  `concise`/`detailed` modes).
- Actionable error messages steer recovery; poka-yoke the inputs (e.g.
  require absolute paths) so illegal calls are hard to make.

**CLI vs purpose-built tools** [S6, S7, S9]

- "Give your agents a computer": bash/CLI access works for ad-hoc work, but
  primary repeated actions deserve purpose-built tools; CLIs "hit hard
  limits" reaching web/mobile/cloud hosts — remote MCP is the distribution
  path there. For very large surfaces, expose a minimal tool that accepts a
  short script executed in a sandbox rather than mirroring every operation.

**MCP** [S7, S10, S11, S12, S13]

- stdio suits local/sandboxed use; **remote (HTTP/SSE, stateless per the
  2026-07-28 spec) is what runs across web, mobile, and cloud-hosted
  agents** — deployable serverless. OAuth for remote; enterprise auth via
  IdP. Tool allowlist/denylist configuration plus `defer_loading`/tool
  search are the recommended control plane for large tool sets.

**Safety for autonomous operation** [S14, S15, S16, S17, S18, S19, S20]

- Defense in depth, least privilege, and **approval positioned at
  high-stakes actions, not every action**: "effective oversight does not
  require approving every action but being positioned to intervene when it
  matters". Humans retain control "particularly before high-stakes
  decisions".
- Boundaries are dual: filesystem AND network/egress (egress allowlisting is
  called the strongest single control against prompt injection).
- **Credential isolation**: a proxy/broker outside the agent boundary holds
  real credentials; the agent never sees them.
- Audit at the boundary (proxy logs, OpenTelemetry/SIEM); budget and
  iteration limits for unattended runs; org-level kill switches. Goal:
  make agentic risk "legible and bounded", not zero.
- Treat everything the agent reads as potentially injected; guardrails must
  block scope escalation, credential exploration, and agent-inferred
  parameters on high-risk actions.

**Claude on AWS Bedrock** [S21, S22, S23, S24, S25, S27]

- Current Bedrock hosts Claude behind the standard **Messages API**
  (`/anthropic/v1/messages`, SSE streaming); model IDs `anthropic.claude-*`;
  auth via Bedrock service role / IAM / bearer token, resolved through the
  standard AWS credential chain. (Legacy Opus 4.6-era models use
  InvokeModel/Converse with ARN-versioned IDs.)
- **Client-side tools fully supported; server tools (web search, code
  execution) and structured outputs are NOT available on Bedrock** — the
  tool loop is the caller's (invoke → tool_use blocks → run tools → feed
  results → repeat).
- Prompt caching works (5m default / 1h TTL; automatic on current models);
  the Claude Agent SDK / Claude Code run on Bedrock via
  `CLAUDE_CODE_USE_BEDROCK=1` + the credential chain.

## Contradictions / drift

- **Auto-approval classifiers vs per-tool approval**: Claude Code auto mode
  auto-approves ~83% of safe actions via classifiers; the CISO guide
  recommends explicit per-tool action approval. Not a true conflict — the
  CISO guide is governance policy, auto mode a technical implementation for
  lower-risk contexts; enterprises may reject classifier auto-approval for
  audit reasons. For a single-maintainer fleet, a declarative policy layer
  (allowlist + sensitivity grades) is the appropriate middle.
- **Hand-rolled loops vs Agent SDK**: guidance leans Agent-SDK-first for
  general agents, yet the tool-use docs fully specify the raw loop and
  Bedrock only supports client tools. A bounded, policy-gated operator loop
  over a fixed tool set is a legitimate raw-loop use; adopt the SDK path via
  MCP for interactive/general use.

## Coverage gaps

- No official Bedrock-specific agentic-loop guide (loop guidance is
  provider-generic); no dedicated Agent SDK + Bedrock integration doc beyond
  env-var setup.
- No official guidance on max tool count before tool search, response-size
  truncation thresholds, or error-message length.
- Local stdio MCP server _design_ guidance is thin (docs focus on remote).
- The canonical MCP spec lives on modelcontextprotocol.io (out of the
  official-Anthropic allowlist; not quoted here).

## Sources

See the provenance header — 27 sources; retrieval date 2026-08-20 for all.
Bracketed tags: S1 Writing effective tools; S2 Building effective agents;
S4 Define tools; S6 Bash tool; S7 Production systems with MCP; S9 Agent SDK
blog; S10 MCP connector; S11 MCP 2026-07-28; S12 Enterprise-managed auth;
S13 Introducing MCP; S14 Safe & trustworthy agents; S15 Auto mode;
S16 Sandboxing; S17 Secure deployment; S18 CISO guide; S19 Measuring agent
autonomy; S20 How we contain Claude; S21 Claude in Bedrock; S22 Bedrock
legacy; S23 Claude Code on Bedrock; S24 Agent SDK overview; S25 Prompt
caching; S27 Tool use overview.
