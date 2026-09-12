# Work log — U13 slice P4a: scripts/* specifier migration (2026-09-13)

This log covers PR #1221, slice P4a of the U13 private-registry-publishing
wave (issue #537): migrating 13 of the 17 `scripts/*` packages off the
pre-rename `@m3l-automation/m3l-common` pnpm workspace alias to the direct
`@monte3l/m3l-common` specifier. It records what shipped, two separate
diff-size ceilings discovered only after committing (not before), the
transitional dual-mode gate built to resolve them without breaking `main`,
and a should-fix-ack round.

Plan of record: [`docs/plans/2026-09-12-u13-registry-publish.md`](../plans/2026-09-12-u13-registry-publish.md)

## Summary

Shipped in PR #1221 (squash-merged as `f1d8b523`):

- 13 `scripts/*/package.json` files migrated from
  `"@m3l-automation/m3l-common": "workspace:@monte3l/m3l-common@*"` to
  `"@monte3l/m3l-common": "workspace:*"`; every corresponding `src/**` and
  `tests/**` import specifier, dynamic `import()`, and `vi.mock()` target
  updated to match.
- `bin/check-script-deps.mjs` and `bin/lib/script-scaffold.mjs` updated to
  require the new shape, then given a **transitional** dual-mode acceptance
  (new shape OR the old aliased shape) once 4 packages had to be deferred
  (see below) — clearly commented with what to delete once the follow-up
  slice (P4a2) lands.
- `templates/script/**/*.tmpl` updated so newly scaffolded scripts get the
  direct specifier.
- `eslint.config.js`'s `scripts/*`-scoped ADR-0029 import-boundary zones and
  the repo-wide `import-x/no-unresolved` ignore list updated (and, per a
  review nit, the ignore list tightened from the whole `^@monte3l/` scope
  down to `^@monte3l/m3l-common`).
- Pre-existing stale docs fixed along the way: `.claude/rules/scripts.md`,
  `bin/lib/command-catalog.mjs`, `docs/getting-started.md`.
- **4 packages deferred to a new follow-up slice, P4a2**: `agent-operator`
  (by far the largest, ~57k reviewable chars alone), `sqs-dead-letter-triage`,
  `cloudwatch-logs-analysis`, `sqs-etl`. All four still declare the old
  aliased shape on `main`, unchanged.

CI: all required checks passed on the final push — `Build & typecheck`,
`Test` (full coverage suite), `Lint (library)`, `Lint (workspace)`,
`Governance gates`, `CodeQL`, `should-fix-ack`, `review`, `verify`, `Run skill
evals`. `gh pr view` confirmed `mergeStateStatus: CLEAN` before merge.

Skills used: `starting-work` (abbreviated re-entry per `finishing-work`'s
next-slice handoff from PR #1217), `finishing-work`, `writing-work-logs`.

Spoke incidents: 0 truncations / 0 stalls / 0 resumes — roughly a dozen
`code-implementer`/`test-author` dispatches across this slice (the bulk
mechanical rename across `scripts/*/src` and `scripts/*/tests`, three
stale-fixture repair rounds, and the transitional-gate test coverage),
every one completing cleanly on the first call.

Compaction events: none — this slice ran in a single uninterrupted session
segment.

## What went as planned

- **The mechanical rename itself was clean on the first pass.** Two large
  parallel dispatches (one `code-implementer` for all `scripts/*/src` files,
  one `test-author` for all `scripts/*/tests` files) each wrote and ran their
  own one-off Node script performing a plain `String.replaceAll` across an
  explicit file list, verified zero remaining old-specifier occurrences, and
  correctly flagged an unrelated `@m3l-automation/agent-operator` self-
  reference as out of scope rather than touching it.
- **The full `pnpm verify` pipeline caught every stale-fixture regression
  immediately and precisely** — `bin/tests/check-script-deps.test.ts` and
  `bin/tests/script-scaffold.test.ts` both had hardcoded fixtures pinning the
  pre-migration shape as "conformant"; each failure named the exact expected
  vs. actual mismatch, making the fix dispatch trivial to scope.
- **The transitional dual-mode gate design held up under a second round of
  scope-narrowing** — when GitHub's separate 300-file ceiling forced
  deferring 3 more packages beyond `agent-operator`, the already-built
  "accept either shape" branch in both checkers and the ESLint zones
  generalized to "any number of not-yet-migrated packages" with no further
  logic changes, only comment/count updates.
- **Two independent review passes plus one focused review of the new
  transitional logic all returned clean** (no Must-fix, and Should-fix items
  were fixed in-flow) before the first push.

## What didn't go as planned, and why

### 1. `check:review-size` had never actually been evaluated against the real diff before the first commit

`pnpm verify` reported "✓ Check review size" on every run before the first
commit — but `bin/check-review-size.mjs` diffs `<base>..<head>`, and before
anything was committed, `HEAD` still pointed at the same commit as `base`
(the branch had just been created). The gate was silently checking an empty
diff and could not have caught anything. Only after committing all 17
migrated packages did a fresh run reveal the real number: 310,035 reviewable
chars, over the 300,000 ceiling — the PR would have been rejected outright.

**Why it happened:** `pnpm verify`'s invocation of the gate resolves
base/head from git refs, not the working tree, so running it pre-commit
during iterative development gives a trivially-passing false signal that
looks identical to a real pass in the terminal summary.

**Fix for future:** run `pnpm check:review-size` (or `pnpm verify` end-to-end)
again immediately _after_ committing a large mechanical change, before
declaring the size gate "already checked" — a pre-commit green run against
this specific gate proves nothing.

### 2. A second, separate, undocumented ceiling — GitHub's 300-file diff-view limit — surfaced only after pushing and opening the PR

After trimming to 16 packages (251,859 reviewable chars — comfortably under
the char ceiling), the automated PR review bot failed outright: `gh pr diff`
returns `HTTP 406` when a PR touches more than 300 files, and this PR touched 342. Neither `bin/check-review-size.mjs` nor any local `pnpm verify` gate
checks file count — only reviewable _byte_ size. The failure was invisible
locally and only discoverable once the review bot's own comment reported it
after the PR was already open.

**Why it happened:** this repo's own review-size tooling (`ADR-0072`,
`bin/check-review-size.mjs`) was built around byte/char budget, not file
count, because the char ceiling was assumed to be the binding constraint for
a typical PR. A mechanical rename touching one line in each of hundreds of
small files inverts that assumption: file count grows much faster than
reviewable bytes relative to a normal feature PR.

**Fix for future:** for a wide mechanical rename spanning many small files,
check `git diff <base>...HEAD --name-only | wc -l` against 300 _in addition
to_ `check:review-size`, before pushing — not just after the review bot
fails. Consider filing a follow-up to add a file-count check to
`bin/check-review-size.mjs` itself, so this is caught locally next time
rather than discovered live against GitHub's API.

### 3. Deferring packages out of an already-atomic gate required inventing a transitional dual-mode acceptance, not just a smaller diff

Splitting a 17-package mechanical rename by package subset looks simple
until the gate enforcing the new shape (`bin/check-script-deps.mjs`) is
itself atomic and package-agnostic — it doesn't know or care which packages
have migrated, it just requires the new shape from _every_ `scripts/*`
package. Deferring `agent-operator`'s migration to a follow-up PR without
any other change would have broken `main` the moment this PR merged: the
checker would then reject `agent-operator`'s still-unmigrated package.json.
The same problem existed independently in `bin/lib/script-scaffold.mjs` (used
by `check:script-scaffold`, not just `check:script-deps`) and in three
separate `eslint.config.js` regex sites banning any import that isn't the
"one true" specifier.

**Why it happened:** the original P4a plan assumed a single all-or-nothing
migration PR; the ceiling discoveries forced a mid-flight split the gate
design had no accommodation for, since "N of M packages migrated" was never
a state the checker was built to tolerate.

**Fix for future:** when a plan calls for an atomic multi-package migration
but a review-size or file-count ceiling forces a partial-package split,
budget for a transitional dual-mode acceptance in every gate/lint rule that
enforces the target shape — not just the obvious one — before deferring any
package, and comment every transitional branch with an explicit removal
trigger (this PR's convention: `TRANSITIONAL (ADR-0103 P4a/P4a2): ... Drop
this once P4a2 lands`) so the follow-up PR's own diff is a mechanical
grep-and-delete rather than a rediscovery exercise.

### 4. The should-fix-ack gate again required an explicit footer for a directly-fixed finding

Consistent with the PR #1217 finding recorded in
`docs/logs/2026-09-12-u13-registry-release-workflow.md`: the automated
review bot's one Should-fix finding (a genuine test-coverage gap in the
transitional dual-mode predicate) was fixed directly in the same commit that
carried the fix, and the `should-fix-ack` required check still needed an
explicit `Acknowledged-Should-Fix:` footer on that commit to pass — this is
now the second slice in a row to hit this, confirming it as a durable,
easy-to-forget repo convention rather than a one-off surprise.

**Why it happened:** same root cause as before — the gate enforces a
recorded _decision_ per Should-fix finding, not code correctness by itself.

**Fix for future:** already captured as a durable insight in the PR #1217
log; this occurrence is additional confirmation, not a new lesson.

## Insights

- **A gate that diffs `<base>..<head>` gives a false "already checked"
  signal when run before the first commit on a fresh branch.** Re-run
  `check:review-size` (and ideally the whole `pnpm verify`) immediately after
  committing a large change, not just before — a pre-commit pass against
  this class of gate proves nothing, since `HEAD` hasn't moved yet.

- **Reviewable byte size and file count are independent ceilings for a
  mechanical, many-small-files rename.** This repo's review-size tooling
  only measures the former; check `git diff --name-only | wc -l` against
  300 as a second, unwritten constraint whenever a change touches many files
  with a small per-file diff — a shape common to renames/migrations but rare
  in ordinary feature work, which is presumably why only one axis was built
  originally.

- **Splitting an atomic-by-design migration gate across multiple PRs needs a
  transitional dual-mode branch in _every_ enforcement point, not just the
  primary one.** A checker, a scaffold validator, and three separate ESLint
  regex sites all independently encoded "there is exactly one correct
  shape" — discovering and updating all of them, not just the first one
  found, is the actual work of a mid-flight package-subset split. Grep for
  every occurrence of the old constant/shape across `bin/**` and
  `eslint.config.js` before assuming one file's fix is sufficient.

- **`should-fix-ack` needs a footer even for a fixed finding — confirmed a
  second time.** Treat this as settled repo behavior now, not a surprise to
  re-discover per PR (already promoted in
  `docs/logs/2026-09-12-u13-registry-release-workflow.md`; no further
  promotion needed here).
