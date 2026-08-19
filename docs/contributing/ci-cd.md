# CI/CD workflows

The single authoritative inventory of every GitHub Actions workflow in
`.github/workflows/`. `CLAUDE.md`'s "CI/CD" note is deliberately a one-line
pointer to this file, so the full table lives in one place instead of
drifting across sections. `pnpm check:workflows-doc` verifies this file
documents exactly the workflow files present — count plus one row each —
in both directions.

## CI/CD

Seven GitHub Actions workflows in `.github/workflows/` (plus Dependabot via the
GitHub-native `.github/dependabot.yml`, which is config, not a workflow):

| Workflow                | Trigger                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | push / PR → main                    | Full quality-gate pipeline: an eighth job (`changes`, `bin/ci-changed-paths.mjs`) classifies the diff and path-scopes the other seven parallel lanes (`secrets` always runs; `deps`/`lint`/`build`/`test` gate at the job level; `format`/`gates` stay unconditional with individual steps gated) — a docs-only or `.claude`-only change skips the lanes it can't affect. `verify` aggregates the results and is the required status check; a `changes` job failure fails `verify` directly rather than letting downstream lanes read as a false "skipped" pass. |
| `claude-pr-review.yml`  | PR opened / sync / reopened / ready | **Mandatory blocking gate** — produces PASS/FAIL verdict; merge requires PASS; skips re-review when a prior PASS still applies (no reviewable files changed)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `claude-assistant.yml`  | @claude in issues / PRs             | On-demand Claude Code assistant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dependency-review.yml` | PR → main                           | Blocks HIGH/CRITICAL vulnerability advisories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scorecard.yml`         | push → main / weekly cron           | OpenSSF Scorecard supply-chain posture scoring (ADR-0015); uploads SARIF to the Security tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `security-audit.yml`    | weekly cron / manual dispatch       | Scheduled `pnpm audit --audit-level=high` + `pnpm check:licenses` — catches an advisory or license change published against an unchanged lockfile between pushes (ci.yml runs the same two checks on every push/PR)                                                                                                                                                                                                                                                                                                                                              |
| `pages.yml`             | push → main / manual dispatch       | Builds and deploys the GitHub Pages site — visibility-hub dashboard at `/` (ADR-0032) plus shields.io commit-stats endpoint-badge JSON at `/commit-stats/` (ADR-0032 addendum); supersedes `pages-commit-stats.yml`                                                                                                                                                                                                                                                                                                                                              |

**Required status checks** (branch protection on `main`): `verify` (ci.yml),
`review` (claude-pr-review.yml), `Dependency Review` (dependency-review.yml),
and **`CodeQL`** — GitHub default setup, not a file in `.github/workflows/`, so
it has no row in the table above; it still runs on every push/PR and blocks
merge like the other three.

## Local reproduction

`pnpm verify` reproduces every lane's project-check steps locally in one
command (fail-fast by default); `pnpm check:verify-parity` keeps its step list
(`bin/lib/verify-steps.mjs`) from drifting out of sync with `ci.yml`'s lane
jobs. `ci.yml`'s own `verify` job is the required-status-check aggregator
(`needs:` on all seven lanes) — it carries no project checks itself.
