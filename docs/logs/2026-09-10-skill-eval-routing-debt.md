# Work log — skill-eval-routing-debt (2026-09-10)

Investigation and fix for issue #1087's 12 always-failing skill-eval cases —
P1 of a 4-PR wave scoped by a live dated plan doc. Records the diagnosis (all
12 were mis-specified corpus data, not routing regressions), a design
correction to the fix caught only by live model probes, and a real bug the
post-push bot review caught that a local re-review pass had missed.

Plan of record: [`docs/plans/2026-09-10-skill-eval-routing-debt.md`](../plans/2026-09-10-skill-eval-routing-debt.md)

## Summary

Shipped PR #1161 (`fix/skill-eval-routing-assertions`, squash-merged as
`945dfeee`), two commits plus a bot-review fix-round commit:

- `bin/run-skill-evals.mjs`: `evaluateSkillFired` gained `expect_routed_to` —
  a negative-routing assertion (the skill under test must NOT fire; the
  named sibling firing is diagnostic only, not part of `met`) — as a third
  opt-out reason alongside the existing `expect_skill_fired: false` cases.
- `bin/check-skill-evals.mjs`: three new static case-shape checks —
  a `/slug` prompt with neither opt-out set, `expect_routed_to` naming a
  skill directory that no longer exists, and `expect_skill_fired: true` set
  alongside `expect_routed_to` (contradictory).
- Corpus: 12 cases across 9 `evals/evals.json` files fixed — 5 converted to
  `expect_routed_to`, 6 to `expect_skill_fired: false`, 1
  (`creating-prs#7`) resolved the same way after two live probes showed no
  description gap to fix.
- `docs/plans/2026-09-10-skill-eval-routing-debt.md` (new): the durable
  4-PR landing plan; this PR lands P1, P2–P4 remain.

Verification: `pnpm verify` (72/72 non-skipped steps) three times across the
session; `node bin/check-skill-evals.mjs` clean against the real corpus;
live-probed every touched skill via `pnpm eval:skills <name>` (creating-prs
probed 3× total, ~$2.1; the other 8 skills once each, ~$2.8) — every
previously-always-failing case now passes.

Skills used: starting-work, creating-prs, syncing-docs,
resolving-pr-comments, finishing-work, writing-commits (invoked inline by
several of the above), writing-work-logs.

Spoke incidents: 1 stall / 0 truncations / 2 resumes — the
`docs-consistency-reviewer` pre-push review spoke hit its 40-turn limit
mid-review and was resumed once to converge; the `test-author` spoke was
resumed twice more for its own follow-up corrections (a design-semantics fix
and a prettier-formatting fix), neither of which was itself a stall or
truncation — see divergences 2 and 3 below.

Compaction events: none.

## What went as planned

- **The corpus diagnosis held up exactly as hypothesized.** All 12
  always-failing cases fell cleanly into the two categories
  `evaluateSkillFired`'s own TSDoc already documented (negative-routing,
  `/slug`-invoked) plus one genuinely-in-scope case — no case needed a third,
  novel explanation once actually read.
- **The `check-skill-evals.mjs` static guards worked on the first real run** —
  run live against the still-unfixed corpus before any corpus edit (per
  `.claude/rules/harness-artifacts.md`), the new `/slug`-without-opt-out check
  flagged exactly the 4 expected cases, nothing else.
- **The hub/spoke boundary held without friction** — every guarded-path edit
  (`bin/tests/**`) routed through `test-author` on the first attempt after the
  `guard-hub-src-writes.mjs` hook caught one direct-edit attempt; every
  non-guarded edit (`bin/*.mjs`, `.claude/skills/*/evals/*.json`,
  `docs/plans/**`) went straight through.
- **The pre-push and PR-level gates matched exactly** — `pnpm verify` passed
  identically before and after the rebase onto a newly-advanced `main`, and
  the pushed branch's CI results mirrored the local run with no surprises.

## What didn't go as planned, and why

### 1. `expect_routed_to`'s first design required the named sibling to fire — live probes proved that requirement wrong

The initial implementation made `met` require BOTH that the skill under test
not fire AND that the named sibling actually fire via the `Skill` tool. Two
live probes against real skills (`implementing-scripts#3` →
`scaffolding-scripts`, `refreshing-anthropic-guidance#3` →
`researching-anthropic-guidance`) showed a model that correctly recommended
the sibling in prose — satisfying every graded criterion — without ever
invoking the sibling's `Skill` tool inline. The design was corrected mid-flight:
`met` now depends only on the skill under test not firing; the sibling firing
is reported (`routedFired`) but not part of `met`. This required a follow-up
correction to the `test-author` spoke's already-written tests for the old
semantics.

