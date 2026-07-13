# 0007. Automated dependency monitoring and security gating

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

The CI pipeline (secret-scan → lint → typecheck → test → build → export-check → knip)
had no mechanism to detect vulnerable or severely outdated dependencies. A transitive
HIGH/CRITICAL advisory could reach `main` and be published to npm undetected.
This repo's security posture mandates that security gates block promotion on
critical findings; that expectation was not yet enforced for the dependency surface.

`m3l-common` carries zero runtime production dependencies, so the entire exposure is the
devDependencies tree at the workspace root — a single lockfile, one audit target.

## Decision drivers

- Security gate must block HIGH/CRITICAL advisories before merge, not just report them.
- Automated PRs are preferred over manual `pnpm upgrade` runs to keep deps from drifting.
- No new runtime dependencies; tooling must be pnpm-native or GitHub-native.
- Weekly batched updates to avoid PR noise; security fixes remain individual and urgent.

## Considered options

1. **Renovate Bot** — highly configurable, better pnpm workspace support, automerge on
   green CI. Rejected because it requires installing a third-party GitHub App or
   self-hosting; adds operational overhead beyond what is needed for a single-lockfile repo.

2. **Dependabot + `pnpm audit` in CI + `dependency-review-action`** — zero-friction
   GitHub-native stack; no GitHub App required. Dependabot handles scheduled PRs;
   `pnpm audit` gates every push/PR; `dependency-review-action` surfaces lockfile diffs
   inline on PRs. All three layers compose without external services.

3. **Scheduled CI job with `pnpm outdated` reporting only** — surfaces drift but does not
   block merges or automate PRs; does not satisfy the "block on critical findings" driver.

## Decision

We chose **option 2** — Dependabot for automated update PRs, `pnpm audit --audit-level=high`
as a CI gate step, and `dependency-review-action` for PR-level lockfile diff visibility.

Three new files:

- `.github/dependabot.yml` — weekly grouped version-update PRs (`toolchain` +
  `release-tooling` groups); advisory-triggered security PRs run independently.
- `.github/workflows/ci.yml` — `pnpm audit --audit-level=high` step inserted after
  `pnpm install` so a vulnerable dep fails the job before lint/test/build run.
- `.github/workflows/dependency-review.yml` — GitHub's `dependency-review-action@v4`
  on every PR targeting `main`; fails on HIGH severity or above.

## Consequences

- **Positive:** HIGH/CRITICAL advisories now block merges to `main`; weekly Dependabot
  PRs keep the lockfile from drifting silently; PR reviewers see an inline diff of
  dependency changes alongside the code diff.
- **Negative / trade-offs:** Dependabot may open up to 5 PRs per week (mitigated by
  grouping). `dependency-review-action` requires the GitHub dependency graph feature to be
  enabled (default-on for public repos; one toggle for private repos under
  Settings → Security → Dependency graph).
- **Semver impact:** none — tooling only; no change to the public API or `exports` map.

## Links

- Related: ADR-0001 (toolchain choices), `.github/workflows/ci.yml`,
  `.github/workflows/dependency-review.yml`, `.github/dependabot.yml`.
