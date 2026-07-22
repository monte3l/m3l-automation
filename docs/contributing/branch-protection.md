# Branch Protection

The automated gates in this repo (CI checks, the Claude PR review verdict) only
become _blocking_ once `main` is protected to require them. Workflow files
cannot configure branch protection themselves — it is a repository setting. This
page records the configuration. **The rule described below is applied** via
`gh api`, restored and re-verified on 2026-07-22 after a Scorecard
`BranchProtectionID` alert found it had silently drifted to disabled (see the
2026-07-22 update in [ADR-0016](../adr/0016-signed-commits-and-decision-gate.md)).
A second, independent layer — a GitHub ruleset — now enforces the same rules
on top; see [Ruleset (defense-in-depth layer)](#ruleset-defense-in-depth-layer)
below.

## Required configuration for `main`

In **Settings → Branches → Branch protection rules**, add a rule for `main`:

- **Require a pull request before merging.** Direct pushes to `main` are
  disallowed; everything lands through a PR. This is what makes "the agent that
  writes code is never the one that reviews it" structural (rules 01/04). As
  of 2026-07-22, both protection layers have `bypass_actors: []` /
  `enforce_admins: true` — there is no direct-push exception for anyone,
  including the maintainer. A change to the review gate itself
  (`claude-pr-review.yml`) still lands through a normal PR: it isn't covered
  by the guard step's ignored-path set, so it naturally triggers a real
  review like any other code change — no bypass is used or needed.
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
    it — a typical review uses only a few of those turns. The job itself runs
    unconditionally on every non-draft PR (no trigger-level path filter) so the
    required `review` check always reports; a guard step decides whether an
    actual Claude review is needed. It's **skipped** (the verdict is written as
    `PASS` directly, or carried forward from a prior `PASS`) in two cases: the
    PR's entire diff is docs/config-only per the guard step's `is_ignored`
    predicate (no library code to review at all), or the latest verdict was
    `PASS` and only `is_ignored`-matching files changed since the reviewed
    commit, tracked via a `claude-review-sha` marker in the sticky comment; any
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
  `.github/CODEOWNERS` (`* @enri3l`) now exists with a real handle, so this is
  available whenever it's wanted — but as of 2026-07-22 it is deliberately
  **not** enabled as a merge gate on either protection layer (see the
  ruleset section below), to avoid making @giulmonte's review turnaround a
  hard bottleneck for the sole active maintainer. Revisit separately if that
  changes.

## Ruleset (defense-in-depth layer)

Alongside classic branch protection above, `main` is also covered by a GitHub
**repository ruleset** named `main-dual-layer-protection`
(`enforcement: active`, `bypass_actors: []`), created 2026-07-22 — see the
2026-07-22 update in
[ADR-0016](../adr/0016-signed-commits-and-decision-gate.md) for why. It
enforces, independently of the classic rule above:

- `deletion` — blocks deleting `main`.
- `non_fast_forward` — blocks force-pushes.
- `required_signatures` — mirrors the classic "Require signed commits" rule.
- `pull_request` — requires a PR (no approval count / CODEOWNERS gate, matching
  the scoping decision above).
- `required_status_checks` — the same five contexts as classic protection:
  `verify`, `review`, `Analyze (javascript-typescript)`, `Analyze (actions)`,
  `Dependency Review`.

**This is intentionally overlapping, not a replacement.** GitHub enforces
whichever of classic protection and an applicable ruleset is more restrictive
for a given ref; neither layer can loosen what the other enforces. The
ruleset exists because classic protection on `main` was found to have
silently drifted to fully disabled with no error or notification — a second,
independently configured layer means one mechanism being disabled or
misconfigured again doesn't leave `main` unprotected. Manage both when
changing policy: a rule added to only one layer is not authoritative on its
own.

## Why the verdict file, not just a comment

The original `claude-pr-review` workflow only posted a comment — it never set a
failing check, so the review was advisory. The workflow now writes a verdict
(`PASS`/`FAIL`) and a follow-up step fails the job on anything other than
`PASS`. Marking `review` as a required check turns that into a true merge gate.