**Why it happened:** The design was reasoned out analytically (what SHOULD a
correct redirect look like) rather than checked against what a model
actually does in the eval sandbox first. The intuition that "the routed-to
skill should demonstrably run" seemed obviously correct until a probe showed
that inline-dispatching a second skill mid-turn would mean executing that
skill's own write-capable procedure — not what a single-turn advisory
response should do.

**Fix for future:** For any new harness assertion whose correctness depends
on model behavior (not just code logic), probe it against a real case before
writing the full test suite around it — a $0.35–0.75 probe is cheap insurance
against building tests around a wrong assumption.

### 2. Bot review caught a normalization mismatch a local re-review had already passed

`claude-pr-review.yml`'s post-push review (not the pre-push
`docs-consistency-reviewer` fan-out) flagged that `evaluateSkillFired`
accepted `expect_routed_to: ""` as a valid routing target while
`discoverSkillEvalState` (the checker) already normalized blank as absent —
so a blank value would silently disable the fired-skill requirement at
runtime while neither of the checker's new static guards would ever fire on
it. Fixed by trimming and rejecting blank in `evaluateSkillFired`, matching
the checker exactly; added a regression test; re-reviewed by `code-reviewer`
scoped to the two changed files (clean); pushed as a follow-up commit with an
`Acknowledged-Should-Fix` footer.

**Why it happened:** The two functions (`evaluateSkillFired` in the runner,
`discoverSkillEvalState` in the checker) implement the same field's
semantics independently, and the pre-push review pass reviewed the corpus
and the two files' logic for internal consistency but did not specifically
cross-check edge-case normalization (blank/whitespace) between the two
parallel implementations.

**Fix for future:** When two functions in different files must agree on how
they normalize the same optional field, say so explicitly in the dispatch
prompt to a review spoke — "confirm X and Y agree on blank/whitespace/null
handling for field Z" — rather than trusting a general correctness read to
surface a cross-file normalization gap.

### 3. The `resolving-pr-comments` skill's boundary rules and this repo's hub/spoke rule interacted in a way neither anticipated

The bot's Should-fix fix touched `bin/run-skill-evals.mjs` (hub-editable) but
its regression test touched `bin/tests/run-skill-evals.test.ts` (guarded,
spoke-only) — so implementing one Should-fix finding required both a direct
hub edit and a `test-author` dispatch in the same pass, plus a follow-up
prettier-formatting dispatch when the spoke's edit tripped `format:check`.

**Why it happened:** `resolving-pr-comments`'s own steps assume a single
actor applying fixes; this repo's separate hub/spoke operating model splits
that actor in two along the guarded-path line, which the skill's text
doesn't call out.

**Fix for future:** No change needed to the skill itself — resuming the same
`test-author` agent via `SendMessage` (rather than a fresh dispatch) kept
each follow-up cheap and stateful, which is exactly the pattern
`.claude/rules/subagent-dispatch.md` already prescribes. Worth noting for the
next `resolving-pr-comments` run in this repo: budget for a spoke dispatch as
part of the fix pass whenever a finding touches a guarded path.

## Insights

- **A harness assertion depending on model behavior needs a behavioral probe
  before the test suite is written around it, not just a logical design
  review.** `expect_routed_to`'s original design was internally consistent
  and passed a logical read, but was empirically wrong about what a model
  actually does when recommending a sibling skill — caught only by running
  it, twice, against real skills. _(promoted → .claude/rules/harness-artifacts.md)_
- **When two files independently implement the same field's normalization,
  name the cross-check explicitly in a review dispatch.** A general
  correctness review of each file in isolation can miss a blank/whitespace
  edge case the two disagree on; only an explicit "do these two agree on X"
  instruction reliably surfaces it — this is what the post-push bot caught
  and the pre-push spoke fan-out did not. _(promoted → .claude/rules/subagent-dispatch.md)_
- **A live-run gate check before writing corpus fixtures pays off exactly as
  `.claude/rules/harness-artifacts.md` predicts.** Running the extended
  `check-skill-evals.mjs` against the real, still-broken corpus (before any
  fixture edit) flagged precisely the 4 `/slug` cases and nothing else — a
  clean, immediate confirmation that the gate logic itself was correct,
  independent of the corpus fixes still to come.
- **A repo's `.claude/**` PR change can ride the full paid skill-eval suite
  for free.** `skill-evals.yml`'s path filter triggers on any `.claude/**`
  diff, so this PR's own CI run doubled as free measurement data toward the
  wave's later `MIN_PASS_RATE`-raising PR (P3) — no need to budget a separate
  paid full-suite run for that data point.
