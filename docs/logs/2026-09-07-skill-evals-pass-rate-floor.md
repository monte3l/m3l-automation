# Work log — `skill-evals-pass-rate-floor` (2026-09-07)

This log covers item 5 of issue #809 — the last of its eight — which asked for
`continue-on-error: true` to come off `.github/workflows/skill-evals.yml` and
be replaced by a `MIN_PASS_RATE` threshold. Shipped as PR #1089 (squash
`28276299`), which closed #809. It also covers PR #1101, an unplanned fix to
the review gate itself that #1089 was blocked behind. Items 1–4, 6 and 7
shipped 2026-08-31 across #812/#813/#817–#822 and are not covered here.

## Summary

- `MIN_PASS_RATE = 0.60` in `bin/run-skill-evals.mjs` as a **collapse
  detector**, not a corpus-quality gate, with four extracted pure exported
  functions: `resolveMinPassRate`, `evaluateSuiteOutcome`,
  `formatSuiteSummary`, `gateFailureMessage`. The exit decision had been an
  inline `if (failed > 0)` inside the `import.meta.url` main block — which is
  precisely why no test had ever covered it.
- Removed `continue-on-error: true`; rewrote the workflow header (its pointer
  at `docs/plans/IMPLEMENTATION.md` had always been dangling — that file has
  never carried a skill-evals row); refreshed the `timeout-minutes` comment.
- Decision note 0004 carries the durable rationale; `docs/contributing/ci-cd.md`
  gained the floor and the not-a-required-check rationale;
  `branch-protection.md` deliberately untouched. Issue #1087 filed for the
  routing debt, with raising `MIN_PASS_RATE` as its exit criterion.
- 149 tests in `bin/tests/run-skill-evals.test.ts` (42 new), six mutations each
  killed by name.
- Validated on three CI runs across two bases: 62/92 (67.4%), 63/92 (68.5%),
  63/92 (68.5%) — all `Floor: 60.0% — met`, all `Errored: 0`, all concluding
  success.

## What went as planned

- The plan's central judgement — that the honest deliverable is a collapse
  detector, not the gate item 5 imagined — survived full re-derivation. Band,
  minimum, mean, and the routing-vs-criterion split all reproduced.
- The error-class refusal (a case producing no verdict fails the run
  regardless of rate) turned out to be free: zero error-class failures across
  the calibration window, so the arm never fires on a healthy run while still
  catching the #808 / expired-OAuth collapse class.
- Decision-note tier was right per ADR-0095 — a real decision, low blast
  radius, cheaply reversible.
- The not-a-required-check posture got a live confirmation nobody designed:
  after the required checks went green, #1089's `mergeStateStatus` read
  `UNSTABLE` rather than `BLOCKED` while skill-evals was still running.
  `BLOCKED` means a _required_ check is failing; `UNSTABLE` means only a
  non-required one is outstanding. So the workflow can report red without
  ever making a PR unmergeable — exactly what decision note 0004 argues.

## What diverged, and why

- **The floor needs 56 of 92, not 55.** The plan specified 0.60 as "55 of 92,
  ~3 cases below the observed minimum". `0.6 * 92 = 55.2`, so 55 scores 59.78%
  and _fails_; the true minimum passing count is 56, leaving **2** cases of
  headroom. Shipped at 0.60 (the round number was the decision) with the
  corrected count in the TSDoc and a test pinning
  `Math.ceil(MIN_PASS_RATE * 92) === 56`.
- **The plan's measurement table was stale on arrival** — 14 runs recorded, but
  four more had completed since and one (`34062713923`) was missing entirely.
  Re-derived to 15 runs on the 92-case corpus; band and minimum unchanged, the
  sample was simply larger than recorded.
- **A design agent's premise was wrong in a way that would have inverted a
  decision.** It reported zero error-class failures and argued the refusal was
  too brittle to ship — but its grep omitted the "produced no
  structured_output" message, the very branch `parseVerdictEnvelope`'s own
  comment ties to cases in the always-fail list. Grepping the real message across three runs
  including both extremes returned zero, so its conclusion was right by
  accident. Had it been non-zero, an unconditional refusal would have failed
  every run and blocked every PR.
- **My first cut of the filtered-run rule was backwards.** I gave a
  single-skill run `minPassRate: 0`, which made routing failures exit 0 —
  disabling the gate for a probe instead of leaving the probe strict. Reading
  the plan's §1 against its verification step 4 caught it; fixed by extracting
  `resolveMinPassRate` so the mode rule became assertable instead of buried in
  the main block.
- **The review bot found a genuine fail-open.** `M3L_EVAL_MIN_PASS_RATE=" "` is
  truthy and `Number(" ")` is `0`, which the `[0, 1]` range check accepted as a
  _valid_ threshold of zero — silently switching the collapse detector off
  while reporting a met floor. No gate caught it; the bot did.
- **PR #921's date was wrong in the plan** (2026-09-02; actually 2026-09-03).
  It mattered: ADR-0089's listing trim is also dated 2026-09-03, so the two
  landed the same day, not the same week — the CI timeline alone therefore
  cannot attribute the pass-rate drop to one rather than the other. Recorded
  in #1087.
