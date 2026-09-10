# Work log — main-health.yml Skill Evals coverage (2026-09-10)

This log covers P4 of issue #1087's 4-PR remediation plan — the final slice.
P1 (PR #1161), P2 (PR #1165), and P3 (PR #1170) had already fixed the
skill-eval corpus's routing debt and raised `MIN_PASS_RATE`; this task closed
the plan's separate, independent gap: `main-health.yml` never watched
`skill-evals.yml`, so a red scheduled or dispatched skill-evals run on `main`
opened no tracking issue. Landed as PR #1173.

Plan of record: [`docs/plans/2026-09-10-skill-eval-routing-debt.md`](../plans/2026-09-10-skill-eval-routing-debt.md)

## Summary

- Added `Skill Evals` to `.github/workflows/main-health.yml`'s
  `workflow_run.workflows` list, and widened the job's `if:` to accept
  `schedule`/`workflow_dispatch` in addition to `push` — Skill Evals never
  runs on `push` at all (only `pull_request`, weekly `schedule`, and manual
  `workflow_dispatch`). The `head_repository.full_name == github.repository`
  check still closes the trust boundary for every accepted event type, since
  neither `schedule` nor `workflow_dispatch` is reachable from a fork PR the
  way `pull_request` is.
- `bin/lib/main-health.mjs` generalized from an "exactly one other watched
  workflow" model (`WATCHED_WORKFLOWS = ["CI", "Pages"]`,
  `otherWatchedWorkflow` returning a single string) to an N-workflow model:
  `WATCHED_WORKFLOWS` now has three entries, `otherWatchedWorkflows` (plural)
  returns every other watched workflow, and `decideSuccessAction`/
  `buildPartialResolutionComment` take/report an array — the tracking issue
  only closes once **every** other watched workflow is green.
- `bin/notify-main-health.mjs` updated to query every other workflow's
  latest conclusion (previously just one) before deciding whether to close.
- `bin/tests/main-health.test.ts` (a guarded path — dispatched to a
  `test-author` spoke rather than edited directly): rewritten for the
  array-based API, 39 tests up from 32, all passing on the first attempt —
  no truncation or re-dispatch needed.
- `docs/contributing/ci-cd.md`, `docs/decision-notes/0004-skill-eval-pass-rate-floor.md`,
  `bin/lib/command-catalog.mjs`: updated to reflect the closed gap; no doc
  was left asserting the old two-workflow model.
