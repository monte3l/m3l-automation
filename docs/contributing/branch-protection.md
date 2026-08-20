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
  (`claude-pr-review.yml`) still lands through a normal PR, but cannot get a
  live Claude review: GitHub refuses to mint the OIDC token
  `claude-code-action` needs whenever the running workflow file differs from
  `main`'s copy, so the action always self-skips on such a PR. A dedicated
  guard-step fallback auto-passes this one case — only when the workflow file
  is the PR's sole non-ignored change and the action's own execution trace is
  empty (proving no review was ever attempted, not that one ran and silently
  dropped its verdict) — otherwise the check stays failing. Bundling other
  changes alongside a workflow-gate edit does not ride along on this
  fallback; it still requires a genuine review.
- **Require status checks to pass before merging**, and mark these as required:
  - `verify` — the aggregator job in `.github/workflows/ci.yml`. It carries no
    checks itself (`needs:` on all eight jobs — the `changes` path-classifier
    plus the seven parallel lanes: `secrets`, `deps`, `lint`, `format`,
    `build`, `test`, `gates` — plus `if: always()`); it passes when every
    lane succeeded or was skipped, and fails on any lane failure or
    cancellation, or if `changes` itself failed (checked explicitly, so a
    classifier crash can't read as "every lane skipped" and pass). The
    actual checks (lint, typecheck, public API snapshot, coverage-gated
    tests, build, `check:exports`, `knip`, …) run inside those lanes, most
    of them path-scoped on `changes`'s output.
  - `review` — the job in `.github/workflows/claude-pr-review.yml`. It fails
    unless the verdict is `PASS`, so a failing review blocks the merge
    (fail-closed if the review never runs). The reviewer runs in `--safe-mode`
    (CLAUDE.md/skills/plugins/hooks/MCP servers disabled) with a scoped
    `--allowedTools` allowlist, is capped at `--max-turns` (the `MAX_TURNS`
    job env), and **does not run on draft PRs** — it fires on
    `ready_for_review` and on every subsequent push to a ready PR. It posts
    its review as a PR comment. The job itself runs unconditionally on every
    non-draft PR (no trigger-level path filter) so the required `review` check
    always reports; a guard step decides whether an actual Claude review is
    needed.

    **What the reviewer is given.** The workflow pre-computes the PR diff into
    `.claude-pr-diff.patch` and hands it over, so the reviewer never spends
    turns fetching it. That patch is filtered to what this gate actually
    reviews: `*.md`, `docs/**`, `.github/dependabot.yml` and `pnpm-lock.yaml`
    keep their `diff --git` header but have their hunks replaced by a
    `(diff omitted — …)` marker, and `.claude-pr-changed-files.txt` is
    filtered the same way. The filter deliberately mirrors the guard step's
    `is_ignored` predicate — that one decides _whether_ to review, this one
    decides _what_ is handed over, and the two must keep meaning the same
    thing.

    **Size limit.** If the _reviewable_ patch exceeds `MAX_REVIEWABLE_BYTES`
    (300,000 chars), Claude never starts: the job posts a comment naming the
    size and the largest contributing files, writes `FAIL`, and fails the
    check. A diff that large cannot get a faithful single-pass review, and the
    previous behaviour was to spend a full turn budget and report nothing —
    PR #523 burned three runs and ~$8.15 that way. Split the PR and each
    slice reviews normally. The limit is ~2.1x the largest reviewable patch
    in the measured window and rejected none of the 14 PRs merged before it
    landed. **This is a rejection ceiling, not an authoring target** — see
    [ADR-0072](../adr/0072-reviewable-slice-discipline.md) for the 75,000-char
    soft target `pnpm check:review-size` checks locally before a PR is opened,
    and for the split axes to use when a PR runs over it.

    **Where the verdict comes from.** Primarily `.claude-review-verdict`, a
    file the reviewer writes as its final action. Because a `>` redirect
    target is checked separately from the command — a command-prefix rule
    like `Bash(echo:*)` authorizes `echo` but never the redirect target, and
    `Write(path)` rules are silently not consulted — every writable path needs
    its own `Edit(...)` grant, matched against the literal string in the
    command (the matcher does not expand shell variables). There are two:
    `Edit(./.claude-review-verdict)` and `Edit(./.claude-review-comment.md)`
    for the comment body, which the reviewer posts with
    `gh pr comment --body-file`. The Bash allowlist is scoped the same way:
    `gh pr comment` to post and `gh pr diff` for the one fallback path (used
    only if pre-computing the patch failed), with no other `gh` subcommand,
    no `curl`/`wget`, and nothing that can write in place such as `sed` or
    `tee`. If that file is missing, the gate falls back to
    reading the verdict out of the posted `claude[bot]` comment, but **only**
    when the comment's `claude-review-sha` marker matches the commit under
    test. The SHA pin is what keeps this fail-closed: a stale `PASS` from an
    earlier push can never satisfy the gate. The fallback exists because a
    review that converges and then exhausts its turn budget one call later
    used to be discarded entirely — on PR #523 the reviewer twice posted a
    complete, correct `FAIL` that the gate threw away in favour of reporting
    infrastructure failure.

    **When it's skipped** (the verdict is written as `PASS` directly, or
    carried forward from a prior `PASS`), in two cases: the PR's entire diff
    is docs/config-only per `is_ignored` (nothing to review at all), or the
    latest verdict was `PASS` and only `is_ignored`-matching files changed
    since the reviewed commit, tracked via the `claude-review-sha` marker. Any
    reviewable change re-triggers a full review. None of this weakens the
    fail-closed gate.

    A separate, non-blocking step logs run metrics (turns used against the
    cap, wall/API duration, cost, prompt-cache read/write tokens, reviewable
    diff size, and **which** tools hit permission denials) to the run's step
    summary and annotations — purely for tuning, with no effect on the
    verdict.

  - **CodeQL code scanning** — added as a required check under ADR-0015 so a
    high-severity SAST finding blocks the merge. CodeQL runs via GitHub
    **default setup**; on human PRs and direct `main` pushes it still surfaces
    per-language as `Analyze (javascript-typescript)` and `Analyze (actions)`,
    but as of 2026-08 it reports a single consolidated `CodeQL` check on
    Dependabot-actor PRs instead — the per-language contexts never appear
    there, which permanently blocked merge until this was caught (2026-08-06).
    The required context is therefore the single `CodeQL` check, which is
    observed reporting reliably across both PR classes; `success` and
    `neutral` (a clean scan with zero findings) both count as passing. On
    Dependabot PRs specifically, `CodeQL` can report `neutral` without a real
    scan having run (a manifest/lockfile-only diff gives it nothing to
    analyze) — `Dependency Review` (`fail-on-severity: high`) and `pnpm audit`
    in `verify` are the actual SAST/dependency backstop for that PR class.
    Confirm the exact check-run name on a live PR before re-wiring this rule,
    in case default-setup naming changes again:
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
(`enforcement: active`, `bypass_actors: []`). The policy dates from
2026-07-22 — see the 2026-07-22 update in
[ADR-0016](../adr/0016-signed-commits-and-decision-gate.md) for why — but the
live ruleset object was found recreated on 2026-08-10 (its `id` and
`created_at` changed with no corresponding record of why); identify it by
name, not by numeric id, since the id is not stable across a
delete-and-recreate. It enforces, independently of the classic rule above:

- `deletion` — blocks deleting `main`.
- `non_fast_forward` — blocks force-pushes.
- `required_signatures` — mirrors the classic "Require signed commits" rule.
- `pull_request` — requires a PR (no approval count / CODEOWNERS gate, matching
  the scoping decision above).
- `required_status_checks` — the same four contexts as classic protection:
  `verify`, `review`, `CodeQL`, `Dependency Review`.

Confirm the live state of both layers directly rather than trusting this
page's prose — same rationale as the CodeQL check-run-name command above:

```bash
gh api repos/monte3l/m3l-automation/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
gh api repos/monte3l/m3l-automation/branches/main/protection --jq '.required_status_checks.contexts'
```

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

The comment fallback added on 2026-08-20 does **not** walk that back. The
distinction that mattered was never "file vs comment" as a data source — it was
that nothing failed the check. The enforcing step still fails the job, still
fail-closed, and still refuses anything that isn't `PASS`; it just no longer
throws away a verdict the reviewer demonstrably reached because the process
died a turn later. The SHA pin is what makes a comment trustworthy enough to
read: it must name the exact commit under test, and a PR author cannot post as
`claude[bot]`. The guard step at the top of the same job already trusts that
signal to skip a review outright, which concedes strictly more than reading a
verdict from it.
