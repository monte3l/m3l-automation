# Skill naming conventions: fix two names, enforce the rule

**Status: shipped** — PR #1077 (renames) and PR #1078 (enforcement gate),
both merged 2026-09-07.

## Context

A review of five harness artifacts (`eslint-flat-config`, `tsconfig-strict-esm`,
`audit-fanout`, `harness-guide`, `vitest-coverage-types-mocks`) against
Anthropic's official Agent Skills spec
(platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices §
Naming conventions) found no hard-constraint failures but a real convention
problem: `tsconfig-strict-esm` and `vitest-coverage-types-mocks` matched
neither the spec's recommended gerund-phrase shape nor its noun-phrase
alternative — the latter was four bare topic tokens with no head noun at
all. `audit-fanout` was ruled out of scope (a Workflow script with a JS
`meta` export, not a Skill with YAML frontmatter — the spec doesn't govern
it). The cross-cutting finding was that this repo's 23 skills already split
19-vs-4 into two grammatical families (gerund for a procedure, `<topic>-
<head-noun>` for "how this repo's X is configured"), entirely by
imitation — nothing enforced it, which is exactly the condition that let
the two bad names ship unnoticed.

## Approach / Decisions

Two independently-landable PRs, per ADR-0072:

- **PR #1077** — renamed `tsconfig-strict-esm` → `typescript-configuration`
  and `vitest-coverage-types-mocks` → `vitest-testing`; updated every
  internal self-link, `evals.json`'s `skill_name` field, `skill-routing.md`'s
  dispatch table, `skills-catalog.md`'s usage rows, and appended a dated
  post-acceptance footnote to ADR-0093 (left its own body text untouched per
  the append-only convention for accepted decisions). `eslint-flat-config`
  and `harness-guide` were kept as deliberate, documented exceptions rather
  than renamed — both are defensible on their own terms (`-config` is
  accurate; `harness-guide` is a typed, `disable-model-invocation: true`
  command that never competes for a prose-triggered request).
- **PR #1078** — added `deriveNameIssues` to `bin/lib/skill-frontmatter.mjs`
  and wired it into `check:skill-frontmatter` as a new hard-fail check: a
  name must be a gerund phrase or a `<topic>-<head-noun>` phrase drawn from
  a small, deliberately narrow head-noun set. `GRANDFATHERED_NAMES` exempts
  the two kept names from the shape check only (both still clear the hard
  spec limits). A name containing the spec's reserved words
  ("anthropic"/"claude") warns rather than hard-fails, since
  `refreshing-anthropic-guidance` and `researching-anthropic-guidance` are
  real, working skills already in the live listing — hard-failing would
  break two working skills over a spec/implementation divergence this repo
  doesn't control. `docs/contributing/skills-catalog.md` gained a "Naming
  convention" section documenting the whole scheme.

Both PRs were verified end-to-end with `pnpm verify` before push and merged
via `gh pr merge --squash` after their required checks (`Dependency
Review`, `CodeQL`, `verify`, `review`) passed. PR #1078 needed a
`rebase --onto` + force-push after #1077 merged and GitHub auto-retargeted
its base to `main`, to drop the now-duplicate PR1 commit and trigger a
fresh CI run against the real base.

## Outcome

Both skills renamed and live on `main`; the naming-convention gate is now
enforced at `pre-push`/CI (`check:skill-frontmatter`) with 11 new tests (36
total). Full narrative, including the mid-task GPG signing-key mismatch
found and fixed, and background-task-monitoring lessons:
[`docs/logs/2026-09-07-skill-naming-conventions.md`](../../logs/2026-09-07-skill-naming-conventions.md).
