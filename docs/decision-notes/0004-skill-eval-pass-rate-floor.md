# 0004. A collapse-detector pass-rate floor for the skill-eval suite

- **Date:** 2026-09-07
- **Decider:** repo maintainer

Item 5 of issue 809 asked for `skill-evals.yml` to stop being informational
and gate on a `MIN_PASS_RATE` threshold recorded from two consecutive green
`main` runs, on the premise — recorded in that issue's own closing comment —
that "across four CI runs, every failure was a genuine corpus defect, not
flake". Both halves had expired by the time the work was picked up. PR 921
(`42122f46`, 2026-09-03) added `evaluateSkillFired`, which additionally fails
any case whose skill under test never fired via the `Skill` tool; that took
the suite from 100% (77/77, run 33447797950) into a 63.0%–75.0% band and made
routing, not corpus quality, the dominant failure mode — ~93–95% of every
failure in the calibration window is that one assertion rather than a
criterion verdict, 12 of 92 cases fail in every run, and 50 flip between runs
on an unchanged corpus. The stated precondition was also unreachable: the
workflow has run on `main` exactly once ever (run 33418702130, `schedule`,
2026-08-31, 18/46 on the pre-repair corpus) and has never had a single
`workflow_dispatch` run, so a two-`main`-run baseline had a sample size of
zero while 15 PR-branch runs on the current 23-skill / 92-case / 432-criterion
corpus were sitting there unused. So the gate that shipped is not the one item
5 imagined: `MIN_PASS_RATE = 0.60` is a **collapse detector**, calibrated from
those 15 runs (min 58/92 = 63.0%, max 69/92 = 75.0%, mean ~68.6%) and set so
that a 92-case run needs 56 passes — two cases below the observed minimum,
deliberately thin headroom on a wide band, chosen so the measured spread
cannot trip the gate while a genuine collapse cannot hide under it. It exists
to catch the harness going dark, which has happened twice and scored 0% both
times: the issue-808 `--restricted` regression that graded all 46 cases
against a Claude which could not see the skill under test, and the expired
OAuth token that produced 46/46 spawn failures. It explicitly does not catch a
single skill's regression — one case is 1.1 points at N=92 — and gating nearer
the observed rate would turn every unrelated `.claude/**` PR into a coin flip,
the outcome item 5 itself warned against. Two contract choices are worth
recording because the arithmetic does not imply them. Error-class failures —
a case that produced no verdict at all, from a spawn failure, an unparseable
stream, a missing terminal envelope, or an envelope carrying `is_error` — fail
the run regardless of pass rate, because they are harness faults rather than
grades and a partial auth incident must not be able to sit under a 60% floor
and report green; this is a class refusal rather than a calibrated allowance
precisely because there were zero error-class failures across the calibration
window, leaving no non-zero baseline to calibrate against. (The accepted risk
is that a legitimately heavy case exceeding `DEFAULT_MAX_BUDGET_USD` surfaces
as error-class and would redden the job; measured per-case spend is ~$0.089
against a $0.50 ceiling, so there is ~5.6x headroom, and if that ever fires
routinely the answer is a calibrated `MAX_ERRORED_CASES`, not softening the
refusal.) And the floor governs the full suite only: a single-skill run
requires every case to pass, the script's original behaviour, and the env
override cannot loosen that. A rate floor needs N — at the 3–5 cases
`check:skill-evals` guarantees per skill the quantum is 20–33 points, so 0.60
would fail `pnpm eval:skills writing-commits` for behaving exactly as the full
suite it belongs to does, and a gate that fails on correct behavior gets
routed around. The workflow is **not** promoted
to a fifth required status check, and is not going to be. It is the only
path-filtered workflow in the repo, and GitHub reports a required context that
never fires as _pending_ rather than _skipped_, so promoting it would leave
every PR touching none of its trigger paths permanently unmergeable; dropping
the filter is not the equivalent fix at $8.13–$8.35 and roughly 27–31 minutes
per run. Reporting red is the entire enforcement, the same visible-but-non-blocking
posture the repo already uses for `hub-alarm` (ADR-0079). This is a decision
note rather than an ADR on ADR-0095's grounds: it is a real decision with low
blast radius and is cheaply reversible — change one number, or re-add
`continue-on-error: true` — and nothing else in the repo depends on its exact
form.

## Links

- Related: issue 809 (item 5, closed by this change), issue 1087 (the routing
  debt that keeps the floor low; raising `MIN_PASS_RATE` is its exit
  criterion)
- Related: `bin/run-skill-evals.mjs` — `MIN_PASS_RATE`,
  `evaluateSuiteOutcome`, `formatSuiteSummary`, `gateFailureMessage`
- Related: `.github/workflows/skill-evals.yml` header, and the
  `skill-evals.yml` row plus required-checks section in
  [`ci-cd.md`](../contributing/ci-cd.md)
- Related: ADR-0089 (the skill-listing trim, the leading hypothesis for the
  routing failures), ADR-0079 (`hub-alarm`'s non-required posture), ADR-0095
  (when a decision note is the right tier)
