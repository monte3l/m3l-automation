# Work log — skill-eval pass-rate floor raise (2026-09-10)

This log covers P3 of issue #1087's 4-PR remediation plan: raising
`bin/run-skill-evals.mjs`'s `MIN_PASS_RATE` off the routing-debt-depressed
0.60, the issue's own stated exit criterion. P1 (PR #1161) and P2 (PR #1165)
had already fixed the corpus data that made the routing assertion the
dominant failure mode; this task re-calibrated the floor against the
fully-fixed corpus and landed as PR #1170.

Plan of record: [`docs/plans/2026-09-10-skill-eval-routing-debt.md`](../plans/2026-09-10-skill-eval-routing-debt.md)

## Summary

- Fired one deliberate `workflow_dispatch` run of `skill-evals.yml` on `main`
  (run 34508324748) — the workflow's first-ever manual dispatch and only its
  second-ever `main` run. Scored 80/98 = 81.6%.
- Combined that with PR #1165's own CI run (78/98 = 79.6%, the other
  fully-fixed-corpus data point) to set `MIN_PASS_RATE = 0.65`, which needs
  64 of 98 passes (`Math.ceil(0.65 * 98)` is 64), ~14 cases below the
  observed minimum — deliberately wider headroom than the prior floor's
  ~2-case margin, given the thin two-run sample and this session's own
  finding (P2's audit) that a case can pass 2/2 probes and still fail an
  identical pattern on a 3rd run.

- Updated every place that stated the old calibration as current:
  `bin/run-skill-evals.mjs`'s `MIN_PASS_RATE` TSDoc, `.github/workflows/
skill-evals.yml`'s header, the `skill-evals.yml` row in
  `docs/contributing/ci-cd.md`, and `bin/lib/command-catalog.mjs`'s script
  description. The prior 0.60 calibration (15 runs, 63.0-75.0% on the
  then-92-case corpus) is kept as explicitly-labeled historical record, not
  rewritten against the new corpus size. Added a 2026-09-10 addendum to
  `docs/decision-notes/0004-skill-eval-pass-rate-floor.md`.
- `bin/tests/run-skill-evals.test.ts`: dispatched a `test-author` spoke to
  update the tests bound to the real constant's value — 156/156 passed.
- `pnpm verify`: 72/72 passed (one `prettier --write` needed for a
  reformatted table row after the first run).
- Pre-push review: diff had no `src/**` files, so dispatched
  `docs-consistency-reviewer` instead of the code-review spokes. It found one
  real Must-fix (an ambiguous date range in the "prior calibration" prose),
  fixed before pushing.
- PR #1170: `claude-pr-review.yml` verdict PASS with 2 Should-fix (both
  fixed as targeted line edits) and 1 Nit (folded in), resolved with a
  follow-up commit carrying the `Acknowledged-Should-Fix` footer
  `should-fix-ack` requires.
- Merged as `bd5ed1eec1884111a152f5820dd6aed1cfa3bd13`. The follow-up
  commit's own push re-triggered `Run skill evals` for free (this PR touches
  the harness itself), yielding a third data point: 81/98 = 82.7%,
  comfortably clearing the new floor.
- Skills used: `starting-work` (worktree/branch setup), `creating-prs`,
  `resolving-pr-comments`, `writing-commits`, `finishing-work`,
  `writing-work-logs` — followed directly rather than re-invoked via the
  `Skill` tool, since their bodies were already loaded earlier in this
  session (before a mid-session compaction).
- Spoke incidents: none (2 spokes dispatched — `test-author`,
  `docs-consistency-reviewer` — both completed cleanly, no truncation, stall,
  or resume).
- Compaction events: 1 compaction / 1 recovered via handoff (the
  `PreCompact`/`SessionStart(compact)` mechanism correctly re-injected P1/P2's
  full state at the start of this continuation; no figure or decision was
  lost).

## What went as planned

- **The two-data-point calibration produced an unambiguous, internally
  consistent floor** — the arithmetic (`0.65 * 98 = 63.7`, `ceil = 64`) held
  up under an independent `docs-consistency-reviewer` audit and again under
  the bot review, with no disagreement across the five files that restate it.
- **The bonus third data point (81/98 = 82.7%, from the follow-up commit's
  own CI run) landed inside the same band the two calibration points
  predicted**, giving some early confidence the floor's ~14-point headroom is
  real rather than an artifact of a two-run sample.
- **`resolving-pr-comments`' boundary rules resolved cleanly**: both
  Should-fix findings were genuine, targeted line fixes (no structural
  change needed), so nothing had to be skipped or escalated.

## What didn't go as planned, and why

### 1. A `nohup ... & disown` combined with `run_in_background: true` produced a false "completed" signal

The first `pnpm verify` run was launched as `nohup pnpm verify > log 2>&1 &
disown; echo done` with the Bash tool's own `run_in_background: true` also
set. The harness tracked the wrapping shell, which exits almost instantly
once it has launched and detached the real job — so the task-notification
reported "completed (exit code 0)" while `node bin/verify-all.mjs` was still
running, unmonitored, for several more minutes. The same thing then happened
again on the `git push` step. Both were caught only by manually checking
`ps` against the log's last-modified time before trusting the notification.

**Why it happened:** `nohup ... & disown` is itself a complete
detach-and-survive mechanism; wrapping it in `run_in_background: true` makes
the harness track the wrong process — the wrapper, not the payload.

**Fix for future:** Pick one detachment mechanism, not both. Either use
`run_in_background: true` on the plain command directly (no `nohup`/`disown`),
or use `nohup ... & disown` and separately poll the real child PID (`pgrep
-f <command>` right after launch, then a `Monitor` script watching that PID
with `kill -0`) rather than trusting the wrapper's own exit as a completion
signal.

### 2. A drafted comparison ("X points is more than Y") went stale the moment the referenced constant changed

The TSDoc's "re-measure after any corpus change" paragraph said a ~3-point
skill-count swing "is more than the headroom above" — true when written
against the _old_ 0.60 floor's ~2-case margin, but the same sentence
described in absolute terms was left in place while the neighbouring
sentences were updated for the new floor's ~14-point margin. The bot review
caught the contradiction; a second stale citation (a bare `0.60` in a
different function's comment) survived the same rewrite pass untouched.

**Why it happened:** A floor-raise touches several places that each restate
a comparison _relative to_ the constant's value, not just the constant
itself — a global find-and-replace on the numeral catches direct citations
but not comparisons phrased in prose ("more than", "is more than", "exceeds").

**Fix for future:** When changing a calibrated constant, grep the same file
for every place that describes a _relationship_ to it ("more than",
"exceeds", "fits inside", "at N equal to the old count") in addition to
grepping for the literal old value — and prefer `{@link CONSTANT_NAME}` over
a restated literal wherever the prose is really about the constant's current
value rather than a specific historical citation.

## Insights

- **A comparison phrased in prose ("X is more than the headroom above") is a
  hidden dependency on the constant it's judging — treat it like a citation,
  not narrative.** Grepping only for the changed literal misses it; grep for
  the comparison words too (`more than`, `exceeds`, `fits inside`) whenever a
  calibrated threshold changes.
- **Don't combine `nohup ... & disown` with the tool's own
  `run_in_background: true`** — the two mechanisms detach different things,
  and the harness's completion notification then describes the wrapper, not
  the payload. Pick one.
- **A thin calibration sample (2 data points) warrants headroom sized to the
  uncertainty, not to the observed spread** — this session set the new floor
  ~14 points below the minimum of just two runs, deliberately wider than the
  ~2-case margin the original 15-run calibration used, because two runs
  cannot bound the true variance the way fifteen can. The floor is a
  collapse detector, not a corpus-quality gate; erring toward more headroom
  costs nothing when that is the job it does.
- **Waiting on a detached background job needs a real completion signal, not
  a placeholder action to fill the turn.** A `Monitor`/`ScheduleWakeup`
  already produces a notification when the real condition is met — spawning
  an unrelated no-op subagent while waiting adds nothing and wastes tokens.
