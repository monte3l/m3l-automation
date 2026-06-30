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
    `--max-turns 25`, and **does not run on draft PRs** — it fires on
    `ready_for_review` and on every subsequent push to a ready PR. The
    verdict-file mechanism and fail-closed behavior are unchanged.
- **Require branches to be up to date before merging.**
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
