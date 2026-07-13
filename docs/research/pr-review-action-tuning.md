# Claude PR Review Action tuning for this repo's PR-size profile

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from 35
> official Anthropic sources (`code.claude.com`, `platform.claude.com`,
> `claude.com`, `anthropic.com/engineering`, and `github.com/anthropics/claude-code-action`).
> Synthesized: 2026-07-13. Full source list: see [Sources](#sources) below.

## Why this exists

A 2026-07-13 audit of 121 merged PRs in this repo found: mean 940.7 total
changes / 14.6 changed files per PR, median 424 / 10 (the mean is skewed
upward by large submodule/script-implementation PRs), p90 2,667 / 35, max
observed 5,029 / 71. This snapshot captures what official Anthropic sources
say about tuning `claude-pr-review.yml` (built on
`anthropics/claude-code-action`) for PRs of that size, so the reasoning behind
the resulting workflow/doc changes is traceable later without re-running the
research.

## Consensus / best practices

- **No diff-size threshold is published for `max_turns`, `timeout_minutes`,
  or model tier.** The action's own docs give only general advice ("5–15
  turns for most tasks," "configure appropriate timeouts") [S1, S2, S30, S33].
  The separate, paid Code Review product _does_ scale its internal agent
  fleet by PR complexity (84% of 1,000+-line PRs surface findings vs. 31% of
  <50-line PRs; ~$15–25/review, ~20 min average) but exposes none of that
  scaling logic to the GitHub Action's config surface [S9, S14].
- **`timeout_minutes` moved to job-level GitHub Actions config in the
  action's v1.0**, no longer an action input — set at
  `jobs.<job-id>.timeout-minutes` [S2].
- **Effort-tuning before model-switching is the official lever hierarchy**:
  raise effort within a model tier before downgrading/upgrading models; a
  smaller model at high effort can cost _more_ tokens than a larger model at
  lower effort for equivalent quality [S11, S12]. This repo's
  `docs/contributing/model-selection.md` step 5 ("escalate on evidence: raise
  effort first, then one tier") already follows this.
- **No official model-tier recommendation exists specifically for automated
  PR review** — Sonnet is the de facto default in the action's own examples,
  and general complexity-based routing (Haiku < Sonnet < Opus) is the only
  published principle, not a review-specific decision tree [S1, S10, S13,
  S15].
- **The action truncates diffs at ~150,000 characters** to fit the context
  window [S1]. This repo's max observed PR (5,029 lines / 71 files) could
  plausibly approach that in raw patch-character terms, which is why a
  truncation-risk warning was added to the workflow (see
  `.github/workflows/claude-pr-review.yml`'s metrics step).
- **File exclusion has no `.claudeignore` mechanism** in `claude-code-action`
  — the only documented lever is `.claude/settings.json` (or a job-level
  `settings` input) `permissions.deny` on `Read` [S3, S8]. **This does not
  apply cleanly to this repo's architecture**: `claude-pr-review.yml`
  pre-computes the entire PR diff into one `.claude-pr-diff.patch` file that
  the reviewer reads wholesale via a single `Read` call — a `Read` deny rule
  on a specific path is never consulted, because that path's diff is already
  inlined in the one patch file. The practical fix is stripping the
  low-value hunk (`pnpm-lock.yaml`) out of the patch at generation time
  instead — see the workflow's "Pre-compute PR diff for review" step.
- **Prompt caching does not benefit this workflow's shape.** All caching
  guidance emphasizes multi-turn/repeated-context reuse — a single-shot
  review request pays the 25% cache-write penalty with no follow-up read to
  amortize it against [S18, S19, S20, S23]. Caching is out of scope unless
  the review were restructured into multiple passes over the same diff
  content.
- **Context management for large inputs favors chunked reads and subagent
  isolation over stuffing full content.** This repo's review prompt already
  instructs "read the patch in chunks with `Read` offset/limit" for very
  large diffs [S24, S30] — already aligned with official guidance.
- **Read-only review jobs should scope `allowedTools` narrowly** — the
  action's own PR-review example allows only
  `Bash(gh pr diff/view/comment:*)` plus an inline-comment tool [S4, S5].
  This repo's `Bash,Read` is broader (it reads the pre-computed patch file
  directly rather than shelling out to `gh pr diff` per-turn, which is a
  deliberate turn-budget optimization, not an oversight).

## Contradictions / drift

- **Single-turn caching benefit** — the Prompt Caching blog [S19] lists
  code-review-adjacent use cases among caching's benefits, but the GitHub
  Actions docs [S1] are silent on whether a one-shot PR-review request
  benefits at all. Resolved: it doesn't, per the mechanics (write penalty,
  no read) — S1 is more directly applicable to this workflow's shape than
  S19's general use-case list.
- **Document-position guidance vs. context-sparseness guidance** — Prompting
  best practices [S31] says to place large documents near the top of the
  prompt for up to 30% quality improvement; Effective context engineering
  [S25] says to curate content sparingly rather than stuffing exhaustively.
  Not a real conflict: they optimize different axes (position vs. density) —
  place the diff at/near the top, but don't pad it with unnecessary
  surrounding content.
- **`track_progress` silently widens `allowedTools`** — the Configuration
  Guide's read-only example [S3] conflicts with an open action bug [S6]:
  enabling `track_progress: true` adds write tools (Edit, Write, git
  commands) that override an explicit `--allowedTools` read-only
  restriction. Not applicable here — this workflow does not set
  `track_progress`.

## Coverage gaps

- No published diff-size threshold for switching review strategy (splitting
  into passes, escalating model, sampling instead of full-reading, or
  declining review outright) — confirmed absent across all five research
  facets (action config, model selection, prompt caching, context
  management, cost/timeout).
- No numeric `timeout-minutes` recommendation — only the qualitative "~20
  minutes average" cost-estimation figure from the Code Review product,
  which is a different product than the GitHub Action.
- No PR-review-specific file-exclusion guidance — the general
  `permissions.deny` mechanism exists, but no official example targets a
  review-only job's diff-content exclusion the way this repo needed
  (pre-computed single-patch-file architecture).

## Sources

- S1: Claude Code GitHub Actions docs — <https://code.claude.com/docs/en/github-actions> (docs)
- S2: Migration Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/migration-guide.md> (guide)
- S3: Configuration Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/configuration.md> (guide)
- S4: Usage Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md> (guide)
- S5: PR Review Example — <https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml> (guide)
- S6: GitHub Issues — track_progress vs allowedTools — <https://github.com/anthropics/claude-code-action/issues/860> / #533 (issue)
- S7: GitHub Issues — sticky comment limitations — <https://github.com/anthropics/claude-code-action/issues/419> / #705 / #1108 / #1052 (issue)
- S8: Claude Code Settings Docs — <https://code.claude.com/docs/en/settings> (docs)
- S9: Code Review Blog Post — <https://claude.com/blog/code-review> (blog)
- S10: Platform Docs — Choosing the Right Model — <https://platform.claude.com/docs/en/about-claude/models/choosing-a-model> (docs)
- S11: Platform Docs — Effort Parameter — <https://platform.claude.com/docs/en/build-with-claude/effort> (docs)
- S12: Claude Code Blog — Model & Effort in Claude Code — <https://claude.com/blog/claude-model-and-effort-level-in-claude-code> (blog)
- S13: Claude by Anthropic — Choosing the Right Claude Model — <https://claude.com/resources/tutorials/choosing-the-right-claude-model> (guide)
- S14: Code Review Docs — <https://code.claude.com/docs/en/code-review> (docs)
- S15: Anthropic Research — Building Effective Agents — <https://www.anthropic.com/research/building-effective-agents> (whitepaper)
- S16: Claude Blog — Building Multi-Agent Systems — <https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them> (blog)
- S17: Claude Code — Subagents — <https://claude.com/blog/subagents-in-claude-code> (blog)
- S18: Platform Docs — Prompt Caching Guide — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> (docs)
- S19: Blog — Prompt Caching with Claude — <https://claude.com/blog/prompt-caching> (blog)
- S20: Claude Cookbook — Prompt Caching — <https://platform.claude.com/cookbook/misc-prompt-caching> (best-practice)
- S21: Docs — Tool Use with Prompt Caching — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching> (docs)
- S22: Docs — Cache Diagnostics — <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics> (docs)
- S23: Blog — Token-Saving Updates — <https://claude.com/blog/token-saving-updates> (blog)
- S24: Effective harnesses for long-running agents — <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> (blog)
- S25: Effective context engineering for AI agents — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> (blog)
- S26: Using Claude Code: session management and 1M context — <https://claude.com/blog/using-claude-code-session-management-and-1m-context> (blog)
- S27: Managing context on Claude Developer Platform — <https://claude.com/blog/context-management> (blog)
- S28: Context editing documentation — <https://platform.claude.com/docs/en/build-with-claude/context-editing> (docs)
- S29: Compaction documentation — <https://platform.claude.com/docs/en/build-with-claude/compaction> (docs)
- S30: Best practices for Claude Code — <https://code.claude.com/docs/en/best-practices> (guide)
- S31: Prompting best practices (long context) — <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices> (docs)
- S32: Context windows documentation — <https://platform.claude.com/docs/en/build-with-claude/context-windows> (docs)
- S33: Large Codebases & Monorepo Configuration — <https://code.claude.com/docs/en/large-codebases> (docs)
- S34: Claude Code in Large Codebases Blog — <https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start> (blog)
- S35: Platform Docs — Task Budgets — <https://platform.claude.com/docs/en/build-with-claude/task-budgets> (docs)
