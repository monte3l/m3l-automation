# Work log — X8a human-action spec reconciliation (2026-09-11)

Resolves issue #1056 (tracker row X8a): `applyHumanActionAudit` checked route →
spec but never the reverse, so a typo'd or stale `HUMAN_ACTION_SPECS` key
silently audited nothing. This log covers the full loop — plan, TDD
implementation, an in-flight design correction caught by independent review,
and the post-merge Should-fix cycle on PR #1183 — plus a small follow-up PR
(#1187) for the tracker-status close-out.

(No repo-tracked plan file — the design plan lived in this session's
transcript and a local, non-repo plan-mode file, not `docs/plans/`. Per this
task's scope — a single-PR package-capability fix, not a multi-PR wave or a
governance/harness change — it does not clear `starting-work`'s archival bar
and was not written to `docs/plans/archive/`.)

## Summary

Shipped `assertHumanActionSpecsAreLive(routes, wiring)` in
`packages/m3l-console-server/src/boot/human-action-audit.ts` — the spec →
route complement of the existing `applyHumanActionAudit` route → spec guard.
Reconciliation runs **per route group** (`runs`/`sessions`), not
all-or-nothing: each `HUMAN_ACTION_SPECS` key is classified by its own path
template via a new `humanActionSpecGroup` helper, and checked only when that
group is wired — a console with only run orchestration wired is still held to
its own four `runs`-group keys. Also extracted `humanActionSpecKey` as the
single source of truth for the `"<METHOD> <path>"` key grammar, replacing
three inline template-literal constructions.

- **Public surface**: two new exports (`HumanActionRouteWiring`,
  `assertHumanActionSpecsAreLive`) plus `humanActionSpecKey`; all internal to
  a `private: true` package with no `exports` map — zero semver impact.
- **Tests**: 27/27 in the target file (17 pre-existing + 7 initial X8a tests
  T1–T7 + 2 per-group tests T3b/T3c + 1 `humanActionSpecKey` pin), full
  package suite 3093/3093 passing, no regressions.
- **Gates**: `pnpm verify` green (72/72 steps, 10 correctly skipped) on both
  the feature push and the Should-fix follow-up push; `pnpm typecheck`,
  `pnpm lint`, `pnpm knip`, `pnpm check:zones`, `pnpm check:file-budget` all
  clean throughout.
- **Review verdicts**: `code-reviewer` (initial pass: 1 Must-fix — the
  all-or-nothing gate; re-check after the fix: PASS, no findings),
  `silent-failure-hunter` (same Must-fix, independently converged),
  `spec-conformance-reviewer` (conformant, nit-level findings only),
  `claude-pr-review.yml` (first pass: PASS with 2 Should-fix; second pass
  after the fixes: PASS, 0 Must-fix/Should-fix/Nits).
- **Docs**: `docs/reference/console.md` Known limits section gained a new
  bullet for the reverse-direction guard; ADR-0070 gained a 2026-09-11 Update
  recording the shipped shape, the design iteration, and four rejected
  alternatives; `docs/plans/IMPLEMENTATION.md`/`2026-08-20-m3l-console.md`/
  `README.md` tracker rows flipped to Done in a separate follow-up PR #1187
  (auto-merged, docs-only).
- **GitHub**: issue #1056 auto-closed by PR #1183's `Closes #1056` reference
  on merge; `pnpm sync:hub -- --apply` reconciled the epic's board priority
  and archived the closed issue's board card.

Skills used: starting-work, creating-prs, syncing-docs (invoked directly once,
plus once each inside creating-prs Step 5 and resolving-pr-comments Step 8),
resolving-pr-comments, finishing-work, writing-work-logs.

Spoke incidents: 1 truncation / 0 stalls / 2 resumes (1 truncation-recovery
resume on `code-implementer` after it hit its 40-turn limit mid-fix; 1
design-correction resume on `test-author` to revise the RED tests for the
corrected per-group contract — not truncation-related).

Compaction events: none observed.

## What went as planned

- **RED failed for the right reason twice.** Both the initial `test-author`
  dispatch (7 tests) and the revision dispatch (T3b/T3c) produced `TypeError:
... is not a function` against the not-yet-existing exports — never a
  syntax error in the test file itself. Independently re-ran both times to
  confirm before dispatching the implementer.
- **The plan's core design decision held up.** Gating the reverse guard on
  full subsystem wiring (rather than checking unconditionally) was correctly
  identified up front as necessary — a literal "every spec key must name a
  registered route" check would have refused to boot any console without
  run orchestration or the session workbench wired, a supported,
  documented configuration this package's own tests exercise.
- **The rejected-alternatives framing held.** Four alternative designs were
  evaluated and rejected during planning (per-spec gate metadata, route-table
  prefix derivation, a maximal template manifest, an inert-port probe); none
  needed revisiting when the all-or-nothing gate was later corrected to
  per-group — the fix (classify by the spec key's own text) was a genuinely
  new option, not a fallback to a previously-rejected one.
- **`pnpm verify` and the pre-push hook were clean on both pushes** — no gate
  failure required a fix-and-retry cycle at that layer.
- **The GitHub `Closes #1056` keyword worked exactly as expected** — the
  issue auto-closed at the same timestamp as the PR merge, with no manual
  `gh issue close` needed.

## What didn't go as planned, and why

### 1. The initial implementation shipped an all-or-nothing wiring gate that defeated its own purpose

The first `code-implementer` dispatch built `assertHumanActionSpecsAreLive`
exactly as I had specified in the delegation prompt: `if (!wiring.runs ||
!wiring.sessions) return;` — reconcile everything, or reconcile nothing.
Two independently dispatched review spokes (`code-reviewer` and
`silent-failure-hunter`) both caught the same real defect: a console running
only `runs` (a supported, real configuration) got **zero** reconciliation,
including for its own four `runs`-group keys — the gate exempted the wired
group along with the unwired one, silently reintroducing the exact class of
gap X8a existed to close, for exactly the consoles most likely to run it.

I designed a fix (classify each spec key's group from its own static path
text via a new `humanActionSpecGroup` helper, checked per-key against
`wiring`) and dispatched `test-author` to revise the RED tests for the
corrected contract, then resumed `code-implementer` to implement it. A
second bounded `code-reviewer` re-check confirmed the fix and found nothing
new.

**Why it happened:** The delegation prompt to the implementer specified the
all-or-nothing gate explicitly, carrying forward the _design agent's_
original recommendation without re-deriving whether "gate on full wiring"
necessarily meant "check nothing unless everything is wired" versus "check
each key against its own group's wiring." The two readings look similar in
prose but differ completely in behavior, and I approved the plan (and the
user confirmed it via AskUserQuestion) without an example table walking
through the `{runs: true, sessions: false}` case concretely enough to
surface the gap before implementation.

**Fix for future:** When a plan's core mechanism has more than one
plausible interpretation of "gated on X," write out the truth table for
every combination of the gating inputs (here: `{true,true}`,
`{true,false}`, `{false,true}`, `{false,false}`) in the plan itself, not just
in the delegation prompt — and have the reviewing agent (or the human) check
it before dispatching the writer, not after.

### 2. `code-implementer` hit its 40-turn limit mid-fix and required a resume

The dispatch to apply the per-group classifier fix (after the Should-fix
findings for it were raised by `claude-pr-review.yml` on the already-merged
PR's predecessor round — see below) stopped with a partial result at its
turn limit while mid-way through a Prettier/ESLint cleanup pass. Per this
repo's documented recovery pattern, `bin/spoke-recovery.mjs` was tried first
but reported no journal path was available (none had been requested from
this particular spoke); fell back to directly verifying on-disk state
(`git status`, `git diff`) before resuming the same spoke via `SendMessage`
with a summary of what was already confirmed present, rather than
re-deriving the fix from scratch.

**Why it happened:** The dispatch prompt for the earlier (first-round)
`code-implementer` task did not include a scratchpad journal path, so when a
_later_ resumed instance of essentially the same spoke role hit its turn
limit, there was no durable trace to recover from — only the working tree
itself.

**Fix for future:** Always hand a writer spoke an explicit scratchpad journal
path on dispatch (per `.claude/rules/subagent-dispatch.md`'s existing
guidance), even for a fix expected to be small — a "small" fix is exactly the
kind of dispatch that gets no journal today, and is exactly the kind that can
still truncate mid-cleanup-pass.

## Insights

- **A gating condition's prose ("gated on full wiring") can hide a real
  behavioral choice between "check the whole thing" and "check each part
  against its own condition."** Write the truth table for every combination
  of the gating inputs into the plan before dispatching the writer spoke,
  not just into the delegation prompt — a plan-level table gets reviewed at
  plan time, a prompt-level one only gets checked after the code exists.
- **Classifying a stable, hand-authored table's own keys by their text is
  safer than deriving liveness from a mutable table the keys are supposed to
  match against.** `humanActionSpecGroup` classifies each `HUMAN_ACTION_SPECS`
  key from its own path template rather than from the currently-registered
  routes — the latter would have reintroduced exactly the "silent on a
  whole-group deletion" heuristic risk the original design explicitly
  rejected for a different alternative.
- **Independent review spokes converging on the identical finding is a
  strong signal to fix, not merely note.** `code-reviewer` and
  `silent-failure-hunter`, dispatched separately with different framings,
  both flagged the same all-or-nothing gate defect independently — that
  convergence (plus my own re-derivation confirming the concern was real
  and not a misreading) was the basis for reopening a design decision I had
  already gotten explicit user sign-off on, rather than deferring it as an
  optional Should-fix.
- **`gh pr create`'s `Closes #N` keyword closes the issue at the exact merge
  timestamp with no follow-up action needed** — confirmed by fetching the
  issue after merge (`closed_at` matched `mergedAt` to the second,
  `closed_by_pull_requests` correctly referenced the PR). `sync:hub`'s dry
  run correctly reported nothing to close because it was already in sync;
  worth remembering so a dry run showing "Issues to close (0)" isn't read
  as a bug when the real explanation is "already closed by the merge."
- **A docs-only tracker-status flip still needs its own PR** — branch
  protection blocks _any_ direct push to `main`, not just guarded
  `src`/`tests` paths, so even a three-line Status-cell flip across three
  tracker docs needs the full branch → commit → push → PR cycle. Auto-merge
  is the right choice for this class of PR (docs-only, no review round
  expected) rather than waiting for a review verdict that will never
  meaningfully change.
