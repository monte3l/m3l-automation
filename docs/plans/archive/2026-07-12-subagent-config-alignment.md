# Align subagent config with Anthropic's official best practices

**Status: shipped** (PR #114, commit `be505ca`)

## Context

The repo's subagent setup — `.claude/agents/*`, `bin/check-agents.mjs`,
`bin/lib/claude-models.mjs`, and `docs/contributing/model-selection.md` —
was audited against Anthropic's official sub-agents documentation and
engineering blog post, prioritizing the newly established `Explore`
subagent. The setup was already strong and in places ahead of the docs:
every agent carried an explicit `tools` allowlist (none inherited `*`), the
flat depth-1 hub-and-spoke rule was machine-enforced, the MODEL-MATRIX was
two-way synced, and `Explore` was correctly pinned to `model: haiku`. The
gaps that remained: read-only agents (`Explore` plus six reviewers) held
`Bash`, an unconstrained write-capable tool, contradicting Anthropic's
read-only pattern; `Explore`'s description discouraged full reads and
analysis, fighting how the `auditing` skill actually dispatches it;
governance checks didn't assert read-only posture or `description`
presence; and a few allowlist/doc details had drifted.

## Approach / Decisions

- Reworded `Explore.md`'s description and body to stop discouraging full
  reads/analysis, matching Anthropic's "searching and analyzing" framing and
  the `auditing` skill's per-invocation mandate, while keeping the
  genuinely useful guidance (report findings, not raw dumps; hand deep
  cross-file judgment to a specialized reviewer). Added the CLAUDE.md-skip
  caveat (Explore/Plan don't see `CLAUDE.md` or parent git status, so
  dispatching briefs must be self-contained) and a `color:` field for
  frontmatter consistency.
- Extended `bin/check-agents.mjs` with fleet-wide least-privilege checks: a
  read-only posture check (error if any non-writer agent's `tools` grant
  includes `Write`/`Edit`), a description-presence check, and a
  `disallowedTools: Agent` consistency check across all spokes.
- Added a new PreToolUse hook, `.claude/hooks/guard-readonly-bash.mjs`,
  restricting read-only agents to read-only shell verbs (`git diff|log|
status|show`, `grep`, `ls`, `cat`, dry-run/coverage reads) and blocking
  mutating ones — the structural fix for the `Bash` least-privilege gap,
  rather than removing the tool grant outright. Wired into
  `.claude/settings.json` and validated by `bin/check-hooks.mjs`.
- Reconciled doc/allowlist drift: documented the `max` effort level
  (already valid in `EFFORT_LEVELS` but missing from
  `model-selection.md`), clarified `inherit` as a resolution directive (not
  a model family), and softened the "four families cover the entire
  catalog" claim to "generally-available families."
- Deliberately did not add "use proactively" auto-delegation language to
  descriptions — the hub-and-spoke model dispatches explicitly by design.

## Outcome

`Explore.md` and the six reviewer/writer agent files carry the reworded
description and hardening; `bin/check-agents.mjs` gained the read-only/
description/`disallowedTools` governance checks; the new
`guard-readonly-bash.mjs` hook is wired and validated; and
[`docs/contributing/model-selection.md`](../../contributing/model-selection.md)
now documents the `max` effort level and the `inherit`/catalog wording
fixes.

## Verification

`pnpm check:agents` passes with the new checks (confirmed to fail when a
reviewer agent is given `Write`, then reverted); `pnpm check:hooks` passes
with the new hook wired; `pnpm lint:md`, `pnpm typecheck`, and `pnpm lint`
all green.
