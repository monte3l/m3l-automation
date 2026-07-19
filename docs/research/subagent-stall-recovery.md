# Preventing and recovering from subagent stalls and mid-turn truncation

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> 29 official Anthropic sources. Synthesized: 2026-07-19.
> Sources: [Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons),
> [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop),
> [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming),
> [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting),
> [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets),
> [Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages),
> [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
> [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
> [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
> [Orchestrator workers (Cookbook)](https://platform.claude.com/cookbook/patterns-agents-orchestrator-workers),
> [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them),
> [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns),
> [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
> [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
> [Building Effective AI Agents (mirror)](https://www.anthropic.com/research/building-effective-agents),
> [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management),
> [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
> [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction),
> [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
> [How Claude remembers your project](https://code.claude.com/docs/en/memory),
> [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents),
> [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
> [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage),
> [Rewind file changes with checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing),
> [Create custom subagents](https://code.claude.com/docs/en/sub-agents),
> [Using agent memory (Managed Agents)](https://platform.claude.com/docs/en/managed-agents/memory),
> [Manage sessions (Claude Code)](https://code.claude.com/docs/en/sessions),
> [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
> [Hooks reference](https://code.claude.com/docs/en/hooks).

## Consensus / best practices

### Detection

- The Messages API `stop_reason` enum (`end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use`, `pause_turn`, `refusal`,
  `model_context_window_exceeded`) is the ground-truth completion signal;
  `max_tokens`/`model_context_window_exceeded` mean truncated. [S1]
- The Agent SDK's `ResultMessage.subtype` is the equivalent SDK-level signal:
  `success` (the only subtype where the `result` text field is present),
  `error_max_turns`, `error_max_budget_usd`, `error_during_execution`,
  `error_max_structured_output_retries`. Never read a spoke's narrated "final"
  text as authoritative without checking this first. [S2]
- As of **Claude Code v2.1.199**, a foreground subagent that already produced
  text before truncating returns that **partial output plus an explicit
  "didn't finish" note** — stronger than inferring truncation from a bare
  fragment. A subagent that produced nothing instead fails outright
  ("terminated early due to an API error"); a connection/process failure
  yields **no result message at all** — a third, distinct stall shape. [S28]
- `SubagentStop` and `PreCompact`/`PostCompact` hooks exist and can inspect a
  finished spoke (`agent_id`, `agent_type`, `last_assistant_message`) or a
  compaction event, and can block to force-continue. [S29]
- Pre-empt truncation: the `count_tokens` endpoint estimates input tokens
  before sending; the beta `task_budget` gives the model a soft, model-visible
  countdown across an agentic loop (Messages API only — not supported on the
  Agent SDK/Claude Code, which use `maxTurns`/`maxBudgetUsd` instead). [S1, S5]

### Orchestrator-worker design (preventing stalls)

- Give every subagent an objective, output format, tool/source guidance, and
  **clear task boundaries** — vague instructions cause duplicated work or
  scope misinterpretation. [S7]
- **Scale effort to complexity explicitly**: simple fact-finding gets 1
  agent/3–10 tool calls; complex research gets 10+ subagents with divided
  responsibilities. Early failure modes included spawning 50 subagents for a
  simple query and endless search for nonexistent sources — prompt
  engineering, not more compute, was the fix. [S7]
- Teach agents an explicit **STOP** condition — recognizing when they have
  sufficient information — and bound worker tasks to ~2–3 approaches with a
  defined output format. [S7, S10]
- Bound tool responses (Claude Code caps at 25,000 tokens by default);
  paginate/filter/truncate with sensible defaults; prefer many small targeted
  searches over one broad one. [S9]
- Default to a single agent — multi-agent adds failure points and 3–10x token
  cost; justify it by genuine context isolation, parallelization, or
  specialization, and decompose by required context, not by problem type.
  Orchestrator-subagent coordination fits low-interdependence tasks; without
  a maximum limit or convergence threshold, loops stall or cycle. [S11, S12]

### Context management (preventing exhaustion)

- **Context rot** is real: recall degrades as token count grows, independent
  of window size — curate the smallest high-signal context rather than
  defaulting to a bigger budget. [S14]
- Four curation levers: **compaction** (server-side auto-summarization,
  default trigger 150k input tokens), **context editing/clearing** (clears
  stale tool results, default trigger 100k), **structured note-taking /
  external memory** (a memory-tool file store, or a plain progress file), and
  **sub-agent context isolation** (a subagent explores in tens of thousands of
  tokens but returns only a **1,000–2,000-token distilled summary**). [S14,
  S17, S18, S19]
- Long-running agents work in memory-less discrete sessions — bridge them with
  a progress file (e.g. `claude-progress.txt`) plus git commits as recovery
  artifacts, and have each new session "get its bearings" by reading them
  before resuming. One source found compaction alone insufficient
  ("context anxiety") and made hard context resets essential on top of it —
  the more recent, task-specific finding; treat compaction and external
  progress files as complementary, not either/or. [S13, S16, S18]

### Recovery, resumption, and checkpointing

- "Build systems that resume from where the agent was when errors occurred,"
  not restart — backed by retry logic, regular checkpoints, and graceful
  degradation. [S7]
- SDK subagents are **resumable**: capture `session_id`/`agentId` and pass
  `resume` rather than re-dispatching fresh — a fresh dispatch has no memory
  of prior exploration and restarts the whole budget from zero. On
  `error_max_turns`, the documented recovery is resuming the saved session
  with a higher limit. [S2, S28]
- Git/file checkpointing recovers bad edits; conversation resume (sessions)
  and file rewind (checkpointing) are complementary mechanisms covering
  different state — and are mutually exclusive with a `SessionStore` external
  mirror by design. [S22, S23, S24]
- A durable session/event log outside the harness lets a rebooted harness
  resume from the last event rather than needing in-process state to survive
  a crash. [S21]

## Contradictions / drift

- **Compaction sufficiency**: the compaction docs frame server-side
  compaction as the _recommended primary_ strategy for long-running
  conversations [S18], while the long-running-harnesses post found compaction
  alone _insufficient_ and made hard context resets essential on top of it
  [S13]. Not a hard contradiction — reconciled by treating compaction as
  necessary-but-not-sufficient; the harness post is the more recent,
  task-specific source and should win when the two disagree on emphasis.
- **Single vs. multi-agent default**: "When to use multi-agent systems"
  defaults to a single agent (multi-agent costs 3–10x more tokens) [S11],
  while the multi-agent research system post fans out aggressively [S7]. Both
  are current; reconciled by effort-scaling — start single, escalate fan-out
  only when the task's complexity and context-isolation needs justify it.
- **Task budgets vs. SDK budgets**: not a conflict but a scope boundary — the
  beta `task_budget` field is Messages-API-only on specific models; the Agent
  SDK/Claude Code use `maxTurns`/`maxBudgetUsd` + `ResultMessage` subtypes for
  the analogous goal instead. [S5, S2]

## Coverage gaps

- No official source names "stall detection" as a single end-to-end concept —
  it's assembled across the `stop_reason`, `ResultMessage.subtype`,
  streaming, and hooks references.
- No documented **wall-clock/idle timeout** or generic hung-subagent watchdog
  for a subagent that is alive but not producing anything — bounding is
  `maxTurns`/`maxBudgetUsd` plus API-error early termination and
  resumability; `TeammateIdle` is the only idle signal found, and it is
  scoped to agent teams, not generic subagent dispatch.
- No official term "hub-and-spoke" — Anthropic's vocabulary is
  "orchestrator-worker" / "orchestrator-subagent."

## Sources

- S1: [Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- S2: [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- S3: [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- S4: [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- S5: [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets)
- S6: [Using the Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)
- S7: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- S8: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- S9: [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- S10: [Orchestrator workers (Cookbook)](https://platform.claude.com/cookbook/patterns-agents-orchestrator-workers)
- S11: [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- S12: [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)
- S13: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- S14: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- S15: [Building Effective AI Agents (mirror)](https://www.anthropic.com/research/building-effective-agents)
- S16: [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management)
- S17: [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- S18: [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- S19: [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- S20: [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- S21: [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- S22: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- S23: [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- S24: [Rewind file changes with checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- S25: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- S26: [Using agent memory (Managed Agents)](https://platform.claude.com/docs/en/managed-agents/memory)
- S27: [Manage sessions (Claude Code)](https://code.claude.com/docs/en/sessions)
- S28: [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents)
- S29: [Hooks reference](https://code.claude.com/docs/en/hooks)
