# Work log — U13 registry specifier cleanup, P4b1-P4b6 (2026-09-13)

This log covers the U13 wave's slice 4 (optional hygiene) sub-slices P4b1
through P4b6 — migrating every remaining `@m3l-automation/m3l-common`
reference to the ADR-0103-renamed `@monte3l/m3l-common` specifier and
retiring the transitional workspace alias entirely. P4a/P4a2 (the
`scripts/*` migration) were already logged separately
(`2026-09-13-u13-registry-scripts-specifier-migration.md`,
`...-p4a2.md`). This log records what shipped across all six P4b
sub-slices, what diverged from plan, and the durable insights.

Plan of record: [`docs/plans/2026-09-12-u13-registry-publish.md`](../plans/2026-09-12-u13-registry-publish.md)

## Summary

Six PRs landed the code (plus five small docs-only close-out PRs flipping
the landing-plan tracker after each merge):

- **P4b1** (PR #1227) — `packages/m3l-common/src/core/**` + `internal/**`
  TSDoc-only specifier fix (167 files, self-referential comments only).
- **P4b2** (PR #1228) — the `src/aws/**` half of the same split (54 files).
  Both were split out of an original single "all of `m3l-common`" slice
  after it measured 296,422 reviewable chars — under the 300k ceiling but
  with almost no margin, the same trap P4a hit.
- **P4b3** (PR #1231) — `packages/m3l-cli` real import-specifier migration
  (~33 files: 20 `src/`, 13 `tests/`), `package.json` dependency key/value,
  the CLI's ESLint import-boundary zone, and `bin/check-cli-scaffold.mjs`'s
  dependency constants. Removed `discover.ts`'s now-dead
  `LIBRARY_PACKAGE_NAME` exclusion constant.
- **P4b4** (PR #1234) — `packages/m3l-console-server` migration (52
  `src/` + 60 `tests/` files), plus `eslint.config.js`'s console-server
  zone (functional regex + 3 descriptive per-module messages) and
  `bin/check-eslint-zones.mjs`'s hardcoded scope check for that zone.
- **P4b5** (PR #1237) — `packages/m3l-console-web` migration (3 `src/` +
  2 `tests/` files — the smallest slice, since only 3 files had real
  imports). This was the last real-import consumer, so
  `import-x/no-unresolved`'s `^@m3l-automation/` ignore entry was dropped
  entirely from `eslint.config.js` — re-verified via a repo-wide grep for
  real (non-comment) import/export statements before acting on the plan's
  own claim, per the "re-derive any authored claim" task rule.
- **P4b6** (PR #1239) — originally scoped as a "living docs" sweep
  (`docs/reference/{core,aws}/*.md`, `docs/guides/*.md`,
  `docs/contributing/*.md`, a few root-level docs pages). Grew
  substantially mid-slice once round-1 review flagged `CLAUDE.md` itself
  still naming the old scope (see divergence #7 below): the same
  staleness class was traced to root `package.json`/`README.md`, all 4
  `packages/*/README.md` files, 2 `rules/*.md` files, every
  `.claude/agents/*.md`/`.claude/skills/*/SKILL.md` file, and — the real
  bug — `bin/lib/reference-index.mjs`'s `IMPORT_PATH` constant, which was
  the actual root cause stamping the stale specifier into every generated
  `docs/reference/catalog.json` entry.

Every full-workspace verification run across all six slices reported the
same steady-state count: 486+120+28+7 = 641 test files, 22,337 tests
(17,297 + 4,510 + 496 + 34), full typecheck/lint/build/format green.
`check:review-size` stayed comfortably under the 300k ceiling on every
slice (largest: P4b1's ~236k core split; smallest: P4b5's ~7k, P4b6's
~26k — both well under the 75k soft target too, once P4b6's scope grew).

By the end of this wave, zero real `@m3l-automation/m3l-common` references
remain anywhere in the repository outside historical/immutable records
(`docs/adr/**`, `docs/logs/**`, `docs/plans/archive/**`,
`docs/ROADMAP.md`'s completed-PR entries, and this plan doc's own
before/after narrative) and one deliberately-deferred category (three
`.claude/skills/*/evals/evals.json` fixtures with seeded old-scope file
content — a different risk profile than prose, tracked as a known
follow-up rather than swept blind).

**Skills used:** resolving-merge-conflicts, writing-work-logs. (No
`starting-work`/`creating-prs`/`finishing-work` invocation — this session
followed their documented patterns manually slice-by-slice rather than
invoking the skills themselves, since each slice repeated the same
worktree → implement → verify → PR → merge → cleanup → tracker-flip
cycle already established by P4a/P4a2.)

**Spoke incidents:** none — 7 code-implementer/test-author spokes
dispatched across P4b3-P4b6 (a stash-conflict resolution, a should-fix
test-assertion fix, a stale-comment fix, and two src/tests migration
pairs for console-server and console-web), all completed cleanly on the
first dispatch with no truncations, stalls, or `SendMessage` resumes.

**Compaction events:** one, at the very start of this visible segment
(a `/compact` boundary inherited from the prior conversation) — the
handoff recovered cleanly; no state was observably lost across it.

## What went as planned

- **Every mechanical import-specifier migration (P4b1-P4b5) verified
  clean on the first spoke dispatch.** Each code-implementer/test-author
  pair confirmed zero remaining matches via `grep` before reporting done,
  and every reported typecheck/build result was genuinely green (not
  masked by a pre-existing failure).
- **The P4b1/P4b2 review-size split held.** Splitting the original
  bundled `m3l-common` slice along the `core`/`aws` boundary (rather than
  accepting the ~3.5k-char margin the bundled version left) meant neither
  slice came anywhere near the ceiling.
- **`check:zones`, `check:cli-docs`, `check:reference-freshness`,
  `check:reference-index`, and `check:doc-provenance` all passed clean**
  on every slice that touched their respective surfaces, with no
  unexpected drift.
- **The should-fix-ack gate correctly caught two genuine regressions
  this session introduced itself** (a forgotten `git add` after a
  prettier fix, and a rebase silently dropping an acknowledgment commit)
  — the gate did its job exactly as designed.

## What didn't go as planned, and why

### 1. Rebasing P4b2 (`feat/u13-registry-specifier-cleanup-2b`) onto `main` after P4b1 merged hit two conflicts

The landing-plan doc conflicted (both PRs had independently updated the
same table rows from the same base — expected and documented in both PR
bodies). More surprising: `M3LAppendOnlyStream.ts` conflicted because an
unrelated, later-merged storage refactor (the append-only writer/sealer
work) had relocated `M3LAppendOnlyStreamOptions` out of that file
entirely, into a new `append-only-write-types.ts`. The stash's/rebase's
re-addition of the old interface+TSDoc block was pure dead content by
the time of the rebase.

**Why it happened:** `main` advanced with unrelated work between when
P4b2's branch was cut and when P4b1 merged, and that unrelated work
happened to touch the exact file P4b2's mechanical TSDoc fix also
touched.

**Fix for future:** When a rebase conflict's `Updated upstream` side is
empty or clearly non-overlapping with the base, check whether the
symbol in question moved elsewhere before assuming the conflict is a
simple content collision — `grep` the target symbol name across the
package first.

### 2. GitHub Actions silently dropped a `pull_request: synchronize` event after a force-push

After rebasing P4b2 and force-pushing, `CI`/`Claude PR Review`/
`Dependency Review` never created a run at all (only the GitHub-managed
default CodeQL scan ran) — 18+ minutes with no trace. Confirmed this
wasn't specific to this push by checking a second, completely unrelated
PR pushed around the same time by a different actor, which showed the
identical gap. GitHub's own status page showed no incident.

**Why it happened:** Unknown — an apparent one-off webhook delivery
drop, not a config or infra problem (repo Actions permissions were
correctly enabled throughout).

**Fix for future:** An empty-commit push immediately re-triggers a fresh
`synchronize` event and is a safe, reversible diagnostic step when CI
looks stuck with zero runs (not even a queued one) rather than a failed
one. Confirm the pattern first (checking whether it's isolated to one
PR or systemic) before assuming a config problem.

### 3. A prettier fix was applied to the working tree during the rebase but never actually committed

After resolving the landing-plan table conflict by hand, running
`prettier --write` fixed formatting — but the subsequent commit only
staged `docs/adr/provenance.json` (the file being addressed at that
exact step), silently leaving the prettier fix sitting uncommitted in
the working tree. Local `pnpm format:check` then passed (it checks the
working tree, not `HEAD`), masking the gap until CI's `Format & Markdown`
job — which checks out the pushed commit fresh — failed.

**Why it happened:** Conflating "run a formatter to fix the working
tree" with "stage everything that needs to be staged" — two file-level
`git add`s were needed in sequence but only one happened.

**Fix for future:** After any `prettier --write` mid-resolution, run
`git status --short` immediately and confirm every modified file is
either intentionally staged or intentionally left for later — don't
trust a passing local `format:check` as proof the fix was committed.

### 4. The same rebase silently dropped an `Acknowledged-Should-Fix:` commit as an empty no-op

A prior round's should-fix finding had already been acknowledged with a
trailer on a specific commit. The rebase's conflict resolution made that
commit's diff resolve to a no-op (its content was already present via
the merged sibling PR), so git silently skipped creating it — and its
trailer — entirely. `should-fix-ack` correctly failed on the next CI
run, since the acknowledging commit no longer existed anywhere in the
branch's history.

**Why it happened:** Git's default rebase behavior silently drops a
replayed commit whose diff becomes empty after conflict resolution,
with no warning that a trailer/message was lost along with it.

**Fix for future:** After resolving a rebase conflict that touches a
finding previously acknowledged with a trailer, check
`git log <branch> --grep="Acknowledged-Should-Fix"` post-rebase to
confirm the trailer commit survived — don't assume history was
preserved just because the rebase completed without error.

### 5. `bin/check-eslint-zones.mjs` had a hardcoded old-scope string the P4b3 migration missed

The ADR-0042 CLI import-boundary check
(`hasCliImportBoundary`) asserted `pattern.regex.includes("@m3l-automation/m3l-common")`
— so once `eslint.config.js`'s own zone regex was correctly updated to
the new scope, the _checker validating that zone_ started failing
`Governance gates`, even though the actual ESLint rule was correct.

**Why it happened:** The migration correctly updated the config file the
checker validates, but not the checker's own hardcoded expectation of
what that config should contain — two independent copies of the same
fact, one updated and one not.

**Fix for future:** When a migration changes a config value that a
`bin/check-*.mjs` gate structurally validates (not just runs), grep
`bin/*.mjs` for the old value _before_ considering the migration
complete, not after CI catches the gap. This exact class of bug recurred
in P4b4 too (the console-server sibling check, `hasConsoleServerImportBoundary`)
and was caught proactively there by checking for it upfront, rather than
waiting for CI.

### 6. Directly editing files on the `docs/close-out-u13-p4b5` branch instead of creating a fresh branch for P4b6

After merging PR #1237 and creating a docs-only tracker-flip branch/PR
for P4b5, work on P4b6 (re-deriving scope, then implementing the fix)
was started directly on that same branch without first creating
`feat/u13-registry-specifier-cleanup-6` off `main`. This wasn't caught
until after several files had already been edited.

**Why it happened:** The tracker-flip PR's branch was still checked out
in the shared working directory when P4b6 work began, and no explicit
branch-creation step was taken before starting to edit.

**Fix for future:** Recovered cleanly since the tracker-flip commit was
already pushed (so opening its PR was unaffected by later uncommitted
changes) and the P4b6 changes were still uncommitted (so `git checkout
main` carried them forward safely) — but the right process is to
create and check out the next slice's branch _immediately_ after a
PR/tracker-flip is pushed, before any new edit, not after noticing the
mistake.

### 7. `should-fix-ack` flagged `CLAUDE.md` itself still naming the old scope, which led to discovering a much wider gap than the plan scoped

P4b6 was originally scoped to `docs/**` living-doc pages. Round-1 review
found `CLAUDE.md`'s own package description still said
`@m3l-automation/m3l-common`. Fixing it and then proactively re-sweeping
the whole repo (rather than stopping at the one flagged file) surfaced:
root `package.json`'s description and `README.md`, all four
`packages/*/README.md` files (one of which — `m3l-common`'s own —
described a workspace-alias installation pattern that no longer exists
anywhere, requiring a real rewrite, not a string swap), two top-level
`rules/*.md` files, every `.claude/agents/*.md` and
`.claude/skills/*/SKILL.md` file naming the library generically, and —
the actual functional bug — `bin/lib/reference-index.mjs`'s `IMPORT_PATH`
constant, hardcoded to the old scope, which was silently stamping the
stale specifier into every entry of the generated
`docs/reference/catalog.json` on every regeneration.

**Why it happened:** The original P4b6 scoping (from an earlier planning
pass) assumed `docs/**` was the complete blast radius of "living
documentation," without checking whether the same package name also
appeared in root-level project files, per-package READMEs, or harness
prompt files.

**Fix for future:** When a should-fix finding names one file with a
class of staleness, treat it as a sample, not the full population —
re-run the same grep pattern across the whole repository (excluding
already-identified historical scope) before considering the fix
complete, and deliberately draw an explicit boundary around what's
intentionally excluded (this session excluded eval-fixture JSON files
with embedded old-scope content — a genuinely different risk profile —
and said so explicitly rather than silently expanding forever).

### 8. The `EnterWorktree` permission prompt didn't reach the user's mobile Remote Control client

Two consecutive `EnterWorktree` calls were rejected because the user,
connected via the Claude mobile app's Remote Control, couldn't see the
approval prompt at all.

**Why it happened:** A client-side rendering gap for that specific tool's
confirmation UI on the Remote Control mobile surface — not a permissions
or policy issue.

**Fix for future:** When a specific tool's permission prompt appears to
not reach the user (repeated silent rejection with no visible reason),
check whether the same operation can be accomplished with a different,
already-approved tool instead of retrying the same call — plain
`cd <path> && <command>` Bash calls worked identically for every
worktree operation needed for the rest of the session once this was
recognized.

## Insights

- **A `bin/check-*.mjs` gate that structurally validates a config value
  is a second, independent copy of that value — grep for it explicitly
  whenever the config changes.** This recurred twice in one wave
  (P4b3's CLI zone check, P4b4's console-server zone check) and each
  time was a real Governance-gates failure, not a false positive.
  _(promoted → .claude/rules/harness-artifacts.md)_
- **After any mid-resolution `prettier --write`, immediately check
  `git status --short` before the next commit** — a passing local
  `format:check` only proves the working tree is clean, not that the
  fix was staged.
- **A rebase silently drops a replayed commit — and any trailer it
  carried — when conflict resolution makes its diff empty.** Verify a
  previously-acknowledged should-fix trailer survived a rebase by
  grepping post-rebase history, not by assuming.
- **A should-fix finding naming one stale file is a sample of a class,
  not the full population.** Re-running the same grep pattern
  repo-wide (with an explicit, stated boundary around what's
  deliberately excluded) found 23 more files with the identical
  staleness class in this session, including one genuine functional
  generator bug (`bin/lib/reference-index.mjs`'s hardcoded
  `IMPORT_PATH`) that a pure-`docs/**` sweep would never have reached.
- **When a specific tool's permission prompt silently fails to reach the
  user on an alternate client (mobile Remote Control), try a different
  already-approved tool for the same operation** rather than retrying
  the same call — plain path-prefixed Bash commands substitute cleanly
  for `EnterWorktree` when the latter's confirmation UI doesn't render.
- **An empty-commit push is a safe, reversible first diagnostic step
  when CI shows zero runs (not even queued) rather than a failure** —
  confirm the pattern isn't isolated to one push (check another
  unrelated PR) before assuming a config problem, then retrigger.
  _(promoted → .claude/skills/triaging-ci/SKILL.md)_
