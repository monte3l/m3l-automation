# Dependabot PR sweep — CodeQL required-check fix

**Status: docs shipped, settings change handed back.** Commit `98f63d0` on
`fix/dependabot-codeql-required-check`. The actual branch-protection/ruleset
API mutation was blocked by the Claude Code auto-mode classifier
(repository-admin action outside what a general "proceed" authorizes) and is
left for the maintainer to run directly.

## Context

A routine `/reviewing-dependabot-prs` sweep found seven open Dependabot PRs
(#290–#296). Classifying them surfaced a second, larger problem: **no**
Dependabot PR in this repo could merge, regardless of verdict.
`mergeStateStatus` was `BLOCKED` on all seven despite `mergeable: MERGEABLE`.

Root cause: branch protection and the `main-dual-layer-protection` ruleset
both required the per-language CodeQL default-setup contexts
`Analyze (javascript-typescript)` and `Analyze (actions)`. Since ~2026-08-03,
GitHub's CodeQL default setup began posting a single consolidated `CodeQL`
check (conclusion `neutral` when clean) on Dependabot-actor PRs instead — the
two required contexts never appeared there, so they sat "expected" forever.
Confirmed as Dependabot-specific, not a repo-wide rename: human PR #289
(2026-08-01) and direct `main` pushes (2026-08-04) still received both
`Analyze (…)` runs. `enforce_admins: true` and `bypass_actors: []` on both
layers meant there was no override short of changing the required-context
list itself.

## Approach / Decisions

1. **PR verdicts, executed.** #296 closed (duplicate of #292; bumped
   `undici` in `packages/m3l-common/package.json` without regenerating
   `pnpm-lock.yaml`, hard `ERR_PNPM_OUTDATED_LOCKFILE` failure). #290 closed
   (toolchain group bundled `typescript` 6.0.3→7.0.2; `typescript-eslint`
   8.65.0 refuses TS 7.0 outright, and the repo is pinned to TS 6.x).
   #291–#295 armed with `gh pr merge --auto --squash` — they queue and fire
   serially once the required-check fix lands, since branch protection
   requires branches to be up to date and four of the five touch
   `pnpm-lock.yaml`.
2. **Required-check fix, proposed then confirmed.** Drop the two
   `Analyze (…)` contexts from both enforcement layers, add the single
   `CodeQL` context in their place — observed reporting reliably on both PR
   classes. Accepted tradeoff, recorded in the ADR-0015 update block: `CodeQL`
   can report `neutral` on Dependabot PRs without a scan actually running (a
   manifest/lockfile-only diff gives it nothing to analyze); `Dependency
Review` (`fail-on-severity: high`) and `pnpm audit` in `verify` remain the
   substantive gate for that PR class. Human PRs are unaffected.
3. **Settings mutation blocked, docs proceeded independently.** The
   `gh api PUT` call against `branches/main/protection` was denied by the
   auto-mode classifier as a high-risk administrative action. Rather than
   attempt a workaround, the doc/ADR updates describing the _intended_ state
   were still written and committed, and the exact `gh api` payloads (built
   from the live current state so nothing else drifts) were handed to the
   user to run themselves — via `!`-prefixed direct execution or by
   re-confirming the specific action.
4. **Out of scope, flagged not actioned:** #290 will regenerate every Monday
   and fail identically until `.github/dependabot.yml` constrains
   `typescript` to 6.x or splits it out of the `toolchain` group — a
   deliberate config choice left to the maintainer. Per the
   `reviewing-dependabot-prs` skill's boundary rules, no `@dependabot ignore`
   was posted (not a permanent suppression). Three open Dependabot security
   advisories (`fast-uri`, `ip-address`, transitive `undici` 7.x) have no
   corresponding PR and need a resolution/override rather than a bump.

## Outcome

- `docs/contributing/branch-protection.md` and
  `docs/adr/0015-code-scanning-tooling-evaluation.md` updated to describe the
  `CodeQL`-consolidated required-context state, committed as `docs:` on
  `fix/dependabot-codeql-required-check`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` (6104 tests, 97.94%
  statement coverage), `pnpm build`, and `pnpm sync:docs` all pass on the
  branch.
- **Still pending (maintainer action):** apply the two `gh api PUT` calls
  (classic branch protection + ruleset `19550369`) that actually repoint the
  required-status-check list. Until that lands, PRs #291–#295 stay armed but
  `BLOCKED`.
