# claude-pr-review — turn budget, patch filtering, and verdict recovery

**Status: shipped** — branch `fix/pr-review-turn-budget`, commit `188dbbf`.
Follows the review-gate tuning recorded in PRs #500, #503 and #504.

## Context

The `review` gate failed three times in one morning on PR #523
(`feat/core-procedure-engine`) — runs `32356973634`, `32359063571`,
`32363303781`, all `error_max_turns`, 7/8/10 permission denials, ~$8.15 total,
no verdict produced. The presenting symptom was "max turns reached", but
measuring the gate's own history showed a system that had been running with no
margin for weeks:

- **Denials on every run**, not just failures: 13, 12, 7, 15, 9, 10, 7, 8, 10
  across the last ten runs that reviewed — median ~10, roughly 30% of a
  35-turn budget spent on rejected calls. PRs #503 and #504 had cut this from
  20-23, never to zero, and #504's own commit message flagged its fix as
  "pending confirmation".
- **A saturated cap**: reviews that _succeeded_ used 20, 24, 28, 31, 32 and 34
  of 35 turns. `--max-turns 35` came from "observed max 28/100" and was already
  stale when it shipped.
- **37-88% of the patch was non-reviewable content.** `is_ignored()` marked
  `*.md`/`docs/**` non-reviewable but only ever decided _whether_ to review;
  the pre-compute step filtered one path (`pnpm-lock.yaml`) and handed over
  every doc hunk. `24f7dea`'s 575,724-char patch was 76,817 reviewable.
- **PR #523 was also a real outlier**: 696,940 reviewable chars against a
  142,557 historical maximum.

The sharpest finding was that the review had actually _worked_ twice. Runs 1
and 2 posted complete, well-formed `FAIL` verdicts with correct
`claude-review-sha` markers — both discarded, because the verdict lived only in
`.claude-review-verdict` (which a max-turns abort prevents writing) and
`Enforce review verdict` had no `if: always()`, so it was skipped exactly when
the action failed. A correct review was reported as infrastructure failure.

## Approach / Decisions

1. **Probe before patching.** #503 and #504 had each shipped a fix inferred
   from an unchanged denial count, and a docs check confirmed the mechanics
   they guessed at are undocumented. Twelve probes were run against Claude
   Code 2.1.237 locally instead (full table in the research doc's 2026-08-20
   addendum). They confirmed #504's fix was right — `Edit()` on a plain
   relative path does grant a redirect, `Write()` genuinely is never consulted
   — and found what it missed: the reviewer had **no writable path for the
   comment body**, so `gh pr comment --body-file` (the natural way to post
   multi-line markdown) cost 3 denials over 4 turns for even a two-line file.
   Separately, the prompt instructed a `gh pr diff` fallback the allowlist
   forbade. Several previously suspected culprits were disproven:
   `head`/`tail` and other read-only builtins are auto-approved when unlisted,
   and `Grep`/`Glob`/`TodoWrite` need no grant.
2. **Filter the patch by the gate's own predicate**, mirroring `is_ignored()`,
   with a `(diff omitted — …)` marker per file so an omission can never read
   as an unchanged file. The changed-file list is filtered too, so the reviewer
   is not handed names it was told to ignore.
3. **Fail fast on an unreviewable size** rather than degrade. `MAX_REVIEWABLE_BYTES`
   (300,000) was chosen from data, not intuition: 2.1x the largest reviewable
   patch measured and rejecting 0 of the last 14 merged PRs, while catching
   #523. Claude never starts, so the rejection costs $0 and names the largest
   contributing files. The alternatives considered — raising turns and
   reviewing everything, or dropping `tests/**` from the patch — were declined:
   the first leaves cost unbounded on outliers, the second silently voids the
   prompt's "every new export needs happy- and failure-path tests" rule.
4. **Make the verdict recoverable.** `Enforce review verdict` now runs under
   `!cancelled()` and falls back to the posted `claude[bot]` comment when the
   file is absent — but only on a `claude-review-sha` match against the head
   commit. The SHA pin is what keeps it fail-closed; the guard step already
   trusts that same signal to skip a review outright, which concedes strictly
   more. This does not revive the pre-gate "advisory review" problem
   `branch-protection.md` warns about: the step still fails the job.
5. **Instrument the denials permanently** so this never goes invisible again.
   The result entry carries a structured `permission_denials` array (confirmed
   by probe); the metrics step now reports which tools were denied, with
   inputs truncated, falling back to the result's key names if the schema
   moves. `show_full_output` was rejected — it prints untrusted diff content
   into run logs.
6. **One source of truth for the cap.** `MAX_TURNS` (35 → 60) is a job-level
   env shared by `claude_args` and the metrics step, replacing four
   hand-synced sites; the near-cap warning is 90% of it rather than a
   hardcoded 33.

**Packaging constraint.** The change had to stay within the workflow YAML plus
`*.md` companions. Anything else sets `only_workflow_gate_change=false`, GitHub
then refuses the OIDC token, the action self-skips, no verdict is written, and
the PR cannot merge without an admin override. That ruled out extracting the
verdict parsing into a testable `bin/*.mjs` helper in this PR.

## Outcome

A latent bug surfaced during verification and was fixed in the same commit:
`gh` rejects `--slurp` combined with `--jq` ("the `--slurp` option is not
supported with `--jq` or `--template`", gh 2.97.0). The guard step's comment
fetch used exactly that combination with `2>/dev/null || true`, so `body` was
unconditionally empty and the **prior-PASS skip optimisation had never once
fired** — every non-docs PR paid a full re-review on every push. It failed safe
(over-reviewing), which is why it survived unnoticed.

Verified offline before pushing: the filter reproduces 696,940 chars from
#523's real 1,102,980-char patch with the reviewable portion byte-identical;
the 300k threshold rejects 0 of 14 merged PRs and only #523; the verdict
fallback recovers `FAIL` for the SHA it reviewed, fails closed on the current
head, refuses to resurrect an older comment's verdict, and does not leak a
"PASS" appearing in prose outside the verdict block.

PR #523 stays blocked until it is split — the deliberate consequence of
decision 3. Its two discarded reviews had both found the same real defect: a
`loop` + `continueOnFailure` step without a self-`jumpsTo` entry raising a
misattributed `ERR_PROCEDURE_UNDECLARED_JUMP`.

Measurements, the twelve-probe table, and the sourcing caveat (probes are local
observations of 2.1.237; the action installs 2.1.233) are in
`docs/research/pr-review-action-tuning.md` § Addendum (2026-08-20).
