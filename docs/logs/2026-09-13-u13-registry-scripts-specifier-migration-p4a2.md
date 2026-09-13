# Work log — U13 slice P4a2: last 4 scripts/* + transitional-gate retirement (2026-09-13)

This log covers PR #1223, slice P4a2 of the U13 private-registry-publishing
wave (issue #537) — the follow-up to P4a (PR #1221, logged in
`docs/logs/2026-09-13-u13-registry-scripts-specifier-migration.md`). It
migrates the 4 `scripts/*` packages P4a deferred (`agent-operator`,
`sqs-dead-letter-triage`, `cloudwatch-logs-analysis`, `sqs-etl`) off the
pre-rename `@m3l-automation/m3l-common` workspace alias, retires the
transitional dual-mode acceptance P4a introduced to keep `main` green in the
interim, and records a should-fix-ack round that caught a real (if narrow)
correctness bug.

Plan of record: [`docs/plans/2026-09-12-u13-registry-publish.md`](../plans/2026-09-12-u13-registry-publish.md)

## Summary

Shipped in PR #1223 (squash-merged as `ed0eb3a3`):

- 4 `scripts/*/package.json` manifests migrated to
  `"@monte3l/m3l-common": "workspace:*"`; every corresponding `src/**` and
  `tests/**` import specifier, dynamic `import()`, and `vi.mock()` target
  updated to match. All 17 `scripts/*` packages are now on the direct
  specifier — the alias has no remaining consumers under `scripts/`.
- `bin/check-script-deps.mjs` and `bin/lib/script-scaffold.mjs`: removed the
  transitional dual-mode acceptance (old alias OR new specifier) P4a added —
  both checkers require only the direct specifier again, with the
  `TRANSITIONAL_ALIASED_NAME`/`VALUE` constants and their branches deleted
  entirely, not just disabled.
- `eslint.config.js`: removed the matching transitional allowance from the 3
  `scripts/*`-scoped dynamic-import regex sites and the 1 static
  `no-restricted-imports` regex site.
- Removed the now-obsolete transitional test cases from
  `bin/tests/check-script-deps.test.ts` and `bin/tests/script-scaffold.test.ts`.
- Pre-push review (this session's own `code-reviewer` + `spec-conformance-reviewer`
  pass, before pushing) found 2 Should-fix items, both fixed before the first
  push: 3 stale `@m3l-automation/m3l-common` import examples in
  `docs/guides/writing-a-script.md`, and an `## Update` stanza added to
  `docs/adr/0029-script-dependency-boundary.md` and
  `docs/adr/0022-reintroduce-scripts-workspace.md` recording that the
  enforced dependency name is now `@monte3l/m3l-common`.
- The automated `claude-pr-review.yml` bot's own round (against the pushed
  commit) found one further Should-fix: two stale alias references _inside
  the checkers' own error/doc strings_ — `bin/check-script-deps.mjs`'s
  failure summary and a `bin/lib/script-scaffold.mjs` doc comment still told
  a contributor to depend on the exact shape the checker now rejects. Fixed
  directly, plus the accompanying Nit (inverse-rejection test coverage for
  the full old aliased shape, which the P4a2 test cleanup had removed
  without leaving a replacement).

CI: all required checks passed after the should-fix-ack round —
`Build & typecheck`, `Test`, `Lint (library)`, `Lint (workspace)`,
`Governance gates`, `CodeQL`, `should-fix-ack`, `review`, `verify`. `gh pr
view` confirmed `mergeStateStatus: CLEAN` before merge.

