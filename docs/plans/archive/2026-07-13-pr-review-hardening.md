# Tune `claude-pr-review.yml` for this repo's typical PR size

**Status: shipped** (PR #132, commit 58ded7c)

## Context

An audit of 121 merged PRs found a mean of 940.7 total changes / 14.6
changed files per PR (median 424 / 10, p90 2,667 / 35, max observed
5,029 / 71). The existing `claude-pr-review.yml` gate already had solid
infrastructure — a pre-computed single-patch diff, a 100-turn budget with a
warn-at-98 threshold, skip-on-no-reviewable-change via a SHA marker, a
single sticky comment, fail-closed verdict — but no job timeout, no
visibility into diff truncation, and no handling for the one large
generated file that regularly bloats the diff. A parallel research pass
against official Anthropic sources confirmed no published diff-size
threshold exists for `max-turns`, `timeout-minutes`, or model tier, so the
goal was hardening what already existed rather than inventing an
unvalidated size-based escalation rule.

## Approach / Decisions

- Added `timeout-minutes: 45` to the `review` job (previously unset,
  falling back to GitHub's 360-minute default) — sized as generous buffer
  over Anthropic's own ~20-minute average review-time citation, scaled for
  this repo's largest observed PRs.
- Investigated stripping "generated file" noise from the diff before
  review. Of the four candidates named up front (`coverage-final.json`,
  `dist/**`, `*.provenance.json`, `pnpm-lock.yaml`), three turned out moot
  on verification: `dist/`/`coverage/` are gitignored (never in a PR diff)
  and `*.provenance.json` sidecars already sit under the workflow's
  existing `paths-ignore`. Only `pnpm-lock.yaml` was a real, diff-visible
  candidate.
- Rejected the officially-documented mechanism
  (`.claude/settings.json` `permissions.deny` on `Read`) for that lockfile
  case: the workflow pre-computes the _entire_ PR diff into one
  `.claude-pr-diff.patch` file read wholesale, so a per-file deny rule is
  never consulted — the lockfile diff is already inlined, not read
  separately. Instead, the fix strips the `pnpm-lock.yaml` hunk out of the
  pre-computed patch at generation time (non-fatal on failure — leaves the
  patch as-is rather than aborting the job), noting the lockfile is
  validated elsewhere (`pnpm install --frozen-lockfile` in CI,
  `dependency-review.yml`).
- Added a patch-size truncation warning: if the computed patch approaches
  the action's documented 150k-character diff-truncation limit, emit an
  `::warning::` annotation and a `$GITHUB_STEP_SUMMARY` note flagging that
  the review may be incomplete, reusing the existing metrics step's
  reporting pattern rather than a new channel.
- Deliberately kept `--max-turns 100` and the model flat — no size-based
  escalation — per the "no official threshold" research finding, recorded
  as a documented decision (not silence) in `docs/contributing/model-selection.md`.
- Persisted the research pass as `docs/research/pr-review-action-tuning.md`,
  following the repo's provenance-header convention, with an index row
  added to `docs/research/README.md`.

## Outcome

Landed as PR #132 (commit `58ded7c`) on 2026-07-13: `timeout-minutes: 45`,
the `pnpm-lock.yaml` hunk-stripping step, and the truncation-risk warning
in `.github/workflows/claude-pr-review.yml`; the flat-config rationale note
in `docs/contributing/model-selection.md`; and the new
`docs/research/pr-review-action-tuning.md` snapshot. Verified end-to-end by
letting the modified workflow review its own PR.
