# Work log — `pnpm-pin-gate` (2026-09-11)

This log covers PR #1182 (`feat/pnpm-pin-gate` → `main`, squash-merged
2026-09-11), the first of a planned 3-PR sequence closing out a drift the
repo had carried silently for over a year: `package.json`'s `packageManager`
field, pinning pnpm, had never changed since the initial commit while
upstream pnpm moved from 11.9.0 to 12.4.1 with nothing noticing. This PR adds
the consistency half of the fix — a new blocking gate asserting the pin
agrees with itself across every site that reads it — landed deliberately
before the pnpm 12 version bump (PR 2) so the bump is protected by a gate
already proven to work. It records what shipped, a design-review disagreement
that changed the plan before any code was written, an automated-review round
that caught two real bugs, a regression introduced while fixing one of them,
and the insights worth carrying into PR 2 and PR 3.

Plan of record: `/home/enri3l/.claude/plans/inherited-prancing-dove.md`
(session-local Claude Code plan file, not committed to the repo).

## Summary

- Added `bin/check-pnpm-version.mjs` — the same-shape sibling of
  `bin/check-claude-cli-version.mjs` (one gate per pin subject, not a
  toolchain mega-gate) — asserting: `packageManager` pins pnpm at an exact
  version (not a range/tag), both `packages/*/Containerfile`'s hardcoded
  `npm install --global pnpm@X` sites agree with it exactly, no
  `pnpm/action-setup` step overrides it with an explicit `version:` input,
  and at least one site actually reads the pin. Fully offline by design —
  staleness against pnpm's real upstream latest is left to a follow-up
  warn-only probe in `check:deps` (PR 3), not this gate.
- Wired into `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs` +
  `.github/workflows/ci.yml` (new "Check pnpm version pin" step),
  `lefthook.yml`'s chained pre-push lane, `bin/bench-gates.mjs`, and
  `CLAUDE.md`'s Commands table.
- Landed in two commits: the initial gate (6711905d) and a fix-round
  (eb579670) responding to `claude-pr-review`'s FAIL verdict.
- Final state: 41 tests in `bin/tests/check-pnpm-version.test.ts` (33 in the
  initial commit, +8 in the fix round), `pnpm typecheck` clean, `pnpm verify`
  73 passed / 10 skipped (push-only/e2e), `docs-consistency-reviewer` and a
  bounded `code-reviewer` re-review both PASS with no findings.
- CI: `verify`, `CodeQL`, `Dependency Review` (the three branch-protection
  required checks) all passed; `review` (claude-pr-review) went FAIL → fix →
  PASS; `should-fix-ack` passed on the fix-round commit's acknowledgment
  footer.
- Skills used: `starting-work`, `creating-prs`, `syncing-docs` (invoked
  twice — pre-push and post-fix-round), `resolving-pr-comments`,
  `finishing-work`, `writing-work-logs`.
- Spoke incidents: 1 truncation (from `tmp/session-incidents.jsonl`; not
  confidently attributable to a specific dispatched agent in this session —
  recorded per the file's mechanical count regardless) / 0 stalls / 1 resume
  (a `code-reviewer` bounded re-review dispatch after the fix round).
- Compaction events: none.

## What went as planned

- **The gate's core design held up under review with zero Must-fix on the
  design itself.** The decision to model it on `check-claude-cli-version.mjs`
  (one gate per pin subject) rather than extending `check-node-version.mjs`
  (zero new wiring, but wrong ownership) was never challenged by the
  automated review — only two specific logic gaps and one testing gap were
  flagged, not the shape of the solution.
- **Live-running the gate before writing tests caught nothing surprising the
  first time**, unlike the harness-artifacts.md rule's usual war stories —
  the gate passed cleanly against the real repo on first run, and three
  deliberate negative smoke tests (mismatched Containerfile, a range pin, an
  explicit `version:` override) all failed with the expected message before
  any test file existed.
- **The full `pnpm verify` pipeline (73 steps) passed clean on both rounds**
  once formatting was applied — the only failures either time were
  `Format check`, both times traced immediately to an unformatted edit to
  `bin/check-pnpm-version.mjs` and fixed with one `prettier --write`.
- **`syncing-docs`' composite `pnpm sync:docs` needed zero manual
  intervention** across both invocations — the second run correctly found no
  working-tree diff at all (the reference index and ADR provenance were
  already current from the first sync), confirming the mechanism is
  idempotent rather than re-churning on every invocation.

## What didn't go as planned, and why

### 1. A design-review agent overrode two already-settled plan decisions, and both flipped after re-asking the user

Before implementation began, I ran a `Plan`-agent design review of the
approved plan sketch. It flagged two of my `AskUserQuestion`-confirmed
choices as wrong: the freshness-tracker mechanism (I'd chosen an ADR-0082
tracker file; it argued a tracker only catches a manual sweep going
stale — the actual failure was that nobody was sweeping at all — and
recommended a ~10-line warn-only probe folded into the already-network-
touching `check:deps` instead) and the PR ordering (I'd chosen bump-then-gate;
it argued gate-then-bump so the bump PR is protected by a gate already proven
green). I re-surfaced both as a fresh `AskUserQuestion` rather than either
silently keeping my original choice or silently adopting the agent's — the
user picked the agent's recommendation both times.

**Why it happened:** A design review dispatched after user confirmation is
still worth running when the confirmed choices were made from an initial
plan sketch, not a fully fleshed design — the review agent had more complete
information (e.g., that `check:deps` was already network-touching and
already wired into `verify-steps`, which materially changes the "cost" side
of the tracker-vs-probe tradeoff) than was available at the time of the
original question.

**Fix for future:** When a user has confirmed a plan-sketch-level decision,
don't treat a subsequent design-review disagreement as something to resolve
unilaterally in either direction — re-ask, since the review agent's
additional research is new information for the user too, not a re-litigation
of a settled point.

### 2. `claude-pr-review` caught a testing gap and two real logic bugs the pre-push review round missed

The pre-push `docs-consistency-reviewer` pass (correctly dispatched, since
the diff touched no `packages/*/src` or `scripts/*/src` files) found nothing
wrong — it isn't scoped to judge new gate logic. The post-push automated
review then posted FAIL: a Must-fix (two filesystem-discovery functions,
`collectContainerfiles` and `collectGithubPnpmSetupFiles`, had zero tests —
flagged as dangerous because a silent miss there makes the whole gate
vacuously pass) and two Should-fix (a YAML-parsing heuristic only recognized
one step-authoring style, missing exactly the override case the gate exists
to catch; a count included a site that itself didn't satisfy the property
being counted). All three were real, not false positives.

**Why it happened:** The pre-push review step's own branching logic (fan out
`code-reviewer`+`spec-conformance-reviewer` only when `packages/*/src` or
`scripts/*/src` changed; `docs-consistency-reviewer` otherwise) has no
category for "new `bin/**` tooling logic" — it isn't m3l-common library code,
so it fell to the docs bucket by the skill's literal branching, even though
the change was substantial new logic, not docs metadata.

