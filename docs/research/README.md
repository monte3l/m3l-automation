# Research snapshots

Optional, durable records of official-Anthropic-sources research produced by
the [`researching-anthropic-guidance`](../../.claude/skills/researching-anthropic-guidance/SKILL.md)
skill. Most research feeds directly into the task that asked for it and stays
inline in the conversation — a file here is only written when the user
explicitly asks to persist the briefing (see the skill's Step 5).

## Provenance header convention

Every snapshot opens with a provenance blockquote, matching the pattern
already used by `.claude/skills/*/references/*.md` snapshots and the ADR
"Evidence gathered `<date>`" links convention (see e.g.
[ADR-0023](../adr/0023-reaffirm-code-index-mcp-deferral.md)):

```markdown
> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> <N> official Anthropic sources. Synthesized: <date>.
> Sources: [<title1>](url1), [<title2>](url2), ...
```

followed by the same `Consensus / best practices`, `Contradictions / drift`,
`Coverage gaps`, and `Sources` sections as the skill's inline briefing.

## Refresh

The dated snapshots below are point-in-time, not living trackers — Anthropic's
guidance changes, so treat a snapshot's age as a signal to re-run
`researching-anthropic-guidance` on the same topic rather than as a standing
source of truth. There is no automated staleness check for an individual
topic snapshot.

A second living tracker sits alongside it:
[`retrospective.md`](retrospective.md) is the per-log ledger of
`/promoting-work-log-lessons` sweeps (ADR-0084), carrying its own
machine-readable `last-swept` / `logs-considered` header that the
`check:retrospective` `pre-push` gate reads. Same in-place convention as
`harness-refresh.md` below, different question: that one asks whether the
harness still matches Anthropic's guidance, this one asks whether the
project's own logged experience has reached its durable rules.

The **whole-harness** question — is the harness itself (agents, skills,
hooks, rules, workflows, `CLAUDE.md`) still current with Anthropic's
guidance — is different: it's answered by
[`harness-refresh.md`](harness-refresh.md), a **living tracker** updated in
place by the
[`refreshing-anthropic-guidance`](../../.claude/skills/refreshing-anthropic-guidance/SKILL.md)
skill rather than a new dated file per run. Unlike the topic snapshots below,
it carries a machine-readable `last-verified` header the `check:harness-freshness`
`pre-push` gate (ADR-0082) reads to warn once the harness hasn't been swept
in over 90 days — see that skill and its tracker for the current cadence
mechanism.

## Index

| Date       | Topic                                                                  | Snapshot                                                             |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-07-13 | Claude PR Review Action tuning for this repo's PR-size profile         | [pr-review-action-tuning.md](pr-review-action-tuning.md)             |
| 2026-07-16 | Writing custom tools and MCP servers (TypeScript)                      | [writing-custom-tools-and-mcp.md](writing-custom-tools-and-mcp.md)   |
| 2026-07-19 | Preventing and recovering from subagent stalls and mid-turn truncation | [subagent-stall-recovery.md](subagent-stall-recovery.md)             |
| 2026-08-20 | AI agents operating a CLI application (tooling, MCP, safety, Bedrock)  | [agent-cli-integration.md](agent-cli-integration.md)                 |
| 2026-08-27 | Context window management, compaction, and token efficiency            | [context-window-and-compaction.md](context-window-and-compaction.md) |
| 2026-09-02 | Claude Code session naming and identity                                | [session-naming.md](session-naming.md)                               |
