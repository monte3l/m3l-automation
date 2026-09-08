# Research snapshots and trackers

This directory holds two kinds of file — dated, point-in-time **snapshots**
of a single research pass, and living **trackers** updated in place — across
**two research programs**, each answering "is what we already built/assumed
still what the upstream owner recommends" for a different upstream:

## The two research programs

| Program                         | On-demand skill                                                                                    | Periodic sweep skill                                                                             | Living tracker                                   | Snapshots                            | Freshness gate                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------- |
| Anthropic / Claude Code harness | [`researching-anthropic-guidance`](../../.claude/skills/researching-anthropic-guidance/SKILL.md)   | [`refreshing-anthropic-guidance`](../../.claude/skills/refreshing-anthropic-guidance/SKILL.md)   | [`harness-refresh.md`](harness-refresh.md)       | `docs/research/<slug>.md`            | `check:harness-freshness` (90-day threshold, ADR-0082)         |
| TypeScript language & toolchain | [`researching-typescript-guidance`](../../.claude/skills/researching-typescript-guidance/SKILL.md) | [`refreshing-typescript-guidance`](../../.claude/skills/refreshing-typescript-guidance/SKILL.md) | [`typescript/refresh.md`](typescript/refresh.md) | `docs/research/typescript/<slug>.md` | `check:typescript-freshness` (120-day threshold, same pattern) |

**Namespacing rule:** a program with its own tracker gets its own
subdirectory (`typescript/`). The Anthropic program's snapshots sit at the
top level for historical reasons — they predate the second program — and are
not being moved; moving them would break every existing cross-reference for
no gain. A third research program, if one is ever added, follows the
TypeScript program's shape (`docs/research/<program>/`), not the Anthropic
program's flat layout.

Most research feeds directly into the task that asked for it and stays
inline in the conversation — a snapshot file is only written when the user
explicitly asks to persist the briefing (each program's "researching-\*"
skill's own Step 5).

## Provenance header convention

Every snapshot opens with a provenance blockquote, matching the pattern
already used by `.claude/skills/*/references/*.md` snapshots and the ADR
"Evidence gathered `<date>`" links convention (see e.g.
[ADR-0023](../adr/0023-reaffirm-code-index-mcp-deferral.md)). The exact
wording is per-program:

```markdown
> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> <N> official Anthropic sources. Synthesized: <date>.
> Sources: [<title1>](url1), [<title2>](url2), ...
```

```markdown
> **Provenance** — Synthesized via `/researching-typescript-guidance` from
> <N> upstream TypeScript sources (T1/T2 per
> `.claude/skills/researching-typescript-guidance/references/typescript-sources.md`).
> Synthesized: <date>.
> Sources: [<title1>](url1), [<title2>](url2), ...
```

followed by the same `Consensus / best practices`, `Contradictions / drift`,
`Coverage gaps`, and `Sources` sections as each skill's inline briefing.

## Refresh

The dated snapshots below are point-in-time, not living trackers — upstream
guidance changes, so treat a snapshot's age as a signal to re-run the
program's `researching-*` skill on the same topic rather than as a standing
source of truth. There is no automated staleness check for an individual
topic snapshot.

A third living tracker sits alongside the two named in the table above:
[`retrospective.md`](retrospective.md) is the per-log ledger of
`/promoting-work-log-lessons` sweeps (ADR-0084), carrying its own
machine-readable `last-swept` / `logs-considered` header that the
`check:retrospective` `pre-push` gate reads. Same in-place convention as
`harness-refresh.md` and `typescript/refresh.md`, a third question: those
two ask whether this repo still matches an upstream owner's current
guidance, this one asks whether the project's own logged experience has
reached its durable rules.

The **whole-harness** question — is the harness itself (agents, skills,
hooks, rules, workflows, `CLAUDE.md`) still current with Anthropic's
guidance — and the **whole-TypeScript-toolchain** question — is
`tsconfig.base.json`, `eslint.config.js`'s typed-lint preset, and this
repo's packaging/declaration-emit assumptions still current with upstream
TypeScript — are each answered by their own living tracker (see the table
above), updated in place by their own `refreshing-*` skill rather than a new
dated file per run. Unlike the topic snapshots, each tracker carries a
machine-readable `last-verified` header its own `pre-push` gate reads to
warn once the sweep interval has passed — see each skill and its tracker for
the current cadence mechanism, and
[`docs/decision-notes/0006-typescript-source-tiering.md`](../decision-notes/0006-typescript-source-tiering.md)
for why the TypeScript program's threshold (120 days) differs from the
Anthropic program's (90 days).

## Index

### Anthropic / Claude Code harness

| Date       | Topic                                                                  | Snapshot                                                             |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-07-13 | Claude PR Review Action tuning for this repo's PR-size profile         | [pr-review-action-tuning.md](pr-review-action-tuning.md)             |
| 2026-07-16 | Writing custom tools and MCP servers (TypeScript)                      | [writing-custom-tools-and-mcp.md](writing-custom-tools-and-mcp.md)   |
| 2026-07-19 | Preventing and recovering from subagent stalls and mid-turn truncation | [subagent-stall-recovery.md](subagent-stall-recovery.md)             |
| 2026-08-20 | AI agents operating a CLI application (tooling, MCP, safety, Bedrock)  | [agent-cli-integration.md](agent-cli-integration.md)                 |
| 2026-08-27 | Context window management, compaction, and token efficiency            | [context-window-and-compaction.md](context-window-and-compaction.md) |
| 2026-09-02 | Claude Code session naming and identity                                | [session-naming.md](session-naming.md)                               |
| 2026-09-05 | Subagent MCP tool grants: least privilege vs. hub-only                 | [subagent-mcp-tool-grants.md](subagent-mcp-tool-grants.md)           |

### TypeScript language & toolchain

No dated topic snapshots yet — `typescript/refresh.md` (the living tracker,
seeded 2026-09-08) is the only file in `typescript/` so far. A row lands here
the first time `researching-typescript-guidance`'s Step 5 is confirmed for a
persisted snapshot.

| Date | Topic | Snapshot |
| ---- | ----- | -------- |
