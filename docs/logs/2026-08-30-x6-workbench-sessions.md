# Work log — X6 workbench-sessions close-out (2026-08-30)

This log covers closing out issue #554 (X6 — workbench sessions module,
ADR-0068). X6 had already shipped four slices (#737, #738, #740, #743) as
"slice 4 of 5" — this session ran the fifth slice: a code PR (#746) closing
two contracts ADR-0068 required but the prior slices left incomplete, and a
docs-only close-out PR flipping the tracker and archiving the issue.

Plan of record: [`on-issue-554-the-elegant-scone.md`](https://claude.ai/code)
(local plan file; not committed to the repo).

## Summary

X6 shipped as five PRs total: store schema + repository (PR 737), addressable references + typed bindings (PR 738), capped artifact storage (PR 740), session service + REST routes + `main.ts` wiring (PR 743), and this session's close-out code (PR 746). Verifying issue 554's claims against the shipped source before starting found four of six ADR-0068 capabilities complete (session model, reference grammar, decision points, capped artifact storage) and two only partial: bindings resolved by `addStep` were never persisted as session records (the repository's `insertBinding`/`listBindingsForSession` existed with zero production callers), and `reopenSession` existed in the store and service but had no REST route.

PR #746 closed both gaps: `sessions/service.ts`'s `addStep` now persists
each resolved binding immediately after that binding's own resolution
succeeds (a new `resolveAndPersistBindings` helper); `POST
/api/v1/sessions/:id/reopen` and `GET /api/v1/sessions/:id/bindings` were
added to the nine-route REST surface (up from seven). A byte-budget-driven
extraction split `resolveBindingValue` out of `service.ts` into a new
`sessions/launch-parameters.ts`, freeing headroom under the 25,000-byte
per-file cap. A new `tests/integration/sessions-walk.integration.test.ts`
drives the full ADR-0068 walk — create → step → binding (incl.
multi-select) → decision → close → reopen through a genuinely fresh store
connection → a pre-close binding still resolves — against real
collaborators.

Four independent review passes ran against #746's diff before push:
`code-reviewer`, `type-design-analyzer`, `silent-failure-hunter`, and
`spec-conformance-reviewer` (conformance mode against ADR-0068). Two
Must-fix findings were confirmed independently by two reviewers each (a
missing 404 on the bindings route; the open-session cap not being enforced
on `reopenSession`) and fixed before push, along with a dead exported
function and a weak integration-test durability claim. After push, the
`claude-pr-review` CI bot found one more genuine bug none of the four manual
passes had caught: `reopenSession`'s cap check ran unconditionally, so an
already-open session at capacity (which counts itself against the cap)
wrongly threw `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` instead of returning
`false`, contradicting its own documented contract. Fixed in a follow-up
commit, verified, and the bot's FAIL flipped to PASS on re-review.

Deliberately NOT fixed: a step whose launch fails after its bindings
already resolved and persisted (e.g. `ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED`)
leaves those bindings' audit records in place; a client retry with the same
bindings persists new records rather than reusing the originals. No data is
lost or corrupted — this is non-deduplicated audit noise — but closing it
needs either a store migration (a `stepId` linkage column doesn't exist) or
a rollback capability this layer doesn't have, and would conflict with the
already-tested "persist what was actually resolved" contract. Documented as
a known limitation in `docs/reference/console.md` and the ADR-0068 Update
instead.

Final gates on #746: 1749 unit tests + 31 integration tests passing, zero
regressions; `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm
build` all green; `check:review-size` at 52,904 chars (well under the
75,000 soft target); no open error-severity CodeQL alert touching any
changed file. PR #746 merged via squash auto-merge.

Skills used: starting-work (via plan-mode's own decision gate, effectively),
creating-prs, syncing-docs, resolving-pr-comments, writing-work-logs.

Spoke incidents: 2 truncations (the initial RED test-author pass and the
initial GREEN code-implementer pass on PR #746 both hit the 40-turn limit
and were resumed via `SendMessage`) / 0 stalls / 2 resumes.

## What went as planned

- **The byte-budget refactor was a clean, behavior-preserving move.** The
  first code-implementer pass extracted `resolveBindingValue`/
  `resolveLaunchParameters` into `launch-parameters.ts` with zero test-file
  changes and the full existing suite green on the first attempt.
- **The core RED/GREEN loop for binding persistence and the reopen route
  landed correctly on the first GREEN pass** — 1745/1745 unit tests and
  31/31 integration tests green, all requested gates clean, no back-and-forth
  needed between test-author and code-implementer on the primary feature
  work.
- **The review fan-out found real, distinct issues** — three reviewers
  running in parallel over the same diff independently converged on the same
  missing-404 defect from different angles (a general-quality read, a
  silent-failure read), which is exactly the redundancy the four-reviewer
  pattern is for.
- **The strengthened integration test passed on the first attempt** —
  proving the store layer was already genuinely durable across a fresh
  connection, not just in-memory continuity; the test-author's rewrite
  surfaced no missing behavior, only a stronger proof of existing behavior.
- **Doc reconciliation (`pnpm sync:docs`) required zero manual fixes** on
  both PRs — all 13 steps passed cleanly each time, including after the
  conformance-review fixup commit.

## What didn't go as planned, and why

### 1. Two writer/test-author subagents hit the 40-turn limit mid-task

The first `test-author` dispatch (RED tests for binding persistence + the
reopen route) and the first `code-implementer` dispatch (the matching GREEN
implementation) both stopped at their 40-turn limit with partial results —
in both cases with the core work essentially done and only final
verification steps (loading the new integration test, running the build/gate
commands) left unfinished. Both were resumed via `SendMessage` naming the
exact remaining checklist items, and both finished cleanly on the resume.

**Why it happened:** The combined scope handed to each agent in a single
dispatch — new service logic, new route handlers, fixture maintenance across
five-plus test files, plus a from-scratch integration test — was large
enough that the agent's own thorough verification loop (typecheck, full
unit run, full integration run, lint, multiple `check:*` gates) consumed
most of the turn budget before it reached the final report.

**Fix for future:** When a single TDD dispatch spans both new production
logic and a new integration test exercising real collaborators, expect it to
approach the turn limit and either split the integration test into its own
follow-up dispatch, or explicitly tell the agent in the prompt to prioritize
finishing the checklist over exploring alternative approaches, so a resume
(if needed) only has to close out a short, well-defined tail rather than
re-establish context.

### 2. Four manual review passes missed a bug the CI bot review caught

`code-reviewer`, `type-design-analyzer`, `silent-failure-hunter`, and
`spec-conformance-reviewer` all reviewed #746's diff before push. None of
the four flagged that `reopenSession`'s newly added open-session-cap check
ran unconditionally — including for a session that was already open, which
the cap check itself counts against the limit — so an already-open session
at capacity would wrongly throw `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` instead
of returning `false` per its own documented contract. `claude-pr-review`
(the CI bot, running against the pushed diff) caught it on the first pass.

**Why it happened:** The bug was introduced in a small follow-up fixup
(adding the cap check to `reopenSession` to fix an unrelated conformance
finding — "reopen bypasses the cap entirely") that landed after the four
manual reviews had already run against the diff. The fixup was verified by
gates (typecheck/lint/test/build) but not re-reviewed by the same four-pass
fan-out, because it looked like a small, obviously-correct mirror of
`createSession`'s existing check.

**Fix for future:** A "small, obviously correct" fixup added after the main
review round still needs at minimum a re-read against the specific contract
it touches (here: "what does `reopenSession`'s own TSDoc promise for an
already-open session?") — mirroring an existing pattern (`createSession`'s
cap check) without checking whether the mirrored context is actually
equivalent (a _new_ session is never already-open; a _reopened_ session
might be) is exactly the kind of narrow logic bug a fast, targeted CI bot
pass is well suited to catch even after thorough manual review. Treat a
CI-bot FAIL as a genuine independent signal, not a formality to clear.

## Lessons learned

- **A CI review bot is a genuine independent check, not a formality, even
  after four manual review passes already ran.** The `reopenSession`
  cap-check bug shipped past `code-reviewer`, `type-design-analyzer`,
  `silent-failure-hunter`, and `spec-conformance-reviewer` and was caught
  only by `claude-pr-review` on the pushed diff — because it was introduced
  in a late, small fixup after the manual round had already completed. Never
  skip or rush past a bot FAIL as noise.
- **A "mirror an existing check" fixup needs its own contract check, not
  just a structural copy.** `reopenSession`'s cap check was written as a
  literal copy of `createSession`'s, but the two methods have different
  "already in the target state" semantics (a fresh session is never
  already-open; a reopened one might be) — copying the check without
  re-deriving what it should mean for THIS method's documented contract
  introduced the bug.
- **A byte-budget extraction done ahead of the feature it enables keeps the
  feature diff small and the refactor reviewable on its own terms.**
  Extracting `launch-parameters.ts` before adding binding persistence to
  `service.ts` meant the persistence change itself stayed a clean,
  reviewable diff instead of being tangled with a simultaneous file-budget
  fire drill.
- **Document a known limitation instead of fixing it when the fix needs
  infrastructure the layer doesn't have.** The duplicate-binding-on-retry
  gap is real but its correct fix (a `stepId` linkage column, or a
  rollback/transaction capability) is a bigger change than the slice's
  scope — writing it down precisely (in the ADR Update and the contract
  page's Known limits) is more valuable than either silently shipping it or
  scope-creeping the PR to fix it.
- **Large TDD dispatches spanning new logic plus a from-scratch integration
  test should budget for a 40-turn-limit resume.** Both writer-side
  dispatches in this session hit the limit with the core work done and only
  final verification incomplete — a resume message naming the exact
  remaining checklist closed them out cleanly both times, so this is a
  budgeting note rather than a dispatch-quality problem.
