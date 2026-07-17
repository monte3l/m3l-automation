# Automate Dependabot PR review with merge/hold/reject

**Status: shipped** (commit 3abbbf6)

## Context

Dependabot was already configured (weekly grouped npm + github-actions PRs,
per ADR-0007), but that ADR deliberately stopped at "Dependabot handles
scheduled PRs" and never decided what happens to them afterward — they just
accumulated until a human manually reviewed and merged each one. An audit
surfaced why this was a real gap: `claude-pr-review.yml` already excludes
Dependabot PRs from the mandatory Claude review gate (line 24,
`if: github.actor != 'dependabot[bot]'`), most likely because GitHub does
not pass repository secrets to workflow runs triggered by a Dependabot PR
event — a platform restriction, but an undocumented one. That left
Dependabot PRs clearing only CI, dependency-review, and CodeQL, with no
merge/hold/reject logic or auto-merge configuration anywhere in the repo.

## Approach / Decisions

- Built as a manually-invoked Claude Code skill
  (`.claude/skills/reviewing-dependabot-prs`), not a GitHub Actions workflow —
  sidesteps the secrets restriction entirely, since a skill run through
  Claude Code already has `gh` auth with no separate CI secret needed.
- **Tiered review depth:** a cheap metadata/CI-status fast path for
  patch/minor bumps with all-green required checks (proposed action `MERGE`
  with no changelog read); escalation to a Claude-based changelog/release-
  notes read, judged against this repo's constraints (strict TS, ESM-only,
  Node 24+, zero runtime deps), only for major bumps or red checks
  (`MERGE`/`HOLD`/`REJECT`).
- **Merge** via GitHub-native auto-merge (`gh pr merge --auto --squash`) —
  never bypasses required checks, just tells GitHub to merge once they're
  green; documented prerequisite that the repo's "Allow auto-merge" setting
  must be enabled (a one-time manual repo-settings change, not scripted).
- **Hold** leaves the PR open with one explanatory sticky comment (tagged
  with a `<!-- dependabot-review-verdict -->` marker so re-runs update
  rather than duplicate, mirroring `claude-pr-review.yml`'s own sticky-
  comment idiom); **reject** closes with an explanatory comment.
  `@dependabot ignore` stays out of scope permanently — a deliberate,
  separate human action, never auto-invoked.
- **Batch confirmation:** the skill proposes actions for every open
  Dependabot PR in one summary table and asks for a single user
  confirmation before executing any merge/comment/close — consistent with
  the environment's rule that side-effecting GitHub actions need explicit
  per-use permission, without forcing a confirmation per PR.
- Also closed a related documentation gap: added a paragraph to
  `docs/contributing/branch-protection.md` explaining the Dependabot
  review-gate skip is intentional (a platform secrets restriction, not a
  bug) and cross-referencing this new skill as the mechanism that now
  covers Dependabot PR review instead.

## Outcome

Landed at commit `3abbbf6` on 2026-07-13: the new
`.claude/skills/reviewing-dependabot-prs/SKILL.md`, plus the
branch-protection documentation fix. No `packages/*/src`, `scripts/*/src`,
or `**/tests/**` changes were involved — a docs+skill-only change, still
landed via a normal branch and PR per repo convention.
