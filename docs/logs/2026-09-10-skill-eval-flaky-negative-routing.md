# Work log — skill-eval-flaky-negative-routing (2026-09-10)

P2 of issue #1087's 4-PR routing-debt wave — auditing the flaky-50 tail
for the same defect class P1 (PR #1161) fixed in the always-failing 12.
Records why the plan's pre-identified candidate list didn't match live
evidence, the resulting scope change, and a bot-review round that caught a
real documentation gap.

Plan of record: [`docs/plans/2026-09-10-skill-eval-routing-debt.md`](../plans/2026-09-10-skill-eval-routing-debt.md)

## Summary

Shipped PR #1165 (`fix/skill-eval-flaky-negative-routing`), two commits:

- 18 skill-eval cases across 7 `evals/evals.json` files converted from the
  default `expect_skill_fired: true` to either `expect_skill_fired: false`
  (15 cases, reason 3) or `expect_routed_to` (3 cases, reason 4), based on
  live `pnpm eval:skills <name>` probes (2-3 runs per skill) rather than the
  plan's pre-identified candidate list.
- `resolving-merge-conflicts` audited clean — its two named candidates
  (`#2`/`#4`) reproduced no defect across 2 probe rounds (1 blip on an
  unrelated case, `#1`, not reproduced on retry); left untouched.
- `bin/run-skill-evals.mjs`: `evaluateSkillFired`'s TSDoc reason 3 extended
  to cite this wave's broader evidence (bot-review Should-fix fix).
- `docs/plans/2026-09-10-skill-eval-routing-debt.md`: P1 flipped to
  `Landed (PR #1161)`; P2 row filled in with its branch.

Verification: `node bin/check-skill-evals.mjs` clean (25/25 compliant) after
every corpus edit; all 7 touched skills re-probed to 100% pass after their
fix (`writing-work-logs` showed one unrelated genuine criterion miss on an
interim run — "only one insight bullet" — not reproduced on retry, the
~5-7% baseline content-quality noise issue #1087 itself already attributes
to criterion verdicts, not routing); `pnpm verify` (72/72 non-skipped steps)
once before push.

Skills used: starting-work, creating-prs, resolving-pr-comments,
writing-commits (invoked inline), writing-work-logs.

Spoke incidents: none — a single `docs-consistency-reviewer` dispatch (the
pre-push review, no `src/**` files in the diff) converged on its first pass.

Compaction events: none.

## What went as planned

- **The static gate (`check-skill-evals.mjs`) accepted every edit on the
  first pass** — all 18 field insertions matched the corpus's established
  key-ordering convention and every `expect_routed_to` target resolved to a
  real skill directory, so the orphan/contradiction checks P1 added never
  fired.
- **Every touched skill converged to 100% after its fix**, confirming the
  live-probe evidence was sound rather than a one-off sampling artifact.
- **The pre-push `docs-consistency-reviewer` dispatch and the post-push bot
  review reached the same verdict** (clean/PASS) on the corpus edits
  themselves — only the bot caught the TSDoc gap, which is outside a docs
  reviewer's remit for a `bin/**` harness file.

## What didn't go as planned, and why

### 1. The plan's pre-identified "flaky-50" candidate list didn't match what actually fails live

The plan named 13 specific cases across 8 skills as the audit's starting
point. Live probing found the opposite of a clean match: two of the named
candidates (`resolving-merge-conflicts#2`/`#4`) never reproduced any defect
across 2 rounds, while un-named cases in the same 8 skill files
(`creating-prs#1-3`, `writing-work-logs#1-2`, `implementing-submodules#1`/`#3`,
`refreshing-typescript-guidance#1`, `researching-typescript-guidance#1`)
showed the identical live defect the named candidates were supposed to
have. `creating-prs#5` itself — a named candidate — passed clean on its
first two probes and only showed the defect on a third run, confirming it
belongs on the list but for reasons the first two probes alone couldn't
have shown.

**Why it happened:** the issue's candidate list was derived from historical
CI failure counts at some earlier point in time; by the time this session
probed live, the underlying model-behavior non-determinism the whole
routing-assertion debt is about had simply landed on a different subset of
cases in the same skills. The list was itself an authored claim subject to
the same rot CLAUDE.md's Task Workflow already warns about for ADR censuses
and tracker scope.

**Fix for future:** treat a stale flaky-case list as a starting point for
_which skills to probe_, not which case numbers to fix — probe the whole
skill and act on whichever cases the live run actually flags, the same
discipline P1 already established for `creating-prs#7`.

### 2. Bot review caught a TSDoc gap the corpus fixes alone didn't surface

`claude-pr-review.yml` returned PASS with two Should-fix findings. One
(three skills now have zero cases asserting the skill under test ever
fires) is a real, structural corpus-design gap: `implementing-submodules`,
`refreshing-typescript-guidance`, and `scaffolding-scripts` each had every
one of their cases opted out of the fired-skill assertion across this PR
and P1 combined, because every case in each of those skills showed the
reason-3/4 pattern live. Retaining the assertion on any one of them would
mean reverting a confirmed fix and reintroducing known flakiness — not a
targeted line fix, so left for a human per the skill's boundary rules (a
new, reliably-firing case would need to be authored for each skill, which
is new content, not a fix to existing content). The other
(`evaluateSkillFired`'s TSDoc reason 3 not citing this wave's broader
evidence) was a targeted fix — extended the docstring in the same commit.

**Why it happened:** the pre-push `docs-consistency-reviewer` dispatch was
scoped to doc/corpus consistency, not to auditing per-skill fired-assertion
coverage across the whole corpus — no reviewer in this session's pipeline
was looking at the aggregate effect across all of a skill's cases at once,
only at each edited case individually.

**Fix for future:** when a PR opts out several cases in the same skill's
corpus, explicitly check afterward whether any case in that skill still
asserts the skill fires — a per-case-correct set of edits can still leave a
skill with zero positive coverage.

## Insights

- **A stale candidate list is still worth probing exhaustively, not
  cherry-picking.** Probing every case in each named skill (not just the
  named case numbers) surfaced 5 additional defective cases and cleared 2
  false positives — a scan bounded to the literal candidate list would have
  fixed the wrong things and missed real ones.
- **Removing a routing-assertion false negative can expose a genuine,
  separate content-quality flake.** `writing-work-logs#4` failed on a real
  criterion ("only one insight bullet") once its fired-assertion noise was
  removed — this is the ~5-7% non-routing failure rate issue #1087 itself
  already names, previously invisible under the routing noise. Not
  reproduced on retry; left as-is, out of this PR's scope.
- **Opting every case in a skill's corpus out of the fired-assertion
  removes all positive coverage for that skill, and no gate catches it.**
  `check-skill-evals.mjs` validates each `expect_routed_to`/
  `expect_skill_fired` field's own correctness but has no per-skill floor
  on how many cases may be opted out — three skills now have none. Worth a
  `check-skill-evals.mjs` guard in a future pass (not this one, since fixing
  it means authoring new eval content, not editing existing cases).
- **A single-case probe can pass 2/2 and still belong on the fix list.**
  `creating-prs#5` needed a third run to show the defect that put it on the
  original issue's candidate list in the first place — 2 confirming runs is
  a reasonable bar for classification, not a guarantee of exhaustiveness.