**Fix for future:** `creating-prs`' pre-push review branching should treat a
new `bin/**` gate with exported logic functions (not just a doc/config edit)
as warranting `code-reviewer`, not only `docs-consistency-reviewer`, even
though it sits outside `packages/*/src` and `scripts/*/src`. This is a
candidate rule promotion — see Insights.

### 3. A follow-up edit to fix one Should-fix bug silently broke a different, already-correct code path

While rewriting `scanWorkflowPnpmSetup` to group lines into step blocks
(fixing the name-first-form bug), the new block-detection regex
(`/(?:^|\n)\s*uses:\s*pnpm\/action-setup@/`) didn't account for the
dash-shared form (`- uses: pnpm/action-setup@...`) that every real call site
in this repo actually uses — the leading `-` sits between the whitespace and
`uses:`, which the regex didn't allow for. Running the gate live against the
repo immediately after the edit (before dispatching to `test-author`) showed
`actionSetupCount` had dropped from 3 to 0, catching the regression before
any test was written to lock in the wrong behavior.

**Why it happened:** Fixing a heuristic to handle a previously-unhandled
case (name-first) without first re-running it against the cases it already
handled correctly (dash-shared) — the two forms share a detection regex, and
tightening/rewriting that regex for one form's sake silently narrowed it for
the other.

**Fix for future:** After any edit to a matching heuristic meant to widen its
coverage, live-run it against the full known-good corpus immediately — not
just the new case being added — before handing off to test-author. This
generalizes the `harness-artifacts.md` "run live before writing tests" rule
to also cover "run live again after any further edit to the same matcher,"
which the rule doesn't currently say explicitly.

## Insights

- **A confirmed plan-sketch decision is not immune to a later design
  review's disagreement — re-ask, don't silently pick a side.** When a
  design-review agent has more complete information than was available when
  the user first confirmed a choice (e.g., a sibling mechanism's actual
  wiring cost), treat its pushback as new information for the user, not
  noise to resolve unilaterally in either direction.
- **A new `bin/**` gate with real logic (not just config/docs) belongs in
  `code-reviewer`'s pre-push review lane, even when it sits outside
  `packages/*/src` and `scripts/*/src`.** `docs-consistency-reviewer` is not
  equipped to judge new heuristic-matching logic; only the post-push
  automated review caught the two real bugs here, one push cycle later than
  necessary.
- **Re-run a matching heuristic against its full known-good corpus after any
  edit meant only to widen it, not just against the new case.** A regex or
  heuristic rewrite aimed at adding coverage for one shape can silently
  narrow coverage for a different shape it already handled — a
  live-run-before-tests check on only the new case would have missed this;
  the live run needs to cover everything the heuristic previously handled
  correctly too.
- **A "read with no override" count must literally exclude the overridden
  sites, or the success message becomes false on partial failure.** The
  overcounting bug wasn't just an off-by-N — a mixed case (one clean site,
  one overridden site) would have printed "N sites read it with no override"
  where N included the overridden one, actively misreporting the very
  property the message claims to state. Any "N of M satisfy property P"
  count should be constructed as an actual filter over P, not a raw tally
  with a separate deduction bolted on elsewhere.
- **Squash-merge branch cleanup routinely shows the branch as "not merged
  into its base" — this is expected, not a signal to investigate.**
  `git log <branch> ^origin/main` after a squash merge lists every commit on
  the branch as unlanded by ancestry, since squash never makes the source
  branch's commits ancestors of `main`. Verify the _content_ landed (e.g.
  `git show origin/main:<file>` for a file the branch added) rather than
  treating the ancestry check's non-empty result as abandoned work.

## Promotion note

The pre-push review-branching gap (item 2 / insight 2 above) generalizes
beyond this task and is a good candidate for `creating-prs/SKILL.md`'s Step 7
branching table, but I did not fold it in as part of this change set —
`creating-prs` is shared infrastructure used by every PR in this repo, and a
change to its review-dispatch branching deserves its own reviewed PR rather
than a same-change-set edit bundled with an unrelated gate. Flagging here for
`/promoting-work-log-insights` to pick up, since it hasn't recurred across
multiple logs yet (single-log observation, per that skill's own bar for
promoting a borderline case).
