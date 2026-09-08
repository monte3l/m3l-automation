# Work log — `typescript-guidance-skills` (2026-09-08)

Designed and shipped the `researching-typescript-guidance`/`refreshing-typescript-guidance`
skill pair — the TypeScript-language analogue of the existing
`researching-anthropic-guidance`/`refreshing-anthropic-guidance` pair — plus
`bin/check-typescript-freshness.mjs`, ADR-0098 (raising the skill-listing
budget fraction), and decision note 0006. This log records what shipped, what
matched the plan, three review-loop divergences (one caught by the pre-push
spoke review, two caught by `claude-pr-review`), a WSL-environment recurrence,
and a genuine review-bot escalation resolved via this repo's documented
override procedure.

Plan of record: [`docs/plans/archive/2026-09-08-typescript-guidance-skills.md`](../plans/archive/2026-09-08-typescript-guidance-skills.md)

## Summary

- **PR #1129** (8 commits, merged via documented override) + **PR #1130** (2
  commits, docs-only, auto-merged) — both closed out.
- New files: `.claude/skills/researching-typescript-guidance/{SKILL.md,references/typescript-sources.md,evals/evals.json}`,
  `.claude/skills/refreshing-typescript-guidance/{SKILL.md,evals/evals.json}`,
  `bin/check-typescript-freshness.mjs` + its 27-test suite, `docs/research/typescript/refresh.md`
  (seeded tracker), `docs/adr/0098-raise-skill-listing-budget-fraction.md`,
  `docs/decision-notes/0006-typescript-source-tiering.md`.
- Modified: `bin/check-context-budget.mjs` (`SKILL_LISTING_BUDGET_FRACTION`
  0.01→0.02 + prose), `.claude/settings.json` (the matching setting + 9
  `WebFetch` domain grants), `docs/adr/0089-*.md` (status flip to
  `Partially-superseded`), `CLAUDE.md`/`lefthook.yml`/`package.json`/`bin/lib/{command-catalog,verify-steps}.mjs`/`.github/workflows/ci.yml`
  (gate wiring), `docs/contributing/{skills-catalog,skill-routing,ci-cd,instruction-authoring}.md`,
  `docs/research/README.md`.
- Gates: full `pnpm verify` green (71 non-skipped steps) before every push;
  `check:typescript-freshness` (new), `check:context-budget` (at the new
  16,000-char ceiling), `check:skill-frontmatter`, `check:skill-evals` all
  passing. CI required checks (`verify`, `CodeQL`, `Dependency Review`,
  `review`) all green on the merged commit.
- Skills used: `auditing` (research fan-out), `researching-anthropic-guidance`
  (skill-listing-budget research), `starting-work`, `creating-prs`,
  `syncing-docs`, `resolving-pr-comments` (twice), `finishing-work`,
  `writing-work-logs`.
- Spoke incidents: none (`tmp/session-incidents.jsonl` absent — no
  mechanically-detected truncation; no review-spoke stall or `SendMessage`
  resume observed).
- Compaction events: none observed (`tmp/compact-handoff.json` absent this
  session).

## What went as planned

- **The plan-mode design phase surfaced its own blocker before any code was
  written.** Four parallel Explore/research agents (existing-pair structure,
  repo TS-surface audit, external source-tiering research) plus a live
  `check:context-budget` run found the corpus sat at 7,996/8,000 chars
  _before_ either new description was added — caught at design time, not at
  push time.
- **The `researching-anthropic-guidance` skill worked exactly as designed
  when turned on itself** — a four-agent fan-out against the official
  Anthropic allowlist correctly established the real platform facts
  (`skillListingBudgetFraction` is real, `disable-model-invocation` zeroes
  listing cost, overflow degrades gracefully) that grounded the eventual
  ADR-0098 decision.
