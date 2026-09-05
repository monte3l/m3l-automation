# Subagent MCP tool grants: least privilege vs. hub-only

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from 23
> official Anthropic sources across 4 facets. Synthesized: 2026-09-05.
> Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents),
> [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
> [How and when to use subagents in Claude Code](https://claude.com/blog/subagents-in-claude-code),
> [Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more),
> [CISO's guide to agentic AI](https://claude.com/blog/ciso-guide-to-agentic-ai),
> [Configure permissions](https://code.claude.com/docs/en/permissions),
> [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp),
> [Settings reference](https://code.claude.com/docs/en/settings-reference),
> [Control MCP server access for your organization](https://code.claude.com/docs/en/managed-mcp),
> [Connect to external tools with MCP (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/mcp),
> [CLI reference](https://code.claude.com/docs/en/cli-reference),
> [Security (Claude Code)](https://code.claude.com/docs/en/security),
> [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
> [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
> [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
> [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them),
> [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns),
> [Multiagent orchestration (Managed Agents)](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration),
> [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
> [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
> [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
> [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
> [Scale to many tools with tool search (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/tool-search).

## Context

`m3l-automation`'s ADR-0030 established "MCP is hub-only" as a structural
invariant: every `.claude/agents/*.md` declares a closed `tools:` list with no
`mcp__*` entry. Wiring the `context7` documentation-lookup MCP server into
`code-implementer`'s workflow (ADR-0093) requires either keeping that
invariant — the hub fetches docs and relays them into the dispatch prompt — or
granting the spoke direct access. This snapshot resolves that design question
against official Anthropic guidance rather than repo convention alone.

## Consensus / best practices

- **Granting the tool is the retrieval mechanism, not a shortcut around it.**
  "The only content you pass from parent to subagent is the Agent tool's
  prompt string" (Agent SDK subagents) — so anything the hub doesn't already
  know must either be pre-resolved into that one string, or the subagent must
  fetch it itself by holding the tool. A tool omitted from `tools:` "isn't in
  the subagent's session at all" — no prompt, no error, the model just works
  without it.
- **Self-retrieval is the documented default in Anthropic's own multi-agent
  system**, not an edge case: subagents "independently perform web searches,
  evaluate tool results ... and return findings to the LeadResearcher"
  (multi-agent research system). Routing everything through the lead instead
  "prevents information loss" arguments run the other way — copying large
  outputs through conversation history costs tokens and loses fidelity.
- **The compression this buys is large.** A subagent "might explore
  extensively, using tens of thousands of tokens ... but returns only a
  condensed, distilled summary ... often 1,000–2,000 tokens" (effective
  context engineering) — exactly the shape of a documentation lookup that
  informs one implementation decision.
- **The orchestrator becomes an information bottleneck** when it must
  re-serialize a subagent's findings by hand (multi-agent coordination
  patterns) — the argument against hub-only for a genuinely per-dispatch need.
- **Grant narrowly, not broadly.** "Principle of Least Agency": grant the
  narrowest capability that still completes the task, and prefer omitting a
  capability outright over trusting the model not to use it (CISO's guide).
  The Agent SDK states the MCP-specific form of the same rule directly:
  "Prefer `allowedTools` over permission modes for MCP access" — a wildcard
  in `allowedTools` grants exactly the MCP server wanted and nothing more,
  where `bypassPermissions` would also disable unrelated safety prompts.
- **MCP tools ARE inherited by subagents by default**, alongside built-ins,
  unless a closed `tools:` allowlist excludes them (Create custom subagents §
  Available tools) — confirming that this repo's current hub-only posture is
  a deliberate closed-list choice, not a platform limitation.
- **`mcpServers:` frontmatter scopes a server to one subagent** and keeps its
  tool descriptions out of the main conversation's context (same source) —
  strictly better than a bare `tools:` entry when only one spoke needs a
  server, since the hub stops paying for schemas it doesn't use. Requires
  Claude Code v2.1.238+.
- **Permission syntax is tool- or server-scoped**: `mcp__<server>__<tool>`
  names one tool; `mcp__<server>` / `mcp__<server>__*` names the whole server.
  Allow rules must anchor to a literal server segment (an unanchored
  `mcp__*` allow glob is skipped with a warning); deny/ask rules may use bare
  globs (Configure permissions).
- **Tool-count budget is not a constraint here.** Selection accuracy degrades
  above roughly 30–50 loaded tools, and MCP servers can cost tens of thousands
  of tokens in schemas before any work happens (tool search tool; advanced
  tool use) — but `context7` contributes exactly 2 tools, far under either
  threshold, and Claude Code's tool search activates automatically past a
  10%-of-context-window trigger, so this grant does not approach the budget
  that guidance warns about.
- **Do not adopt multi-agent delegation on speculation.** Default to a single
  agent with good tools; multi-agent costs 3–10x the tokens through context
  duplication and coordination overhead, and is justified only against a
  demonstrated bottleneck (when to use multi-agent systems) — supporting a
  narrow, evidence-driven grant (one spoke, one logged need) over a blanket one.

## Contradictions / drift

- The multi-agent research system post reports multi-agent delegation beating
  single-agent by 90.2% at roughly 15x token cost, while "when to use
  multi-agent systems" leads with "default to a single agent" and quotes
  3–10x token cost. Not a real disagreement — different task classes (open-
  ended parallel research vs. a single bounded lookup) — but cite the task
  class alongside either figure rather than the headline number alone.
- A near-conflict, not a contradiction: the Agent SDK MCP docs describe MCP
  tools as requiring "explicit permission before Claude can use them," while
  the CLI/permissions docs describe interactive prompting as the default
  path. These describe different surfaces (SDK/headless has no prompt to
  fall back to) rather than disagreeing on the underlying rule.

## Coverage gaps

- The Claude Code CHANGELOG could not be fetched during this research pass (a
  network call was denied in the researching agent's sandbox); the version
  floors cited above (v2.1.238 for `mcpServers:`, v2.1.248/259 for CLI flags,
  v2.1.221 for MCP discovery caching) come from inline version notes in the
  docs pages themselves, not independently cross-checked against the
  CHANGELOG's own entries.

## Sources

S1: [Create custom subagents](https://code.claude.com/docs/en/sub-agents) (docs, retrieved 2026-09-05)
S2: [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents) (docs, retrieved 2026-09-05)
S3: [How and when to use subagents in Claude Code](https://claude.com/blog/subagents-in-claude-code) (blog, retrieved 2026-09-05)
S4: [Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) (blog, retrieved 2026-09-05)
S5: [CISO's guide to agentic AI](https://claude.com/blog/ciso-guide-to-agentic-ai) (best-practice, retrieved 2026-09-05)
S6: [Configure permissions](https://code.claude.com/docs/en/permissions) (docs, retrieved 2026-09-05)
S7: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) (docs, retrieved 2026-09-05)
S8: [Settings reference](https://code.claude.com/docs/en/settings-reference) (docs, retrieved 2026-09-05)
S9: [Control MCP server access for your organization](https://code.claude.com/docs/en/managed-mcp) (docs, retrieved 2026-09-05)
S10: [Connect to external tools with MCP (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/mcp) (docs, retrieved 2026-09-05)
S11: [CLI reference](https://code.claude.com/docs/en/cli-reference) (docs, retrieved 2026-09-05)
S12: [Security (Claude Code)](https://code.claude.com/docs/en/security) (docs, retrieved 2026-09-05)
S13: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (blog, retrieved 2026-09-05)
S14: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (blog, retrieved 2026-09-05)
S15: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (blog, retrieved 2026-09-05)
S16: [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) (blog, retrieved 2026-09-05)
S17: [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns) (blog, retrieved 2026-09-05)
S18: [Multiagent orchestration (Managed Agents)](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) (docs, retrieved 2026-09-05)
S19: [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) (docs, retrieved 2026-09-05)
S20: [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) (blog, retrieved 2026-09-05)
S21: [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (blog, retrieved 2026-09-05)
S22: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (blog, retrieved 2026-09-05)
S23: [Scale to many tools with tool search (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/tool-search) (docs, retrieved 2026-09-05)
