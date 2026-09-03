# Expand the branch prefixes `pnpm worktree:new` can mint

**Status: shipped** — two sequenced PRs: #932 and this PR
(`feat/worktree-kind-flag`), closing out an `/auditing`-triggered plan.
ADR-0014 and ADR-0087 record the widened `BRANCH_KINDS`/`SESSION_KINDS`
vocabulary; a follow-up work log
(`docs/logs/2026-09-03-worktree-new-lib-extract.md`) records PR1's own
process lessons.

## Context

`bin/worktree-new.mjs` could mint exactly two branch prefixes, `feat` and
`fix`, via a hardcoded ternary. An `/auditing` pass census of all 1209
commits found that pair covered well under half the work — `docs` (299,
#1 all-time) and `chore` (229) each outrank `feat` (287) in parts of the
window, with `refactor` (31) and `ci` (25) also unmintable — and two live
branches (`docs/console-container-stance`,
`refactor/console-loopback-predicates`) already existed, created by hand
with raw `git worktree add` because `worktree:new` couldn't mint them.

The audit's Verify phase failed wholesale (all 10 `audit-refuter` dispatches
hit an Anthropic session-capacity limit), so the hub personally re-verified
every load-bearing claim before drafting the plan — the key finding survived
that check: `BRANCH_KINDS` must stay a subset of `SESSION_KINDS`
(ADR-0087), because `worktree-new.mjs` advertises `pnpm session:launch` on
the branch it just creates, and `buildSessionName()` throws for any kind
outside `SESSION_KINDS`.

## Approach / Decisions

Sequenced as a `refactor:` PR followed by a `feat:` PR, per
`.claude/rules/refactoring.md`'s separation of behavior-preserving change
from behavior change:

- **PR1 (#932) — extraction.** `bin/worktree-new.mjs` had zero exported
  functions and no test coverage anywhere in its call chain. Extracted
  argument parsing into `bin/lib/worktree-new.mjs`
  (`parseWorktreeNewArgs`/`worktreeDirName`, pattern-parallel with
  `bin/lib/worktree-prune.mjs`), added `bin/tests/worktree-new.test.ts` (12
  tests), byte-identical behavior otherwise (`feat`/`fix` only, unknown
  flags still silently ignored). A separate follow-up docs-only PR (#935)
  added the process work log and promoted one lesson into
  `.claude/skills/creating-prs/SKILL.md` (a linked worktree's local `main`
  ref can go stale relative to `origin/main` mid-session).
- **PR2 (this PR) — widening.** `BRANCH_KINDS` grew to `feat`, `fix`,
  `docs`, `chore`, `refactor`, `ci` — the intersection of the Conventional
  Commit type-enum this repo enforces (`commitlint.config.js`) with a set
  `SESSION_KINDS` can carry; `SESSION_KINDS` gained `chore`/`refactor` in
  the same change. `--kind <kind>` replaces the `--fix` boolean as the
  primary CLI surface, with `--fix` kept as a documented alias (non-breaking
  for the MCP `worktree` tool's existing boolean param) and unrecognized
  flags now rejected rather than silently ignored. Four parallel
  `test-author` dispatches updated/extended six `bin/tests/**` files; one
  caught a real regression the widening introduced — an existing test
  asserted `buildSessionName("chore", ...)` threw, which silently stopped
  being true once `"chore"` became a valid `SESSION_KINDS` member. A
  `code-reviewer` pass found no Must-fix findings; one Should-fix (the CLI
  and the MCP tool validate `kind`/`fix`/`from` conflicts in a different
  order, so a simultaneously-invalid input reports different first-error
  text on each entry point — both correctly reject it either way) was left
  as a named follow-up rather than blocking.
- CLAUDE.md was **not** amended — its always-loaded token budget
  (`check:context-budget`, ~3000 tokens) had no headroom for the addition;
  the detail is documented in ADR-0014, ADR-0087, and
  `docs/contributing/contributing.md`, which CLAUDE.md already points to.

## Outcome

`pnpm worktree:new <slug> --kind docs` (etc.) now mints and provisions a
worktree on a branch `session:launch` can also name automatically. Full
process narrative and lessons (the audit-refuter outage, an
`AskUserQuestion` batching mistake repeated across the session, a
`ScheduleWakeup` misapplication, and writing PR1's own docs to the shared
checkout instead of a worktree) are in
[`docs/logs/2026-09-03-worktree-new-lib-extract.md`](../../logs/2026-09-03-worktree-new-lib-extract.md).