- `pnpm verify`: 72/72 passed, run twice (once before, once after the
  pre-push review's fixes) — both clean.
- Pre-push review: dispatched `code-reviewer` (0 Must-fix, 2 Should-fix —
  both applied: documented the `workflow_dispatch` trust-surface widening in
  a code comment, fixed a singular/plural verb-agreement gap in
  `notify-main-health.mjs`'s CLI log line) and `docs-consistency-reviewer`
  (1 Must-fix — a stale comment describing the old "CI and Pages both run on
  every push" concurrency-group rationale, no longer true for Skill Evals;
  1 should-flag — a stale decision-note sentence, fixed since decision notes
  aren't immutable the way `docs/logs/` is). Both spokes' findings were
  folded into the pre-push commit via amend.
- PR #1173: `claude-pr-review.yml` verdict **PASS**, 0 Must-fix, 1 Should-fix,
  3 Nits. The Should-fix (`otherWorkflowLatestConclusion` relying on Skill
  Evals' latest `main` run, which can be stale for up to 7 days after a fix
  merges since Skill Evals only gets a `main` run from its cron/manual
  dispatch) needed a genuine design decision, not a targeted line fix — left
  unaddressed and acknowledged via an empty commit carrying
  `Acknowledged-Should-Fix:`, per `resolving-pr-comments`' boundary rules.
  All 3 Nits left untouched (none fell inside a region another fix touched).
- Merged as `98625784c9eceb5348b7808ae4605533d8ad5543`.
- Skills used: `starting-work` (worktree/branch setup, both for the main PR
  and this status-flip follow-up), `creating-prs`, `resolving-pr-comments`,
  `writing-commits`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: none (2 spokes dispatched pre-push — `code-reviewer`,
  `docs-consistency-reviewer` — plus 1 `test-author`; all three completed
  cleanly, no truncation, stall, or resume).
- Compaction events: 1 compaction / 1 recovered via handoff (this session
  continued from a compacted summary of the P1-P3 work; no figure or
  decision from that summary was lost or contradicted during P4).

## What went as planned

- **The N-workflow generalization held up under independent review** — the
  `otherWatchedWorkflows` validation, the `every()`-based close decision, and
  the widened trust-boundary `if:` all passed `code-reviewer`'s scrutiny with
  zero Must-fix findings; the reviewer explicitly checked the duplicate-name
  edge case in `WATCHED_WORKFLOWS` and confirmed the validation catches it.
- **The dispatched `test-author` spoke needed no back-and-forth** — it wrote
  39 tests (up from 32) covering the array API's edge cases (empty array,
  "one red among otherwise green," singular/plural comment wording) on the
  first attempt, all green.
- **Both pre-push review spokes ran in parallel and returned independent,
  non-overlapping findings** — `docs-consistency-reviewer` caught a stale
  prose comment `code-reviewer` wasn't scoped to look at, and vice versa,
  confirming the value of dispatching both rather than picking one.

## What didn't go as planned, and why

### 1. A concurrency-group comment written for exactly two workflows silently went stale

`.github/workflows/main-health.yml`'s comment above its `concurrency:` block
said "CI and Pages both run on every push to main" to explain why duplicate
`workflow_run` events need deduplication. That sentence is still true for CI
and Pages, but became incomplete the moment Skill Evals joined the watched
set — Skill Evals never runs on `push`, so the comment's own trigger
condition no longer covers every workflow it's explaining the concurrency
group for. `docs-consistency-reviewer` caught it as a Must-fix; fixed before
pushing.

**Why it happened:** The comment was written against a fixed cardinality
(exactly two), the same way `otherWatchedWorkflow`'s code was — but only the
code got the N-generalization treatment during editing; the prose comment a
few lines above it was not in the diff's direct blast radius and so wasn't
re-read for staleness.

**Fix for future:** When a fixed-cardinality assumption embedded in code
(`WATCHED_WORKFLOWS.length === 2`) is generalized, grep the same file for
every comment stating the assumption in prose too — not just the lines the
diff directly touches. This is the same class of bug this session's own P3
divergence #2 named (a comparison phrased in prose is a hidden dependency on
the thing it's judging) recurring one PR later, in a different file.

### 2. A genuine operational trade-off surfaced only by the post-push bot review, not the pre-push spokes

`claude-pr-review.yml`'s Should-fix finding — that `Skill Evals`' latest
`main` run can go stale for up to 7 days, keeping the tracking issue open
after a fix that only ever runs on `pull_request` — was not caught by either
pre-push review spoke (`code-reviewer` or `docs-consistency-reviewer`).
Neither was asked to reason about the specific interaction between
`skill-evals.yml`'s trigger set and `otherWorkflowLatestConclusion`'s
"latest run on `main`" query; that requires cross-referencing two separate
workflow files' `on:` blocks against the runtime semantics of a third
script, which sits between "code correctness" and "docs consistency" and so
fell in neither spoke's remit.

**Why it happened:** The pre-push review dispatch rule in `creating-prs`
(code-reviewer + docs-consistency-reviewer for a diff with no `packages/*/src`
files) is a good default, but doesn't cover an operational/runtime interaction
finding that needs reading a workflow file the diff didn't touch
(`skill-evals.yml`) alongside the one it did.

**Fix for future:** Not a process fix so much as a confirmed instance of
`resolving-pr-comments`'s design working as intended — the post-push bot
review is a genuinely different reviewer reading a different (broader)
context, not a redundant re-check. The Should-fix was correctly triaged as
"needs a design decision, not a targeted line fix" and left for a human via
the `Acknowledged-Should-Fix:` footer, exactly per the skill's boundary
rules — no different handling needed, just confirmation the two-phase review
model caught something a single pre-push pass would have missed.

## Insights

- **A fixed-cardinality assumption's prose restatement needs the same
  re-grep as its code.** Generalizing `WATCHED_WORKFLOWS` from 2 to 3 entries
  required updating every place the number "2" (or "one other") was load-bearing
  in code, but a concurrency-group comment describing the same assumption in
  prose was missed until an independent reviewer caught it — grep for the old
  cardinality's _natural-language_ description ("both run", "either", "the
  other"), not just its numeral or variable-name citations.
- **The post-push bot review earning its keep is itself a durable signal,
  not just a one-off catch.** This session's Should-fix (main-run staleness
  keeping a tracking issue open past a fix) required synthesizing two
  workflow files' trigger sets against a script's runtime query — exactly
  the kind of cross-file, semantically-deep finding neither pre-push spoke
  was scoped to make. Confirms `creating-prs`' own framing that pre-push and
  post-push review are sequential phases of one pipeline, not redundant
  passes.
- **A generalization from N=2 to N=3 is a good forcing function for finding
  every place a "the other one" assumption was implicit rather than
  explicit** — `otherWatchedWorkflow`'s singular return type, the concurrency
  comment's "both," and the CLI log message's un-pluralized join all
  surfaced from the same underlying change, three different ways.