- **Both `check:typescript-freshness` and its 27-test suite passed clean on
  first dispatch** — a structural mirror of `check-harness-freshness.mjs`,
  smoke-tested live against the repo before the test suite was written (per
  `harness-artifacts.md`'s own rule), then handed to `test-author` for the
  guarded `bin/tests/**` path.
- **Every `test-author`/`code-reviewer` spoke dispatch converged on the first
  pass** — no resumes, no re-dispatches needed for any of the three spoke
  rounds (initial test port, two review-fix rounds).
- **The overlap and budget gates caught nothing that needed rework** — the
  two new skill descriptions were designed against `bin/lib/skill-frontmatter.mjs`'s
  actual Jaccard-similarity gate before being written, and cleared it on
  first measurement.

## What didn't go as planned, and why

### 1. My own recommendation initially contradicted a 5-day-old ADR, caught only by re-deriving it

Before design began, I recommended raising `skillListingBudgetFraction` to
fit the two new descriptions. The user asked to clarify; investigating
surfaced that ADR-0089 (Accepted 2026-09-03) had already considered and
explicitly rejected that exact raise, with a stated reason ("hides the
growth signal... no established practice for handling the next skill"). This
wasn't a new fact contradicting the ADR's premise — it was the same
option, freshly re-proposed five days later without checking the record.

**Why it happened:** The recommendation was generated from first principles
(observed budget pressure + a plausible fix) without first checking whether
this repo had already decided the question. `docs/adr/README.md` exists
specifically to prevent this, but nothing prompted a check before the first
recommendation.

**Fix for future:** Before recommending a fix to a governed constraint
(anything with its own `check:*` gate or settings key), grep `docs/adr/` for
prior art on that exact constant/setting before proposing a change — not
after the user pushes back. `mcp__m3l__adr_query` makes this cheap enough
that skipping it has no excuse.

### 2. The WSL eslint-OOM recurred three separate times inside `pre-push` specifically, not standalone

A standalone `pnpm exec eslint . --concurrency=1` run passed cleanly (twice).
But the `pre-push` lefthook's `lint` lane — running the identical command
concurrently alongside `test`/`build-exports`/`typecheck`/`format`/`checks`
— crashed with `JavaScript heap out of memory` at a near-identical ~4070MB
V8 old-space ceiling on two consecutive push attempts, despite `free -h`
showing 13GB+ free both times. `ps aux` confirmed nothing else was resident.
Setting `NODE_OPTIONS=--max-old-space-size=10240` for the push command fixed
it immediately and held for all four subsequent pushes.

**Why it happened:** V8's default old-space heap ceiling is fixed
independent of actual host RAM availability; running the type-aware
full-workspace lint concurrently with several other memory-heavy lanes
(especially `test`, which runs four separate Vitest configs) pushes peak
usage over that fixed ceiling even when the _system_ has ample headroom.
`eslint --concurrency=1` already fixed the earlier (different) multi-worker
OOM this repo hit before; this was a distinct, single-threaded ceiling.

**Fix for future:** When a `pre-push` lane OOMs with `free -h` showing ample
system RAM, don't retry blind and don't reach for `--no-verify` — check
whether the crash log's own numbers cluster near a fixed ~4GB boundary
(V8's default), and retry with `NODE_OPTIONS=--max-old-space-size=<N>` set
for the push command. This verifies the exact same gate with more legitimate
headroom; it is not a bypass. Filed as product feedback for a possibly
durable fix (a documented `NODE_OPTIONS` default for `pre-push` in this
repo's own lefthook config, or CI-parity heap sizing).

### 3. A genuinely correct Should-fix from the review bot pointed at my own reasoning, not just my code

`claude-pr-review`'s first round flagged that my ADR-0098 rationale had the
causality backwards: I'd framed "the gate's denominator undercounts the true
listing" as a _reason_ to raise the ceiling, when an undercounted local
denominator checked against a _larger_ ceiling is actually more permissive
relative to the true shared budget, not more accurate. Verifying this
carefully (rather than dismissing it as a style nit) confirmed the bot was
right — I rewrote the comment/ADR prose to remove the backwards framing
rather than defending the original wording.

**Why it happened:** The original rationale was optimized for narrative flow
("here's new evidence, here's why we act on it") rather than for logical
soundness under adversarial reading. Writing a governance-document
justification and stress-testing its actual logic are different skills, and
I only did the first one on the initial pass.

**Fix for future:** When a review flags a stated _rationale_ (not just a
code defect), verify the logic itself before responding — don't assume a
Should-fix on prose is automatically softer than a Must-fix on code. A wrong
rationale in an ADR outlives the PR that wrote it.

### 4. The merged PR's own non-blocking `Run skill evals` job failed, and one of two contributing case failures was a real authoring bug

Post-merge (well, pre-final-merge — this surfaced while `review` was still
converging), `Run skill evals` reported 59.2% (58/98), one case under the
60% `MIN_PASS_RATE` floor. Investigation found the bulk of the corpus's 40
failures were the pre-existing, already-tracked (issue #1087)
`expect_skill_fired` routing-assertion weakness spanning skills never
touched in this PR. But one of the two failures in this PR's own new cases
was a genuine authoring bug: `refreshing-typescript-guidance`'s case 3 is a
deliberate negative-routing test (its own `expected_output` says the skill
should _not_ fire) that was missing the `expect_skill_fired: false` opt-out
ADR-0089 already documents and two other skills already use. Adding the flag
brought the corpus to 69.4% (68/98) on the next run.

**Why it happened:** The eval case was designed correctly (as a negative
test) but the schema-level opt-out that makes the generic firing-assertion
respect that design wasn't applied — a gap between design intent and schema
completeness, not a logic error in the case itself.

**Fix for future:** Any eval case whose `expected_output` describes the
skill deliberately _not_ firing needs `expect_skill_fired: false` set at
authoring time, not discovered later via a failing collapse-detector run.
Treat "does this case's own expected_output say the skill shouldn't invoke"
as a checklist item when writing negative-routing cases, the same way
`.claude/rules/tests.md`'s mutation-testing bullet asks "does this test
actually guard what it claims."

### 5. A trivial one-line follow-up push hit the review bot's `MAX_REVIEW_ROUNDS` ceiling, requiring the documented human-override procedure

After the eval-schema fix above, pushing it re-triggered a third automated
`claude-pr-review` round — but round 2 (the prior push) had already
converged to a clean PASS with `should-fix-ack` also passing. Round 3 hit
`MAX_REVIEW_ROUNDS` (3) before a real review could run against that
one-line delta, and was auto-replaced with FAIL per the round-bound policy.
Per this repo's `bypass_actors: []` design, no one — including the
maintainer — can skip the `review` required check by configuration.
Followed `docs/contributing/branch-protection.md`'s documented override
procedure: investigated the escalation, posted an evidence reply on the PR
thread naming the prior PASS and the trivial nature of the delta, and the
maintainer merged past the FAIL with that record in place.

**Why it happened:** The round-bound policy counts automated review
_attempts_, not distinct convergence failures — a PR that already passed and
then received one more trivial commit still consumes a round slot. This is
a deliberate cost-control tradeoff (`docs/contributing/branch-protection.md`
names it explicitly), not a defect.

**Fix for future:** Once a PR has reached a clean `review` PASS, batch any
remaining small fixes (an eval-schema correction, a typo) into as few
follow-up pushes as possible rather than pushing each independently — each
push after a PASS consumes a round-bound slot that a converged PR doesn't
strictly need to spend. When the ceiling is hit anyway, go straight to the
override procedure rather than trying to coax a fourth automated round.

## Lessons learned

- **Re-derive governed-constraint history before recommending a change to
  it.** A plausible first-principles fix to a `check:*`-gated constant can
  silently re-propose an already-rejected option. Grep `docs/adr/` (or
  `mcp__m3l__adr_query`) for the constant/setting name before recommending,
  not after the user asks "did you check."
- **A `pre-push` lane OOM with ample free system RAM is a V8 heap-ceiling
  issue, not a resource-shortage issue — retry with a raised
  `NODE_OPTIONS=--max-old-space-size`, never `--no-verify`.** This verifies
  the identical gate with more legitimate headroom; three occurrences in one
  session, all fixed the same way, all leaving the actual check intact.
- **A review bot's Should-fix on your own written rationale deserves the
  same verification rigor as a Must-fix on code.** Check the logic, not just
  the tone — a wrong justification in a governance document (an ADR, a gate
  comment) outlives the PR and misleads every future reader who trusts it.
- **A negative-routing eval case needs `expect_skill_fired: false` at
  authoring time, checked against its own `expected_output`.** The generic
  firing assertion has no way to know a case's non-firing is intentional;
  that's the opt-out's whole purpose, and skipping it produces a false
  failure that erodes the collapse-detector's actual signal.
- **Once `review` reaches PASS, minimize further pushes to that PR.** Each
  additional push consumes a `MAX_REVIEW_ROUNDS` slot regardless of how
  trivial the diff is; batch small fixes rather than pushing them
  separately, and treat hitting the ceiling on a converged PR as expected
  overhead handled via the documented override, not a surprise to debug.
  _(promoted → docs/contributing/branch-protection.md)_
- **Deferring a plan-archive entry until a real PR number/merge date exists
  is correct, but costs an extra small PR when the branch is already
  gone.** `delete_branch_on_merge: true` means a squash-merged branch's
  remote ref disappears immediately — any post-merge addition (an archive
  file, a work log) needs a fresh branch off the new `main` tip (or a
  cherry-pick of a locally-drafted commit onto one), not a push onto the old
  branch name. Doing the archival work as its own tiny commit _inside_ the
  original PR, even with a placeholder merge date to fix up later via a
  one-line edit, would have been cheaper than a second full PR cycle.
