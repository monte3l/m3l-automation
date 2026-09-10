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

## 2026-09-10 addendum — floor raised to 0.65

Issue 1087 tracked the routing debt this note flagged as the reason the floor
sat far below the ~69% typical run. PR 1161 repaired the 12 cases that failed
in every run and added `expect_routed_to`; PR 1165 audited the flaky tail and
fixed 18 more cases across 7 skills, both mis-specified corpus data (a case
whose graded-correct behavior never invokes the `Skill` tool at all) rather
than genuine routing regressions. Both PRs touch `.claude/**`, so their own CI
runs measured the fixed corpus for free: `pnpm eval:skills` scored 68/98 =
69.4% and 65/98 = 66.3% on the PR-1161-only corpus (2026-09-10, before PR 1165
landed), then 78/98 = 79.6% once PR 1165's fixes were included. A third PR
(this one, `fix/raise-skill-eval-pass-rate-floor`) fired the deliberate
`workflow_dispatch` run on `main` this note's original text flagged as never
having happened, scoring 80/98 = 81.6% on the fully-fixed corpus — the
workflow's first-ever `workflow_dispatch` run and only its second-ever `main`
run.

`MIN_PASS_RATE` moved from 0.60 to 0.65 on those two fully-fixed-corpus data
points (78/98, 80/98): 0.65 requires 64 of 98 passes (`0.65 * 98 = 63.7`),
~14 cases below the observed 78/98 minimum. That margin is deliberately wider
than the original floor's ~2-case headroom on a 15-run band, because two runs
is a far thinner sample: PR 1165's own audit found a case
(`creating-prs#5`) that passed 2/2 independent live probes still fail a 3rd
run on the identical `evaluateSkillFired` pattern the fixes target, meaning
the true variance on this corpus is wider than two data points alone can
show. The choice is deliberately conservative rather than tight — raising the
floor to close issue 1087's exit criterion, not to track the measured rate as
closely as the original 0.60 did.

The pre-fix 92-case calibration above stays as the historical record of why
0.60 was chosen; it is not re-derived against the now-larger 98-case corpus,
since that window's numbers describe a corpus that no longer exists in that
form. Issue 1087's exit criterion (raising `MIN_PASS_RATE`) is met by this
change; the issue's separate main-health.yml coverage gap (its own gap #1)
was closed in a follow-up PR against the same issue.

## Links

- Related: issue 809 (item 5, closed by the original change), issue 1087 (the
  routing debt that kept the floor low; raising `MIN_PASS_RATE` was its exit
  criterion — met by the 2026-09-10 addendum above; its separate
  main-health.yml coverage gap was closed in a follow-up PR the same day)
- Related: `bin/run-skill-evals.mjs` — `MIN_PASS_RATE`,
  `evaluateSuiteOutcome`, `formatSuiteSummary`, `gateFailureMessage`
- Related: `.github/workflows/skill-evals.yml` header, and the
  `skill-evals.yml` row plus required-checks section in
  [`ci-cd.md`](../contributing/ci-cd.md)
- Related: ADR-0089 (the skill-listing trim, the leading hypothesis for the
  routing failures), ADR-0079 (`hub-alarm`'s non-required posture), ADR-0095
  (when a decision note is the right tier)