Skills used: `starting-work` (next-slice re-entry per `finishing-work`'s
handoff from PR #1221/#1222), `creating-prs`, `syncing-docs`,
`finishing-work`, `writing-work-logs`.

Spoke incidents: 0 truncations / 0 stalls / 0 resumes — 4 dispatches this
slice (parallel `code-implementer` + `test-author` for the 4-package
src/tests rename, a `test-author` cleanup pass for the two transitional test
files, a `code-reviewer` + `spec-conformance-reviewer` pre-push pair, and a
final `test-author` pass adding the inverse-rejection regression tests),
every one completing cleanly on the first call.

Compaction events: 1 — the prior session compacted between P4a's close-out
(PR #1221/#1222) and this slice's start; the `SessionStart` handoff plus the
landing-plan doc's own P4a2 row carried every needed fact (branch name,
scope, the 4 deferred package names) forward with nothing lost. No
mid-P4a2 compaction occurred.

## What went as planned

- **The 4-package mechanical rename was clean on the first pass**, mirroring
  P4a's own experience: parallel `code-implementer` (src) and `test-author`
  (tests) dispatches each wrote a scoped `String.replaceAll` script against
  an explicit `grep -rl` file list, verified zero remaining old-specifier
  occurrences, and neither touched an unrelated `@m3l-automation/<script-name>`
  self-reference.
- **Retiring the transitional dual-mode gate across all three enforcement
  points (the two `bin/` checkers plus the 4 `eslint.config.js` regex sites)
  was mechanical, not a rediscovery exercise** — P4a's log had already named
  every site and its removal trigger, so this slice's grep-and-delete matched
  the plan exactly with no missed site.
- **This time, neither of P4a's two size ceilings applied.** 172 files /
  133,725 reviewable chars — comfortably under both GitHub's 300-file
  diff-view limit and the 300,000-char hard ceiling — because the 4 deferred
  packages, while individually large, are still far smaller combined than
  the 13-package P4a slice. No mid-flight re-scoping was needed.
- **The `check:review-size` false-pass trap from P4a's log was correctly
  anticipated and avoided this time** — the gate was deliberately re-run
  after the first commit, not just before, per P4a's own recorded insight.
- **`pnpm sync:docs` passed all 15 steps on the first run**, both before and
  after the ADR should-fix edits — no doc-metadata drift beyond the expected
  `docs/adr/provenance.json` re-stamp.

## What didn't go as planned, and why

### 1. Two independent review rounds each found a real Should-fix, at two different layers of the same rename

The pre-push spoke review (this session's own `spec-conformance-reviewer`,
run before the first push) found that `docs/guides/writing-a-script.md`'s
example imports and two ADRs' Decision text still named the pre-rename
alias — a **documentation**-layer staleness. Separately, the automated
`claude-pr-review.yml` bot's round (against the pushed commit) found that
the checkers' own **runtime error strings** told a contributor to depend on
the exact shape the checker had just started rejecting — a
**code**-layer staleness, in files this same diff had already edited.
Neither review pass caught the other's finding: the pre-push spoke reviewed
source/config/docs broadly but did not read every string literal inside the
two `bin/` files closely enough to catch the message text; the bot's round
came after those docs were already fixed, so it only had the code-layer gap
left to find.

**Why it happened:** removing a transitional dual-mode branch touches
several kinds of prose that reference the same stale name — code comments,
JSDoc, error/log strings, and prose docs — and no single review pass is
naturally scoped to check all of them at once. A reviewer focused on logic
correctness (is the dual-mode branch fully removed?) is not naturally primed
to also grep the same file's user-facing strings for the same name.

**Fix for future:** after removing a transitional acceptance branch, run a
dedicated `grep -rn "<old-shape-string>"` across the touched files
specifically for _string literals and comments_, separate from verifying the
logic branch itself — the two are easy to conflate into "I already checked
this file" when only the logic was actually checked.

### 2. A should-fix-ack round on a genuine bug (not just doc staleness) confirms the gate's value beyond formality

Unlike the prior two slices' should-fix-ack rounds (P3, P4a — both
acknowledging fixes that were already correct and complete once made), this
round's finding was substantive: `bin/check-script-deps.mjs`'s failure
message would have actively misled a contributor into re-declaring the exact
dependency the checker rejects, a real "tell someone the wrong fix" bug that
existed for the whole time between this PR's first push and the bot's
review. This is a data point that the gate is not merely bureaucratic
overhead layered onto correct code — it caught something a human skimming a
green CI run would very plausibly have missed.

**Why it happened:** the mechanical rename's own verification (grep for the
old specifier, confirm zero hits) was scoped to import/dependency
_declarations_, not to arbitrary string literals inside the two checker
files being edited in the same diff — the same blind spot as item 1, this
time surfacing in code rather than docs.

**Fix for future:** already covered by item 1's fix — a dedicated string-
literal grep pass, not a new lesson.

## Insights

- **A transitional-gate removal needs a string-literal grep pass, separate
  from verifying the logic branch is gone.** Deleting
  `TRANSITIONAL_ALIASED_NAME`/`VALUE` and the branch that checked them
  proves the _acceptance logic_ is single-shape again; it says nothing about
  whether the same file's error messages, JSDoc, or doc-comments still name
  the old shape as correct. Two independent review passes each found one
  half of this gap in this slice — grep the touched files for the literal
  old-shape string specifically, as its own verification step, whenever a
  transitional branch is removed.

- **should-fix-ack's value is not purely formal — this round caught a
  contributor-facing bug, not just stale prose.** Confirmed across three
  slices now that the footer requirement is durable repo behavior (P3, P4a,
  P4a2 all hit it), but this is the first of the three where the underlying
  finding was a real logic-adjacent defect (a misleading error message)
  rather than pure documentation drift — worth noting since it's easy to
  start treating the gate as a rubber-stamp step once two rounds in a row
  are pure formality.

- **Sizing a follow-up slice against the same ceilings that forced the
  split is worth re-checking, not assuming it will hit them again.** P4a2
  was the "leftover" 4 packages from a ceiling-driven split, but came in at
  172 files / 133,725 chars — nowhere near either of P4a's two ceilings.
  Splitting by package-count alone (4 of 17) doesn't necessarily mean the
  remainder is proportionally sized; measure the actual deferred slice
  rather than assuming it inherits the same risk.

- **A landing-plan row's status should flip in the post-merge close-out PR,
  not mid-flight in the slice's own PR** — confirmed again this slice
  (mirroring P4a → PR #1222's precedent). A same-PR edit to the row's own
  status (e.g. "In review (PR #1223)") was drafted, then reverted before
  pushing, once it was clear the repo's own established pattern defers that
  flip to a dedicated docs-only close-out commit after merge.
