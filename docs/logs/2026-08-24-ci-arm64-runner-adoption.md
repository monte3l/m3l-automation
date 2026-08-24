# Work log — ci-arm64-runner-adoption (2026-08-24)

This log covers finalizing the ARM64 CI runner trial from
`docs/plans/archive/2026-08-19-ci-performance-optimization.md` § PR4: an
`/auditing` pass measured the trial's data against its own decision rule,
confirmed no ADR was warranted, and the `build`/`test` jobs in
`.github/workflows/ci.yml` were switched from a `ubuntu-latest`/
`ubuntu-24.04-arm` trial matrix to `ubuntu-24.04-arm` alone.

Plan of record: [`docs/plans/archive/2026-08-19-ci-performance-optimization.md`](../plans/archive/2026-08-19-ci-performance-optimization.md)

## Summary

**Decision**: adopt `ubuntu-24.04-arm` as the sole runner for the `build` and
`test` jobs; the `ubuntu-latest` leg, the trial `strategy.matrix`, and the
arm-only `continue-on-error` scaffolding were removed.

**Data that drove the call** (audited via `gh run list`/`gh run view` and
spot-verified directly against one run's raw job timestamps):

| Job   | x64 runs | x64 median | arm runs | arm median | arm/x64 |
| ----- | -------- | ---------- | -------- | ---------- | ------- |
| Build | 12       | 108.5s     | 12       | 89s        | 0.82    |
| Test  | 15       | 151s       | 15       | 123s       | 0.81    |

ARM64 was ~18–19% faster on both jobs with lower variance, and had zero
ARM-specific failures across the 50 most recent `ci.yml` runs. The plan's
≥10-runs-per-arch threshold was cleared for both jobs.

**Reliability**: the two packages the trial plan flagged as ARM risks did not
materialize as risks. `better-sqlite3` compiles from source
(`node-gyp rebuild`) on **both** x64 and ARM — neither architecture has a
prebuilt binary for this platform/Node combination, so ARM carries no extra
compile tax relative to x64. `unrs-resolver` installed cleanly on both. The
one build/test failure in the sample window (run `32700856993`) failed
identically on both legs (a TypeScript error), not an ARM-specific fault.

**ADR check**: confirmed against `docs/adr/README.md`'s five ADR triggers and
against ADR-0034 (a superficially similar CI-tooling-evaluation ADR) as a
non-precedent — this decision meets none of the triggers, so no ADR was
written; this work log is the decision's sole record, per the archived plan's
own framing.

**Commit-hash correction**: the archived plan cites commit `9119c7f` for
PR4, but the real merge commit is `0c4b4ba` (PR #499,
"ci: trial ubuntu-24.04-arm on the build and test lanes"). `9119c7f` does not
exist anywhere in `git log --all`. The archived plan is immutable and was
left as-is; this is the corrected reference.

**Files changed**: `.github/workflows/ci.yml` (matrix/continue-on-error
removed from `build`/`test`, three trial-framing comments rewritten to
reflect the finalized state), this work log.

**Skills used**: auditing, starting-work.

**Spoke incidents**: none — all 4 audit Explore agents (origin-decision,
timing-data, reliability-compatibility, decision-record-convention)
completed and returned clean digests on the first pass.

## What went as planned

- The 4-facet audit fan-out returned clean, well-scoped digests on the first
  pass with no truncation or re-dispatch needed.
- The `auditing` skill's `Workflow` tool (audit-fanout) was unavailable in
  this session; the documented manual fallback (one Explore agent per facet,
  no adversarial refute pass) worked cleanly, with hub-side verification
  covering the gap.
- A direct spot-check against `gh run view 32724180070 --json jobs` matched
  the timing-data facet's reported per-run durations exactly (e.g. arm
  build 99s and x64 test 189s both appeared in the facet's raw sorted
  duration lists), confirming the reported medians were real, not
  fabricated or misparsed.
- Branch protection's required status checks list only `verify` (plus
  `review`/`CodeQL`/`Dependency Review`) — confirmed via
  `gh api repos/{owner}/{repo}/branches/main/protection` before editing
  `ci.yml`, so removing the `build`/`test` matrix needed no branch-protection
  settings change.
- The `ci.yml` edits were surgical: a post-edit `grep` for
  `matrix.runner|matrix:|ubuntu-latest|ubuntu-24.04-arm|continue-on-error`
  confirmed no leftover trial references outside the intended lines.

## What didn't go as planned, and why

### 1. The archived plan's cited commit hash doesn't exist in the repo

The origin-decision audit facet found that
`docs/plans/archive/2026-08-19-ci-performance-optimization.md` cites commit
`9119c7f` for PR4, but the actual merge commit is
`0c4b4ba46c68ca04ce6cd6a3dfea12bb44e49e8f` (PR #499). `9119c7f` does not
appear anywhere in `git log --all`. Per this repo's "plans are immutable"
convention, the archived plan was left unedited; the correct hash is
recorded in this log instead.

**Why it happened:** Most likely a transcription error at plan-authoring
time — the hash may have been copied from a pre-merge branch commit that a
squash-merge later invalidated.

**Fix for future:** When a plan cites a specific commit for a PR that hasn't
merged yet, re-verify the hash after merge before archiving, or cite the PR
number alone (`#499`) instead of a hash that a squash-merge can silently
invalidate.

## Lessons learned

- **Spot-check one raw data point before trusting an audit agent's reported
  metrics for a real decision.** A single direct `gh run view` call against
  one of the cited run IDs confirmed the timing-data facet's numbers were
  real rather than fabricated or misparsed — cheap insurance before finalizing
  an infrastructure decision on subagent-reported data.

- **Confirm branch-protection required-check names before removing a CI
  matrix.** This repo's required checks reference only the `verify`
  aggregator job, never per-matrix job names — worth confirming via
  `gh api .../branches/main/protection` whenever a matrixed job is being
  collapsed, since a repo that _did_ require per-matrix-leg checks would need
  a branch-protection update in the same change.

- **A PR number survives a squash-merge; a pre-merge commit hash does not.**
  Cite the PR number in a plan when the exact merge commit isn't known yet —
  it stays valid regardless of how the branch is merged, where a hash copied
  before merge can point at a commit that no longer exists afterward.
