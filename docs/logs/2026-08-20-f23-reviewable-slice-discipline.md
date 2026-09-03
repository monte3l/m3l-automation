# Work log — F23 reviewable-slice discipline (2026-08-20)

This log covers issue #571 (F23), the post-mortem of PR #523
(`core/procedure`/B2, abandoned after five review rounds). It records ADR-0072
and the tooling it introduces — a soft PR-size target, a per-file size
ratchet, a `check:test-counts` fix, and a `check:scaffold-seam` extension —
landed across three stacked PRs that dogfood the discipline being introduced.

Plan of record: `~/.claude/plans/on-issue-571-delightful-metcalfe.md`
(session-local plan file; not archived to `docs/plans/` as this session had
not yet reached the PR-open step at time of writing).

## Summary

Three stacked PRs on `origin/main`, each independently reviewable:

- **PR 1 — #572** (`fix/f23-landing-discipline`): `docs/adr/0072-reviewable-slice-discipline.md`
  (new), four skill edits (`creating-prs`, `starting-work`,
  `implementing-submodules`, `scaffolding-submodules`), three rule edits
  (`library-src.md`, `tests.md`, `subagent-dispatch.md`), two contributing-doc
  edits (`subagent-context-management.md`, `branch-protection.md`,
  `contributing.md`), one `CLAUDE.md` line, `docs/plans/IMPLEMENTATION.md`'s
  F23 row. Entirely `*.md`/`docs/**`/`.claude/**` — measures 1,832 reviewable
  chars against the gate it introduces (effectively ~0, since everything in
  scope is ignored by `claude-pr-review.yml`'s own predicate).
- **PR 2 — #573** (`fix/f23-review-size`, stacked on #572): `bin/check-review-size.mjs`
  (new) — local reproduction of `claude-pr-review.yml`'s reviewable-size
  measurement, reading `MAX_REVIEWABLE_BYTES` from the workflow file at
  runtime — plus `bin/tests/check-review-size.test.ts` (25 tests,
  `test-author`) and full wiring (`package.json`, `command-catalog.mjs`,
  `verify-steps.mjs`, `ci.yml` gates lane, `lefthook.yml`, `CLAUDE.md`
  cadence table). This PR's own reviewable diff: 26,033 chars, under its own
  75,000-char soft target.
- **PR 3** (`fix/f23-remaining-gates`, stacked on #573, in progress at time of
  writing): `bin/check-file-budget.mjs` (new, per-file size ratchet against
  a committed baseline `bin/file-budget-baseline.json`), `bin/check-test-counts.mjs`
  (marker-based rekeying + new `findUncountedFiles` warning),
  `bin/check-scaffold-seam.mjs` (new `## Landing plan` enforcement, a CLI
  guard it never had before, an extracted `landingPlanVerdict` function),
  plus four `bin/tests/*.test.ts` files (`test-author`, 92 new tests
  combined) and wiring.

Full-suite results at each PR's completion: `pnpm typecheck && pnpm lint &&
pnpm test:coverage && pnpm build` all green throughout — 7,301 library tests

- up to 1,362 `bin/` tests (both Vitest configs), 0 failures at every
  checkpoint.

**Skills used:** starting-work, writing-work-logs (this log). No
`implementing-submodules`/`scaffolding-submodules` pipeline run — this was
process/tooling work, not a library submodule, so the hub wrote `bin/*.mjs`
gate scripts directly (not a guarded path) and dispatched `test-author` only
for the guarded `bin/tests/**` files.

**Spoke incidents:** none — 6 `test-author` dispatches (1 per PR2 gate, 1 new

- 1 extended per PR3's three gates) and 2 review dispatches
  (`docs-consistency-reviewer` on PR1, `code-reviewer` + `silent-failure-hunter`
  in parallel on PR3), zero truncations, zero stalls, zero resumes needed.

## What went as planned

- **The core reframe held up under implementation.** Exploration established
  that incremental submodule landing already works with zero gate changes
  under two slicing rules (verified by reading `check-exports-snapshot.mjs`,
  `check-doc-exports.mjs`, `check-doc-counts.mjs`, `check-impl-counts.mjs`,
  `check-test-counts.mjs`, `knip.json`, `check-doc-provenance.mjs`, and
  `check-reference-index.mjs` in full) — this became ADR-0072's Decision
  section verbatim, with no rework needed once implementation started.
- **The `origin/feat/core-procedure-engine` recovery worked exactly as
  predicted.** The abandoned branch's local remote-tracking ref was intact;
  `git diff --stat main...origin/feat/core-procedure-engine` reproduced the
  44-file/15,396-insertion figure the ADR cites, confirming #474 is fully
  recoverable rather than lost work.
- **Every synthetic-state verification I ran before dispatching a spoke came
  back clean** — probing `check-review-size.mjs`'s pure functions against a
  hand-built oversized diff, `check-file-budget.mjs`'s `checkBudget`/
  `buildBaseline` against hand-built entries, and `check-scaffold-seam.mjs`'s
  extension against a full synthetic in-flight-module sandbox (created,
  tested three scenarios, cleaned up, verified `git status` clean) — all
  matched the intended design with zero rework.
- **The `check:test-counts` fix reproduced the exact set the audit predicted.**
  14 sibling test files with no matching recorded row, matching the
  exploration agent's earlier count precisely.
- **Stacked-branch PR sequencing worked cleanly.** `git switch -c` off the
  prior unmerged branch, `gh pr create --base <prior-branch>`, three times —
  no rebase conflicts, no wiring collisions between PR2 and PR3 despite both
  touching `package.json`/`command-catalog.mjs`/`verify-steps.mjs`/`ci.yml`.

## What didn't go as planned, and why

### 1. Two false starts writing JSDoc comments containing glob syntax

`bin/check-file-budget.mjs`'s first draft used literal glob patterns like
`` `packages/*/src/**` `` inside `/** ... */` block comments. The `*/`
substring inside `*/src` closed the comment early, producing a real parse
error (`eslint`: "Unexpected keyword or identifier") on the first lint pass,
and a second, narrower instance survived a first fix pass (a single-line
`/** ... */` comment with the same pattern later in the file).

**Why it happened:** A glob pattern's `*/` reads identically to a JSDoc
closing delimiter to the JS parser; writing prose about file-path globs
inside a block comment is a footgun this repo's `report.mjs` header comment
already warns about for a different token shape (`exports.<name>`), but
nothing flagged this specific glob-in-comment case until lint caught it.

**Fix for future:** When describing a glob pattern inside a `/** */` block
comment, either escape every `*/` occurrence (`*\/`) or avoid the glob syntax
entirely (describe the pattern in prose — "every package's `src` tree" —
rather than reproducing the literal glob). Grep the drafted comment for `*/`
substrings before the first lint pass on any new `bin/*.mjs` file whose
header discusses file-path patterns.

### 2. A dispatched test-author found a real, pre-existing gap outside the task's stated scope

Writing `bin/tests/check-scaffold-seam.test.ts` required exporting four
previously-private helper functions to make them testable; doing so let the
test-author discover that `check-scaffold-seam.mjs` — unlike every sibling
`bin/*.mjs` gate — had **no CLI guard**
(`process.argv[1] === fileURLToPath(import.meta.url)`). Its entire scan-and-
report logic ran unconditionally at module _import_ time, including a
possible `process.exit(1)`. This was harmless only because the live repo was
green; importing the module for testing worked by accident, not by design.

**Why it happened:** The file predates the `bin/*.mjs` convention of guarding
CLI logic (or was written before that convention solidified) and had zero
prior test coverage, so nothing had ever imported it without also wanting its
side effects.

**Fix for future:** Fixed immediately, in-scope — added the standard guard
and extracted the Landing-plan branch decision into a new exported pure
function (`landingPlanVerdict`), then resumed the same `test-author` spoke
(`SendMessage`, not a fresh dispatch) to add coverage for the newly-testable
function. A subsequent `code-reviewer` + `silent-failure-hunter` pass
confirmed the refactor was behavior-preserving. When a dispatched spoke
surfaces a real defect adjacent to (but not exactly) its assigned task,
fixing it in the same PR — rather than filing it separately — kept the fix
reviewed by the same passes already scoped to that file.

### 3. A genuine silent-failure Must-fix found by review, in code I wrote and had already manually verified

`silent-failure-hunter` found that `check-file-budget.mjs`'s
`collectBudgetEntries` caught **any** `readdirSync(packagesDir)` failure
(not just "directory doesn't exist") and silently returned an empty package
list — meaning a broken scan (permissions error, bad repo-root resolution)
would report "0 files checked, none exceed their limit" as a clean pass,
exactly the failure mode this gate exists to prevent in CI. I had run the
live gate against the real repo multiple times before this review and it
always looked correct, because `packages/` was always readable in every run
— the defect was invisible to any amount of happy-path manual verification.

**Why it happened:** I modeled `collectBudgetEntries`'s top-level
`readdirSync(packagesDir)` on `walkMatching`'s per-package `src`/`tests`
scan, where a missing directory _is_ a legitimate, expected case (a package
without tests). `packages/` itself, unlike a package's `src`/`tests`
subdirectory, is never optional — the two call sites look structurally
identical but carry opposite correctness requirements.

**Fix for future:** Fixed by letting `collectBudgetEntries` throw on a
`packages/` read failure (removing the catch-all) and adding an explicit
try/catch with `reporter.error()` + `process.exit(1)` in the CLI block —
matching the established pattern elsewhere in the same file (the baseline-
JSON-parse catch). Also tightened `walkMatching`'s catch-all to only swallow
`ENOENT` specifically (the reviewer's lower-priority Should-fix), re-throwing
anything else. _(promoted → `.claude/rules/library-src.md`, see Lessons
learned)_

## Lessons learned

- **A required root directory and an optional subdirectory look identical in
  a try/catch, but are not.** `readdirSync` wrapped in `try { } catch { return
[] }` is correct for a directory whose absence is a legitimate case (a
  package with no `tests/`) and a silent success-masking bug for a directory
  that must always exist (the monorepo's `packages/` root itself). Before
  writing a catch-all around a directory read, ask whether "directory
  missing" is actually a valid state for that specific path — if not, catch
  the specific expected error code (`ENOENT`) and let anything else
  propagate. _(promoted → `.claude/rules/library-src.md`)_
- **Manual verification against the live repo cannot catch a defect that only
  manifests when the live repo is in a state you never construct.** I ran
  `check-file-budget.mjs` against the real repo many times and it was always
  correct — because the one input that would expose the bug (`packages/`
  being unreadable) never occurred in any manual run. This is exactly why
  `.claude/rules/tests.md` requires testing a `bin/` checker against
  synthetic state, not just today's live repo — and why a dedicated adversarial
  review pass (here, `silent-failure-hunter`) catches a class of defect that
  "I ran it and it worked" structurally cannot.
- **A dispatched spoke's incidental discovery is worth fixing in-scope, not
  filing separately.** The missing CLI guard in `check-scaffold-seam.mjs` was
  outside the test-author's assigned task (write tests for the new Landing-
  plan logic) but directly blocked doing that task well. Fixing it
  immediately — rather than working around it with a fragile test or filing
  a separate follow-up — kept the fix inside the same review passes already
  scoped to that file, and let the resumed spoke (via `SendMessage`, not a
  fresh dispatch) add coverage for the newly-extracted function with full
  context intact.
- **Reading each `bin/*.mjs`'s actual decision logic, not the prose around
  it, was the single highest-leverage research step in this task.** The
  ADR's central finding — that incremental landing already works with zero
  gate changes — would not have surfaced from reading `CLAUDE.md`'s "Known
  Gotchas" bullet alone; it required three parallel Explore agents each
  reading a named gate's source in full and quoting the deciding code. This
  confirms the existing gotcha ("what a `check:*` gate enforces is defined by
  its `bin/*.mjs` source, not nearby prose") generalizes past single-gate
  questions to whole-system audits.
- **Glob syntax inside a JSDoc block comment needs a pre-lint self-check.**
  A literal `*/` substring in prose describing a file-path pattern silently
  reads as the comment's closing delimiter to the parser. Grep a drafted
  header comment for `*/` before the first `eslint`/`prettier` pass whenever
  the comment discusses glob patterns.
  _(promoted → `.claude/rules/domain-knowledge.md`)_
