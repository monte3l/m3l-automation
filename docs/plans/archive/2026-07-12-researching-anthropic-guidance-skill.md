# Add the `researching-anthropic-guidance` skill

**Status: shipped** (commit `75070a3`)

## Context

The project needed a research skill that, scoped to whatever task invokes
it, thoroughly searches the internet and retrieves — from **official
Anthropic sources only** — best practices, whitepapers, recommendations,
engineering blog posts, guides, and documentation, without stopping at the
first matching source, and that synthesizes overlaps into consensus while
flagging contradictions. An audit found `auditing` was the closest existing
template (fan-out `Explore` subagents with a verbatim report format,
hub-side synthesis), and that `Explore` was the only spoke already granted
`WebSearch`/`WebFetch` — so the new skill could reuse it with no new agent
and no `check:agents`/MODEL-MATRIX governance surface to extend. The skill
was authored via `/skill-creator` per the user's explicit request.

## Approach / Decisions

- Reuse `Explore` for fan-out (no new agent); hub does the synthesis, since
  only the hub dispatches subagents.
- Each `Explore` agent's `WebSearch` is constrained to a strict allowlist
  (`anthropic.com`, `claude.com`, `platform.claude.com`, `code.claude.com`,
  `docs.claude.com`, `docs.anthropic.com`, plus `github.com`/
  `raw.githubusercontent.com` restricted in practice to `anthropics/*` URLs).
- Each agent writes its full sourced-findings to a per-run scratchpad file
  and returns only a compact digest (facet, source count, headline claims,
  conflict flags) plus the file path — the same bounded-digest pattern later
  generalized across the fleet by the truncation-hardening work — keeping
  the hub's context lean while leaving a durable trace for synthesis.
- The hub reads the scratchpad files in full, dedupes sources, merges
  overlapping claims into consensus, and explicitly flags contradictions
  with which source is newer/more authoritative.
- An optional dated snapshot under `docs/research/<topic-slug>.md` is
  offered but only written on explicit user confirmation; a
  `docs/research/README.md` was added as its home.
- Wired into the existing workflow rather than left standalone: added to
  `CLAUDE.md`'s Agent Operating Model and Task Workflow sections, and
  cross-linked from `auditing/SKILL.md` as the official-guidance complement
  to `auditing`'s repo-state reads.

## Outcome

The skill shipped at `.claude/skills/researching-anthropic-guidance/SKILL.md`
with a hand-authored `evals/evals.json`, plus the `docs/research/README.md`
home for optional snapshots. `pnpm check:agents` stayed green since the
skill's only `subagent_type` reference (`Explore`) already resolves.
