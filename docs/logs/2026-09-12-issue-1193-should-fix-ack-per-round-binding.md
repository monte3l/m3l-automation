# Work log — issue #1193, should-fix-ack per-round binding (2026-09-12)

This log covers investigating and resolving GitHub issue #1193 — a real bug
found while landing PR #1190, filed by the maintainer with two claims about
`check:should-fix-ack`. Both claims were validated (against the code, the
GitHub API, and a direct repro) before any fix was written, then resolved as
two independent PRs per the maintainer's own confirmed decision: PR #1198
(scope a false-Should-fix-producing rule) and PR #1202 (bind each
acknowledgment to the review round that raised it, closing #1193).

Plan of record: `~/.claude/plans/investigate-issue-1193-s-claims-inherited-dijkstra.md`
(plan-mode artifact, not committed to the repo).

## Summary

**Investigation phase** (plan mode): read issue #1193 in full via the GitHub
MCP server, then fanned out three parallel Explore agents — one over
`bin/lib/pr-review-gate.mjs`/`bin/check-should-fix-ack.mjs` and their tests,
one over the `.claude/rules/tests.md`/`check-test-counts.mjs` scoping claim,
one to verify PR #1190's actual review history live via `gh`. All three
claims came back independently corroborated, including by
`docs/logs/2026-09-11-v13-flow-process-group-teardown.md`'s own first-hand
record of the bug firing live. A fourth agent (Plan) then produced a detailed
implementation design once the fix direction was confirmed with the
maintainer via `AskUserQuestion` (4 questions: gate-fix direction, PR split,
context-budget payment strategy, required-check promotion — all four
recommendations accepted).

**PR #1198** — `fix: scope tests.md's Notes-count rule to the library test
tree` (merged, squash `1312a27f`). One-line rule fix + a citation re-point +
an ADR provenance re-stamp. `docs-consistency-reviewer` clean. All CI green,
no Should-fix posted, merged with no review round needed.

**PR #1202** — `fix: bind should-fix-ack acknowledgment to the round that
raised it` (merged, squash `72033380`, closes #1193). Adds
`collectShouldFixRounds`/`planShouldFixAckRanges`/`describeShouldFixAckOutcome`
to `bin/lib/pr-review-gate.mjs` and `classifyReviewedSha`/`evaluateShouldFixAck`
to `bin/check-should-fix-ack.mjs`, replacing the single "loudest comment vs.
whole-PR range" check with a per-round range bound to each round's own
reviewed commit. 109 new/changed tests across two files, both mutation-tested
(the fix's core range-scoping and the same-sha dedup's round-ordinal
preservation). Verified live against real PR #1190 data at two different
heads, reproducing the exact predicted pass/fail sequence. `docs/adr/0097`
gained an `## Update` section recording the disproven design premise.
`code-reviewer` + `docs-consistency-reviewer` returned no Must-fix; one
Should-fix (degraded-round-floor tightening) disputed via commit footer as an
already-documented, deliberate trade-off. `claude-pr-review` on the PR itself
posted 1 Should-fix + 2 nits, correctly triggering the gate's own
just-designed "empty range, fails once" behavior on its own first round —
acknowledged and pushed, second round green, merged.

Skills used: starting-work, creating-prs, syncing-docs, finishing-work,
writing-work-logs (this log).

Spoke incidents: 1 truncation / 0 stalls / 1 resume (the first `test-author`
dispatch hit its 40-turn limit mid-mutation-test with a temporary mutation
left uncommitted in the working tree; resumed via a fresh `Agent` dispatch
with explicit state-recovery instructions rather than `SendMessage`, since
the prior agent's identity/context wasn't retained across the notification —
worth noting as a process gap, see Insights).

Compaction events: none.

## What went as planned

- **The three-agent parallel investigation converged cleanly.** All three
  Explore agents (gate internals, rules-scoping claim, PR #1190 live
  verification) returned independently corroborating evidence with no
  contradictions, and a fourth check against `docs/logs/2026-09-11-v13-flow-process-group-teardown.md`
  found the exact bug already documented first-hand by the session that hit
  it — issue #1193 wasn't speculative from the start.
- **The `AskUserQuestion` round for the four open design decisions was
  answered in one pass**, with no follow-up clarification needed before
  planning could finalize.
- **The Plan agent's design caught two things the hub's own initial plan had
  missed** before any code was written: the empty-range forced consequence
  (a round that just posted a finding always fails its own CI run once) and
  two now-false JSDoc claims on `selectShouldFixComment` beyond the ones the
  issue itself named. Both were confirmed with the maintainer and folded into
  the final design before implementation started.
- **PR #1198's gates were entirely clean** — no Should-fix, no review round,
  merged on the first push.
- **Both mutation tests on PR #1202 caught real regressions on the first
  try** — reverting the range-scoping fix flipped 6/108 tests including the
  exact PR #1190/#1193 fixture, and reverting the round-ordinal fix flipped
  its dedicated regression test. Neither mutation needed a second attempt to
  discriminate correctly.
- **The live replay against real PR #1190 data matched the predicted output
  exactly** — including a genuine surprise mid-replay (a short-form vs.
  full-length SHA mismatch in a hand-typed CLI argument) that turned out to
  be a testing artifact, not a real bug, confirmed by checking the actual
  workflow YAML's SHA format before assuming otherwise.
- **`should-fix-ack` firing on PR #1202 itself, and clearing on the very next
  push, was the acceptance test this PR's own design promised** — the
  empty-range behavior fired exactly once, on exactly the round that posted
  the finding, and passed the moment the acknowledgment commit landed.

## What didn't go as planned, and why

