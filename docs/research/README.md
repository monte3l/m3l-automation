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

These are point-in-time snapshots, not living trackers — Anthropic's guidance
changes, so treat a snapshot's age as a signal to re-run the skill rather than
as a standing source of truth. There is no automated staleness check on this
directory (unlike the provenance-sidecar / doc-count machinery that covers
`docs/reference/`); re-run `researching-anthropic-guidance` on the same topic
when a snapshot looks out of date.

## Index

| Date       | Topic                                                          | Snapshot                                                           |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-07-13 | Claude PR Review Action tuning for this repo's PR-size profile | [pr-review-action-tuning.md](pr-review-action-tuning.md)           |
| 2026-07-16 | Writing custom tools and MCP servers (TypeScript)              | [writing-custom-tools-and-mcp.md](writing-custom-tools-and-mcp.md) |
