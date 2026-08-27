# Context window management, compaction, and token efficiency

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> 43 official Anthropic sources. Synthesized: 2026-08-27.
> Sources: [Explore the context window](https://code.claude.com/docs/en/context-window),
> [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works),
> [Model configuration](https://code.claude.com/docs/en/model-config),
> [Settings reference](https://code.claude.com/docs/en/settings-reference),
> [Environment variables](https://code.claude.com/docs/en/env-vars),
> [Slash commands](https://code.claude.com/docs/en/commands),
> [Manage costs effectively](https://code.claude.com/docs/en/costs),
> [Troubleshooting](https://code.claude.com/docs/en/troubleshooting),
> [How Claude remembers your project](https://code.claude.com/docs/en/memory),
> [Subagents](https://code.claude.com/docs/en/sub-agents),
> [Customize your status line](https://code.claude.com/docs/en/statusline),
> [Session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context),
> [Claude Academy: Context management](https://academy.claude.com/courses/claude-code-101/context-management),
> [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows),
> [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction),
> [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
> [Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context),
> [Cookbook: Context engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools),
> [Cookbook: Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction),
> [Cookbook: Session memory compaction](https://platform.claude.com/cookbook/misc-session-memory-compaction),
> [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
> [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
> [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps),
> [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
> [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them),
> [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
> [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
> [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk),
> [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
> [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management),
> [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices),
> [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
> [Extend Claude with skills](https://code.claude.com/docs/en/skills),
> [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp),
> [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching),
> [Prompt caching (API)](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
> [Output styles](https://code.claude.com/docs/en/output-styles),
> [Hooks reference](https://code.claude.com/docs/en/hooks),
> [Monorepo / large codebase setup](https://code.claude.com/docs/en/large-codebases),
> [Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more),
> [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills),
> [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
> [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything).

## Consensus / best practices

### The governing principle

Find "the smallest possible set of high-signal tokens that maximize the
likelihood of some desired outcome" — context is a finite resource with
diminishing (and eventually negative) returns [S21, S27]. **Context rot** is
architectural: as token count grows, accuracy and recall degrade, because
attention scales quadratically with context length [S14, S21]. More context
window is not automatically better; curation matters more than capacity.

### Compaction mechanics (Claude Code)

- Automatic compaction fires at a threshold: with no window explicitly set,
  Claude Code compacts near the model's context limit; several models have
  documented exceptions (Sonnet 4.6/Opus 4.6 without extended context, and
  Opus 4.8/5 on 200K-only providers, compact at the 200K boundary regardless;
  Sonnet 5 auto-compacts at ~967K by default) [S3].
- Precedence for the compaction window, highest wins: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  (env, plain token count) > `--autocompact <size|auto>` (CLI flag) >
  `/autocompact <size|auto>` (saves `autoCompactWindow` to user settings, but a
  higher-priority settings scope can still override it) [S3]. `autoCompactEnabled`
  (settings.json) toggles automatic compaction on/off; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
  (1–100) sets the percentage-of-window trigger point [S4, S5].
- **What survives compaction**: system prompt and output style are unchanged;
  the project-root `CLAUDE.md`, unscoped `.claude/rules/*.md`, auto memory
  (`MEMORY.md`), and the plan-mode plan are re-injected from disk; up to five
  most-recently-modified read/edited files are re-read (a file over 5,000
  tokens returns as a path reference only); invoked skill _bodies_ re-inject
  capped at 5,000 tokens/skill and 25,000 tokens total, oldest dropped first —
  put critical instructions at the top of `SKILL.md`; the skill _listing_ is
  NOT re-injected; `paths:`-scoped rules and nested `CLAUDE.md` reload only
  when a matching file is next read; `SessionStart` hooks matching source
  `compact` re-run [S1].
- Mechanically, Claude Code **clears older tool outputs first, then
  summarizes** the conversation if that alone isn't enough; requests and key
  code snippets are preserved, but early detailed instructions may be lost —
  persistent rules belong in `CLAUDE.md`, not early conversation turns [S2].
  A "Compact Instructions" section in `CLAUDE.md`, or `/compact <focus>`,
  steers what a summary preserves [S2, S7].
- If a huge file or tool output refills context after each summarization
  pass, Claude Code stops auto-compacting after a few attempts with a
  "thrashing" error rather than looping forever [S2, S8]. Recovery: read the
  file in line ranges, `/compact keep only the plan and the diff`, delegate to
  a subagent, or `/clear` [S8].
- `/context [all]` gives a live, colored-grid usage view with optimization
  suggestions and shows which `CLAUDE.md`/memory files loaded [S1, S6].
  `/compact` itself re-reads the whole conversation, so compacting a large
  context is an expensive request; `/clear` costs nothing [S7]. `/rewind` →
  "Summarize from here / up to here" allows partial, targeted compaction [S1].

### Compaction mechanics (API — beta features this repo doesn't currently use)

- Server-side `compact_20260112` (beta `compact-2026-01-12`): trigger type is
  `input_tokens` only, default 150,000, minimum 50,000. `instructions`
  **completely replaces** the default summary prompt, does not supplement it.
  `pause_after_compaction: true` returns `stop_reason: "compaction"`,
  letting a caller inject blocks before resuming — usable as a
  total-token-budget governor [S15].
- `clear_tool_uses_20250919` (context editing): default trigger 100,000 input
  tokens, `keep` 3 tool uses; `clear_at_least`, `exclude_tools`, and
  `clear_tool_inputs` (default false) are configurable. Tool-result clearing
  invalidates the prompt cache; `clear_thinking_20251015` (which must run
  first if combined) does not [S16].
- Tool-runner-level `compaction_control` (cookbook, distinct API shape from
  `compact_20260112`): default `context_token_threshold` 100k; guidance is
  5k–20k for independent sequential items, 50k–100k multi-phase, 100k–150k
  when history matters; skip compaction under 50k–100k, for audit-trail work,
  or for server-side sampling loops where cache tokens accumulate
  unpredictably [S19].
- Benchmarked impact: memory tool + context editing together = 39%
  improvement; context editing alone = 29%; a 100-turn web-search eval cut
  token consumption 84% and completed workflows that otherwise failed on
  context exhaustion [S30].

### The three long-horizon techniques

1. **Compaction** — summarize near the limit; maximize recall first, then
   prune. Tool-result clearing is "one of the safest, lightest-touch forms of
   compaction" [S21].
2. **Sub-agent architectures** — a subagent explores with tens of thousands of
   tokens and returns a condensed 1,000–2,000-token summary; "the detailed
   search context remains isolated within sub-agents, while the lead agent
   focuses on synthesizing" [S21, S24]. Each subagent runs its own context
   window: only its final message returns to the parent [S10].
3. **Structured note-taking / agentic memory** — notes persisted outside the
   context window, so information survives even a full reset [S21, S29].

### Durable artifacts over in-place summarization

For genuinely long-running work, prefer external scaffolding — a progress
file plus git history — over relying on compaction alone: "git commits
eliminated the need for an agent to have to guess at what had happened" [S22].
A stronger, related claim from a separate post: full context **resets** with
structured artifact handoffs outperform in-place summarization, avoiding
coherence loss and "context anxiety" (a model prematurely wrapping up near a
perceived limit) [S23]. See **Contradictions** below — this is in tension with
the platform docs' framing of compaction as "primary."

The Memory tool's protocol makes the assumption explicit: "ASSUME
INTERRUPTION: Your context window might be reset at any moment" [S29]. Both
compaction and memory should be used together for long-running agents:
"compaction keeps the active context small... memory preserves the
information that must survive summarization" [S29].

### Subagents

- Use subagents for: verbose output that would pollute the main thread, tool
  restriction, self-contained work returning a summary, and parallel
  investigation. Stay in the main conversation when work needs iterative
  back-and-forth or when phases share significant context [S10].
- Three valid reasons to fan out: context protection (a subtask would
  generate 1,000+ irrelevant tokens), parallelization (worth the 3–10x token
  cost), and specialization (20+ tools causes tool-selection errors) [S25].
  Multi-agent research systems use ~15x the tokens of chat and are a poor fit
  where agents must share context or work is highly interdependent — most
  coding falls in that category [S24].
- Decompose by **context requirements**, not by problem phase — splitting
  planning/implementation/testing into separate agents adds coordination
  overhead; the agent that writes a feature should write its tests [S25].
- A subagent's fresh context loads its own system prompt, task message, the
  full `CLAUDE.md` hierarchy, git status, and preloaded skills — **except**
  the built-in `Explore` and `Plan` agents, which skip `CLAUDE.md` and git
  status to stay fast and cheap. Output style, parent auto memory, and
  conversation history never reach a subagent (a context-forked subtask is
  the one exception) [S9, S10]. A subagent's context window is sized by its
  own model — delegating to Haiku gives it a smaller window [S10].
- The verification-subagent pattern consistently works, but needs explicit
  anti-shortcut instructions ("run the complete test suite before marking as
  passed") — left unguided, models "tend to respond by confidently praising
  the work" [S23, S25]. Prefer rules-based verification (linting, type
  checking) over LLM-as-judge where possible [S28].

### Always-loaded context: `CLAUDE.md`, memory, and rules

- Target **under 200 lines** per `CLAUDE.md`; longer files consume more
  context and reduce instruction adherence — "bloated CLAUDE.md files cause
  Claude to ignore your actual instructions" [S9, S31]. The conciseness test:
  for each line, ask "would removing this cause Claude to make mistakes?" If
  not, cut it [S31].
- `@path` imports are expanded at launch (max 4 hops) and **"help
  organization but don't reduce context"** — an import is not a scoping
  mechanism, it's a paste [S9]. Path-scoped `.claude/rules/*.md` load only
  when Claude reads a matching file — this is the actual scoping lever [S9].
- Auto-memory `MEMORY.md` loads only its first 200 lines or 25KB, whichever
  comes first — an over-limit write returns an error telling Claude to
  rewrite the index rather than growing unbounded [S9]. A `CLAUDE.md` over
  4 MiB is skipped entirely, not loaded partially [S9]. `/doctor` proposes
  trims (cutting content Claude can already derive from the codebase) [S9].
- Representative startup budget on a 200k window: system prompt ~4,200 tokens;
  project `CLAUDE.md` ~1,800; user `CLAUDE.md` ~320; skill descriptions ~450;
  auto memory ~680; MCP tool names (deferred) ~120; env info ~280 [S1].
- Named CLAUDE.md failure patterns: the kitchen-sink session, the
  over-specified CLAUDE.md, infinite exploration (fixed by scoping or
  delegating to a subagent) [S31]. Emphasize with `IMPORTANT` on at most one
  line — emphasizing many lines makes none of them stand out [S31].
- Decision table by context cost, highest to lowest: root `CLAUDE.md` (high —
  "every line costs tokens whether relevant or not") > path-scoped rules
  (medium) > skills/hooks (low) > subagents (very low, isolated windows)
  [S40]. Anti-patterns: "always do Y"/"never do this" rules belong in hooks,
  not `CLAUDE.md`; a 30-line procedure belongs in a skill [S40]. Splitting a
  root vs. per-directory `CLAUDE.md` so only relevant conventions load is the
  standard large-codebase pattern; starting a session from a subdirectory is
  the cheapest scoping lever available [S39].

### Skills as progressive disclosure

- Three-level disclosure: metadata (name + description) is pre-loaded into
  the system prompt at every session start; the `SKILL.md` body loads only
  when the skill triggers; bundled reference files/scripts load only on
  demand — making bundled context "effectively unbounded" relative to the
  metadata cost [S41]. But once a skill body loads, **it stays in context for
  the rest of the session** — every line is a recurring cost, not a one-time
  one [S33].
- Keep `SKILL.md` body under 500 lines; frontmatter `name` ≤ 64 chars,
  `description` ≤ 1,024 chars (API/spec validation limit) [S32]. Keep
  reference files one level deep from `SKILL.md` — nested references get
  truncated by a partial `head -100` read pattern; a reference file over 100
  lines should carry its own table of contents [S32].
- The skill _listing_ (all descriptions shown up front, regardless of
  trigger) is capped separately: `skillListingBudgetFraction` defaults to
  1% of the model's context window; the Claude Code listing truncates
  `description` + `when_to_use` combined at 1,536 characters — a narrower,
  presentation-layer cap layered on top of the 1,024-char spec limit, not a
  contradiction of it [S32, S33]. On overflow, descriptions are dropped
  starting with the least-invoked skills [S33]. `disable-model-invocation: true`
  removes a skill's description from the listing entirely — appropriate for
  user-only skills [S33]. `/doctor` estimates the listing's context cost
  [S33].

### MCP servers and tool output

- MCP tool output warns at 10,000 tokens and is capped at 25,000 tokens per
  call by default, configurable via `MAX_MCP_OUTPUT_TOKENS`; a per-tool
  `_meta["anthropic/maxResultSizeChars"]` can override up to a hard 500,000
  character ceiling [S34]. Server descriptions/instructions truncate at 2KB
  each [S34].
- Claude Code caps tool responses at 25,000 tokens generally and steers
  models toward "many small and targeted searches instead of a single broad
  search" [S26]. Curate tool results: pagination, range selection, filtering,
  sensible truncation defaults. Offering a `ResponseFormat` enum
  (concise/detailed) measured concise at ~1/3 the tokens of detailed; resolve
  UUIDs to semantic names to reduce hallucination [S26].
- Tool-definition loading itself is deferrable: `ENABLE_TOOL_SEARCH=true`
  (with `auto`/`auto:N` threshold, default 10% of context) defers tool
  definitions until needed rather than loading them all upfront [S34].
  Presenting MCP servers as code APIs rather than direct tool calls (code
  execution with MCP) reduced measured context overhead by up to 98.7% in one
  benchmark, since intermediate results stay in the execution environment and
  only logged/returned values reach the model [S42]. Tool search alone cut
  tool-definition tokens by 85%+ in the same measurement [S42].
- Rollout order suggested for the four composable context-cost levers on tool
  use: prompt caching (day one) → tool search (once past ~20 tools) → context
  editing (once conversations run long) → programmatic tool calling (for
  repetitive chains) [S17].

### Prompt caching

- Three cache layers: system prompt → project context → conversation. Prefix
  matching is exact — any prefix change recomputes everything after it, so
  order context by volatility (static system prompt/tools first, `CLAUDE.md`
  next, session context, then messages) [S35, S43].
- Cache-busting actions: model switch, effort-tier change, fast-mode toggle,
  MCP connect/disconnect (when tools sit in the cached prefix), plugin MCP
  changes, a bare-tool-name deny rule, `/compact`, a Claude Code version
  upgrade [S35]. Cache-safe: file edits, mid-session `CLAUDE.md` edits (which
  also don't apply until `/clear` regardless), output-style change,
  permission-mode change, skill/command invocation, `/recap`, `/rewind` [S35].
- TTL defaults: the **main conversation** gets 1 hour on a subscription within
  plan usage, 5 minutes on usage credits/API key/cloud; **everything else —
  subagents, workflows, compaction — gets 5 minutes** [S35]. Override via
  `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` and
  `subagentPromptCacheTtl` (Claude Code v2.1.242+); `FORCE_PROMPT_CACHING_5M=1`
  overrides everything [S35]. Cache writes cost 1.25x base input (2x for the
  1-hour TTL); reads cost ~0.1x [S36].
- **Cache is scoped per machine + directory — each worktree misses the
  others' cache** [S35]. This is directly relevant to this repo's
  worktree-heavy workflow (ADR-0013/0014): spoke-heavy work in a freshly
  created worktree pays full cache-creation cost with no shared-checkout
  discount.

### Hooks and output surfacing

- Only `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart` hooks add
  plain-text stdout directly to Claude's context; most other hook stdout goes
  to the debug log only. A blocking hook's stderr is preserved in context so
  Claude knows why a call was denied [S38]. No hook-output size cap is
  documented — this is a genuine gap, not evidence of "unlimited" [S38].
- The status line is the documented, supported way to display a continuous
  context-window usage indicator (a color-coded context bar) alongside cost
  and git state — it receives session JSON on stdin [S11].

### Cost-reduction checklist (Anthropic's own list)

`/clear` between unrelated tasks; `/compact <instructions>` with a
focus; pick the cheapest adequate model (`model: haiku` for simple
subagents); prefer CLI tools over MCP servers where equivalent; disable
unused MCP servers; offload preprocessing to hooks (e.g. a 10k-line log
reduced to a few hundred tokens before it ever reaches the model); move
detailed instructions out of `CLAUDE.md` into skills; keep `CLAUDE.md` under
200 lines; lower `MAX_THINKING_TOKENS` on fixed-budget (non-adaptive-reasoning)
models; delegate verbose operations to subagents [S7]. `/usage` shows
per-session token totals with attribution by skill/subagent/plugin/MCP server,
plus behavior flags (long context, cache misses) once they cross 10% of
recent usage [S7].

## Contradictions / drift

- **Compaction-as-primary vs. reset-as-primary.** The platform compaction
  docs state server-side compaction is "the primary strategy for most
  long-running agentic conversations," with context editing covering
  specialized cases [S14]. A separate engineering post on harness design for
  long-running application development argues the opposite emphasis: full
  context **resets** with structured artifact handoffs outperform in-place
  summarization, because summarization loses coherence and induces
  premature-wrap-up behavior [S23]. Both are current (2026); neither
  supersedes the other explicitly. Read as scope-dependent rather than
  contradictory: [S14] is the general default for ordinary agentic
  conversations; [S23] is specifically about long-running autonomous
  _application-building_ sessions, where the artifact-handoff pattern was
  measured to outperform. **This repo's compaction-trigger design (PR 4 of
  the accompanying plan) follows [S23]'s position** — write a durable handoff
  artifact on `PreCompact` rather than relying on the in-place summary alone
  — because the repo's own incident history (subagent truncation, not hub
  compaction) already validated the external-artifact pattern at the spoke
  level; ADR-0078 records this choice explicitly.
- **Two different `compaction_control` shapes.** The cookbook's tool-runner
  `compaction_control` / `context_token_threshold` (default 100k) is a
  different API surface and default from the documented server-side
  `compact_20260112` `trigger.value` (default 150k, minimum 50k) [S15, S19].
  Don't mix the two vocabularies when reading either source — they aren't the
  same lever.
- **Two `description` character limits that look contradictory but aren't.**
  Skill-authoring best practices state the `description` field's hard limit
  is 1,024 characters (API/spec validation) [S32]; the Claude Code skills
  page describes a 1,536-character truncation on `description` +
  `when_to_use` **combined**, in the listing specifically [S33]. These are
  different layers (spec validation vs. a presentation-layer truncation) —
  easy to misread as disagreeing when they aren't measuring the same thing.
- **`autoCompactEnabled`/`autoCompactWindow` (settings) vs.
  `CLAUDE_CODE_AUTO_COMPACT`/`CLAUDE_CODE_AUTO_COMPACT_WINDOW` (env)** — both
  exist and no single page states their full interaction. [S3] resolves
  precedence for the _window_ value only (env > CLI flag > `/autocompact`);
  no source states the equivalent precedence for the on/off _toggle_. Treat
  this as unresolved rather than inferring an order.

## Coverage gaps

- **"Microcompaction" has no official documentation on any allowlisted
  Anthropic domain.** The only non-generic discussion found is a user-filed
  bug report on the official `anthropics/claude-code` GitHub repo
  (issue #42542), describing three separate undocumented mechanisms
  ("microcompact," "cached microcompact," "session memory compact") with a
  93%-pressure threshold claim. That is user-authored content in an Anthropic
  repo, not Anthropic guidance — its specifics are unverified and should not
  be built against. The only _official_ statement of the underlying behavior
  is the generic line in [S2]: "it clears older tool outputs first, then
  summarizes the conversation if needed." Threshold, keep-count, and UI
  surfacing of that tool-output-clearing pass are undocumented.
- **`MAX_MCP_OUTPUT_TOKENS` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` default
  values** are not stated on the environment-variables page in the excerpt
  retrieved — the variable names are confirmed official; their numeric
  defaults are not documented in the retrieved text.
- **Hook stdout size limits** are undocumented (see Hooks and output
  surfacing above) — treat as an open question, not "no limit."

## Sources

S1: [Explore the context window](https://code.claude.com/docs/en/context-window) (docs)
S2: [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) (docs)
S3: [Model configuration](https://code.claude.com/docs/en/model-config) (docs)
S4: [Settings reference](https://code.claude.com/docs/en/settings-reference) (docs)
S5: [Environment variables](https://code.claude.com/docs/en/env-vars) (docs)
S6: [Slash commands](https://code.claude.com/docs/en/commands) (docs)
S7: [Manage costs effectively](https://code.claude.com/docs/en/costs) (docs)
S8: [Troubleshooting](https://code.claude.com/docs/en/troubleshooting) (docs)
S9: [How Claude remembers your project](https://code.claude.com/docs/en/memory) (docs)
S10: [Subagents](https://code.claude.com/docs/en/sub-agents) (docs)
S11: [Customize your status line](https://code.claude.com/docs/en/statusline) (docs)
S12: [Session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context) (blog)
S13: [Claude Academy: Context management](https://academy.claude.com/courses/claude-code-101/context-management) (guide)
S14: [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) (docs)
S15: [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) (docs, beta)
S16: [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (docs)
S17: [Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) (docs)
S18: [Cookbook: Context engineering — memory, compaction, tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) (guide)
S19: [Cookbook: Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction) (guide)
S20: [Cookbook: Session memory compaction](https://platform.claude.com/cookbook/misc-session-memory-compaction) (guide)
S21: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (engineering blog)
S22: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (engineering blog)
S23: [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) (engineering blog)
S24: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (engineering blog)
S25: [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) (blog)
S26: [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (engineering blog)
S27: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (engineering blog)
S28: [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) (blog)
S29: [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (docs)
S30: [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management) (blog)
S31: [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) (docs)
S32: [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) (docs)
S33: [Extend Claude with skills](https://code.claude.com/docs/en/skills) (docs)
S34: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) (docs)
S35: [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching) (docs)
S36: [Prompt caching (API)](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (docs)
S37: [Output styles](https://code.claude.com/docs/en/output-styles) (docs)
S38: [Hooks reference](https://code.claude.com/docs/en/hooks) (docs)
S39: [Monorepo / large codebase setup](https://code.claude.com/docs/en/large-codebases) (docs)
S40: [Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) (blog)
S41: [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) (engineering blog)
S42: [Code execution with MCP: building more efficient AI agents](https://www.anthropic.com/engineering/code-execution-with-mcp) (engineering blog)
S43: [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) (blog)