### 1. A guarded-path write (`bin/tests/*.test.ts`) attempted directly by the hub

The first attempt to add imports and test blocks to
`bin/tests/pr-review-gate.test.ts` was blocked by `guard-hub-src-writes.mjs`
— `isProtectedPath` matches any path containing a `tests/` segment,
including `bin/tests/`, not just `packages/*/src`/`scripts/*/src` as the
project's prose description of the hub-and-spoke model might suggest at a
glance. All test-file writes for this task had to be dispatched to
`test-author`, even though the work was `bin/` tooling rather than a library
submodule or consumer script.

**Why it happened:** The hub read the Agent Operating Model's prose
("`packages/*/src`, `scripts/*/src/**`, and `**/tests/**`") but underestimated
how broadly the third clause reaches — any `tests/` directory anywhere in the
repo, including `bin/tests/`, is guarded, with no carve-out for non-library
tooling tests.

**Fix for future:** Before editing any `*.test.ts` file directly as the hub,
check `bin/lib/protected-paths.mjs`'s `isProtectedPath` regex rather than
inferring guardedness from the file's subject matter — `bin/lib/*.mjs`
implementation files are unguarded (confirmed empirically: two direct hub
edits succeeded there with no hook error), but `bin/tests/*.test.ts` is not.

### 2. A dispatched `test-author` agent stopped at its 40-turn limit mid-mutation-test

The first `test-author` dispatch (writing tests for
`collectShouldFixRounds`/`planShouldFixAckRanges`/`describeShouldFixAckOutcome`/
`evaluateShouldFixAck`) hit its turn limit while executing the requested
mutation-test step, leaving a `// TEMP MUTATION` comment and an altered
`planShouldFixAckRanges` uncommitted in the working tree. The hub caught this
by grepping for the mutation marker after the notification arrived (not from
the agent's own partial report, which ended mid-sentence) and dispatched a
fresh `test-author` agent with explicit instructions to finish the
verification and revert the exact line.

**Why it happened:** The task (four new test suites plus two full mutation
tests with revert-and-reverify) was large enough to exceed one dispatch's
turn budget, and the truncation happened at the single worst point in the
sequence — mid-mutation, before the revert.

**Fix for future:** When dispatching a spoke task that ends in a
temporary/revertable mutation step, grep for the mutation's marker
immediately after the dispatch returns — regardless of whether the agent's
own final message claims completion — before trusting the working tree is
clean. For a task this size, consider splitting "write the tests" and "run
the mutation test" into two separate dispatches so a turn-limit truncation
can only ever land between them, never inside the revert.

### 3. A live CLI probe used a short-form SHA where production always uses full-length

The first live replay of `check-should-fix-ack.mjs` against real PR #1190
data used a hand-typed 7-character `--head` value, which caused the new
empty-range detection (`from === to` as a string comparison) to miss the
match — round 1's reviewed sha (parsed from the bot comment's marker, always
full-length) didn't string-equal the abbreviated `--head`. The output looked
like a real bug (wrong message variant selected) until the workflow YAML was
checked and confirmed `github.event.pull_request.head.sha` is always full
40-character, both for the marker and for `--head` in the real wiring — so
the mismatch was a manual-invocation artifact, not a production defect.
Re-running with the full-length sha reproduced the exact predicted output.

**Why it happened:** Convenience — typing a short sha by hand for a manual
CLI invocation, without first confirming what length the actual CI wiring
uses for the same value.

**Fix for future:** Before treating an unexpected CLI output as a bug, check
the actual production call site's argument format (here, `grep` the workflow
YAML for the env var in question) rather than assuming a hand-typed
convenience value matches what CI will really pass.

## Insights

- **A repo's own path-scoped guard regex is the authority on "guarded," not
  its README prose.** `guard-hub-src-writes.mjs`'s `isProtectedPath` matches
  ANY `tests/` segment, which is broader than "library/consumer-script test
  code" — `bin/tests/**` is guarded too, even though it's tooling rather than
  a submodule. Read the actual regex before assuming a file category is safe
  for the hub to edit directly.
- **A dispatched agent's own final message is not proof its instructed
  cleanup step ran to completion.** A truncated agent can stop mid-sentence
  with no error, leaving a half-finished revert in the working tree; grep for
  the specific artifact (a marker comment, a `git status --porcelain`) the
  task was supposed to leave clean, every time a dispatch involves a
  temporary/revertable step, regardless of what the agent's summary claims.
- **Verify a hand-typed CLI argument against the real call site's format
  before trusting a live-replay result that looks wrong.** A short-vs-full
  SHA mismatch in a manual invocation produced output that looked like a
  genuine empty-range-detection bug; the workflow YAML (`grep` for the env
  var) settled it in one command. The fix for an unexpected result from a
  manual repro is often "check what production actually passes here," not
  "assume the code is wrong."
- **A design premise a live regression disproves is worth a dedicated
  `## Update` section on the original ADR, not a silent rewrite.** ADR-0097's
  Decision text ("no later round ever posts more than the first did") stayed
  exactly as originally written; the Update section records what was
  observed, why it changed the design, and what the new design's own accepted
  trade-offs are — preserving the historical record of what was believed at
  design time while keeping the document accurate about current behavior.
- **A merge-gate fix's own PR is the best acceptance test the fix will ever
  get.** PR #1202's `should-fix-ack` job failing once on its own first review
  round (the exact "empty range" case its own design predicts) and clearing
  on the acknowledgment push was a live, unscripted confirmation of the
  forced-consequence behavior that no local replay against historical data
  could provide — the gate proved its own new failure mode by triggering it
  on the PR that shipped it.