- **Two rebases, two different collision classes.** The first surfaced a
  decision-note _number_ collision (main's #1088 had already shipped
  `0003-unwired-hook-events.md`), not a text conflict; renumbered to 0004. The
  second overlapped only `bin/lib/command-catalog.mjs` and auto-merged.
- **PR #1089 was blocked by a bug in the review gate, not by its own content**
  — see below. That cost an unplanned PR (#1101) and was the single largest
  divergence from plan.

## The review-gate delta-anchor bug (PR #1101)

After the first rebase, `review` failed in 12 seconds without reviewing
anything:

```text
Delta review: comparing fe54fd55...bb52d8a2 (since the prior PASS) instead of the full diff.
Reviewable patch: 417946 chars (limit 300000).
```

The real reviewable diff was 36,115 chars. `claude-pr-review.yml` optimizes a
re-review by diffing only what changed since the prior PASS, via
`gh api compare/$REVIEWED_SHA...$HEAD_SHA` — a **three-dot** comparison, which
diffs `HEAD` against `merge-base(A, B)`. That is correct only while the commit
that earned the prior PASS is still an ancestor of `HEAD`. The rebase orphaned
it, the merge-base collapsed back to the branch's old base, and the "delta
since PASS" silently became the full diff from before `main` advanced — nine
commits of other people's code. The size ceiling then rejected the PR and
skipped the review, naming `bin/lib/mcp-tools.mjs` and
`scripts/agent-operator/**` as the largest contributors and advising "split
this into smaller PRs", which would not have helped.

Two things made it worse than a one-off:

- **It could not self-heal.** The existing fail-safe falls back to the full
  diff only when the SHA marker is _missing_; a stale PASS comment still has
  one, so every re-run recomputed the same bad delta. The only exits were
  recreating the PR or a human override merge.
- **It recurs for any PR rebased after earning a PASS**, which is routine here.

The fix is one condition, using data already in the fetched response: `status`
is `"ahead"` exactly when `behind_by == 0`, and `"diverged"` after a rebase.
Requiring `"ahead"` costs no extra API call and reuses the existing
untrustworthy-delta branch, already written to degrade to the full diff rather
than abort. Verified against the real payloads before wiring it — `diverged`
(59 files) falls back, `ahead` (5 files) still takes the delta, empty and
malformed both fall back. After merge, #1089's next run logged exactly the new
diagnostic and reviewed 40,550 chars, returning a real PASS.

`#1101` is deliberately a one-file PR: a PR touching `claude-pr-review.yml`
cannot get a live review (GitHub withholds the OIDC token when the running
workflow differs from `main`'s copy), and the auto-pass step warns about but
still passes any _other_ reviewable files riding along. Keeping it isolated
meant nothing else landed unreviewed — which is also why the guard has no unit
test. Moving the ancestry check into `bin/lib/pr-review-gate.mjs` with tests
needs its own, normally-reviewable PR; that is open debt.

## Lessons

- **Re-derive a gate's stated precondition before executing it; an unrelated
  hardening PR can make it unreachable.** Item 5's "two consecutive green
  `main` runs" rested on a closing comment asserting every failure was a corpus
  defect. PR #921 falsified that three weeks later, and the workflow had run on
  `main` exactly once ever with zero `workflow_dispatch` runs — a baseline with
  a sample size of zero. Executing the plan literally would have meant waiting
  for a condition that could not arrive.
- **A self-graded suite's pass rate is only gate-worthy to the extent its
  failures are deterministic.** Here ~93–95% of failures are one routing
  assertion, 12 cases always fail, and 50 of 92 flip between runs. That makes a
  floor legitimate only as a collapse detector; gating near the observed rate
  would make every unrelated `.claude/**` PR a coin flip.
- **A threshold stored as a fraction needs its integer count pinned by a
  test.** `0.60` and "55 of 92" read as the same decision and are not.
- **Write measurement ranges, not censuses, in comments.** The
  `timeout-minutes` comment first pinned "26.9–28.3 minutes across all 15
  runs" — true when written, falsified by the very next run at 30m53s.
- **Disabling a gate for a narrow mode is not the same as leaving that mode
  strict.** Both read as "the floor doesn't apply to a filtered run"; only one
  exits 0 on real failures. Any per-mode exemption needs its own named test.
- **A blank-but-set env var is a fail-open.** `" "` is truthy and `Number(" ")`
  is `0`. Trim before the truthiness test.
- **A delta-review optimization anchored on a commit SHA is only valid while
  that SHA stays an ancestor.** Verify ancestry, don't assert it in a comment.
  Generalising: any cached-baseline optimization keyed on a mutable ref needs
  an explicit staleness check, because the failure mode is not an error — it is
  a plausible-looking wrong answer.
- **A decision-note number is a shared resource, like a PR number.** Two
  branches can each mint `0003` and git will merge both files without a
  conflict; only the index table collides. Check the live directory, not your
  branch's copy.
- **Verify a rename-carrying rebase preserved later patches.** Git's rename
  detection retargeted a subsequent commit correctly, but "correctly" is a
  claim to check by grepping the moved content.
- **A size-gate failure naming files you never touched means a stale base, not
  an oversized PR.** This is the second recorded instance of that class; the
  gate's own advice ("split this into smaller PRs") pointed the wrong way both
  times.
