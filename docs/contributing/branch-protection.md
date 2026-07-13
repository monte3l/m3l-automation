# Branch Protection

The automated gates in this repo (CI checks, the Claude PR review verdict) only
become _blocking_ once `main` is protected to require them. Workflow files
cannot configure branch protection themselves — it is a repository setting. This
page records the configuration. **The rule described below has been applied** via
`gh api` as part of ADR-0011.

## Required configuration for `main`

In **Settings → Branches → Branch protection rules**, add a rule for `main`:

- **Require a pull request before merging.** Direct pushes to `main` are
  disallowed; everything lands through a PR. This is what makes "the agent that
  writes code is never the one that reviews it" structural (rules 01/04).
  Exception: changes to the review gate itself (`claude-pr-review.yml`) may
  be landed directly by the maintainer, since routing a gate change through the
  gate it modifies creates a circular dependency.
- **Require status checks to pass before merging**, and mark these as required:
  - `verify` — the job in `.github/workflows/ci.yml` (lint, typecheck, public
    API snapshot, coverage-gated tests, build, `check:exports`, `knip`).
  - `review` — the job in `.github/workflows/claude-pr-review.yml`. It fails
    unless the reviewer writes `PASS` to `.claude-review-verdict`, so a failing
    review blocks the merge (fail-closed if the review never runs). The reviewer
    runs **read-only** (`--allowedTools Bash,Read`), posts a **single sticky
    comment** per PR (updated on each push rather than re-posted), is capped at
    `--max-turns 100`, and **does not run on draft PRs** — it fires on
    `ready_for_review` and on every subsequent push to a ready PR. The workflow
    pre-computes the PR diff (`.claude-pr-diff.patch`) and hands it to the
    reviewer, so it reviews the supplied patch instead of spending turns fetching
    it — a typical review uses only a few of those turns. As an
    optimization, a push is **skipped** (the prior PASS is carried forward so
    the check stays green) when the latest verdict was PASS and only
    `paths-ignore` files (docs/config) changed since the reviewed commit,
    tracked via a `claude-review-sha` marker in the sticky comment; any
    reviewable change re-triggers a full review. This does not weaken the
    fail-closed gate. The verdict-file mechanism and fail-closed behavior are
    unchanged. A separate, non-blocking step logs run metrics (turns used
    against the cap, wall/API duration, cost, prompt-cache read/write tokens,
    and diff size) to the run's step summary and annotations — purely for
    tuning the turn cap over time, with no effect on the verdict.
  - **CodeQL code scanning** — added as required checks under ADR-0015 so a
    high-severity SAST finding blocks the merge. CodeQL runs via GitHub **default
    setup**, whose check runs surface as `Analyze (javascript-typescript)` and
    `Analyze (actions)` (both on PRs and on `main` pushes) — both are marked
    required. Confirm the exact check-run names on a live PR before wiring the
    rule, in case default-setup naming changes:
    `gh api repos/monte3l/m3l-automation/commits/<pr-head-sha>/check-runs --jq '.check_runs[].name'`.
  - **Dependency Review** — the job in `.github/workflows/dependency-review.yml`
    (`fail-on-severity: high`). Required under ADR-0015; it runs on PRs only.
  - **Dependabot PRs skip `review`, intentionally.** `claude-pr-review.yml`
    excludes `actor == dependabot[bot]` from the `review` job because GitHub
    does not pass repository secrets (including `CLAUDE_CODE_OAUTH_TOKEN`) to
    workflow runs triggered by a Dependabot pull request — the same platform
    restriction applied to fork PRs. With the whole job skipped rather than
    merely a step, the `review` check reports conclusion `skipped` for these
    PRs; GitHub treats a `skipped` required check as passing, so this does not
    block merge. Dependabot PRs still have to clear `verify`, `dependency-review`,
    and CodeQL like any other PR — they just don't get the Claude review pass.
    The `reviewing-dependabot-prs` skill (`.claude/skills/reviewing-dependabot-prs/`)
    is what actually reviews and acts on them instead, run manually rather than
    as a required workflow gate (for the same secrets-access reason).
- **Require branches to be up to date before merging.**
- **Require signed commits.** This is the _authoritative_ layer of the
  signed-commit policy (ADR-0016): unlike the in-repo `guard-git-push-signed`
  PreToolUse hook and the `verify-signed-range` lefthook `pre-push` backstop —
  both bypassable / agent- or local-only — GitHub rejects any unsigned or
  invalid-signature commit here, on every path (web UI, `--no-verify`, any
  client). Apply via `gh api`
  (`PUT /repos/:owner/:repo/branches/main/protection` with
  `required_signatures`), alongside the checks above. See ADR-0016 for the full
  rationale.
- **Do not allow bypassing the above** (including for administrators) so the
  gate cannot be skipped.

Optionally, to add a human approval on top of the automated review:

- **Require approvals** (at least 1) and **Require review from Code Owners**.
  This needs a `.github/CODEOWNERS` file pointing at a real team/user, e.g.:

  ```text
  # .github/CODEOWNERS — replace the handle with your actual reviewer team.
  *                       @m3l-automation/maintainers
  packages/m3l-common/    @m3l-automation/maintainers
  ```

  CODEOWNERS is intentionally not committed yet because it requires a real
  GitHub team/user handle; add it once the reviewing team exists.

## Why the verdict file, not just a comment

The original `claude-pr-review` workflow only posted a comment — it never set a
failing check, so the review was advisory. The workflow now writes a verdict
(`PASS`/`FAIL`) and a follow-up step fails the job on anything other than
`PASS`. Marking `review` as a required check turns that into a true merge gate.
