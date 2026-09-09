# Work log — issue #862 test-I/O sandbox policy (2026-09-09)

This log covers resolving GitHub issue #862 — the `no-restricted-syntax`
selector enforcing the no-real-filesystem-in-tests policy caught only a
member-expression call (`fs.mkdtempSync(...)`), not a bare named-import call
(`mkdtempSync(...)`), leaving `docs/contributing/style-guide.md`'s
`[enforced]` tag false. It records what shipped across two PRs, the census
work that overturned the issue's own evidence, a review round that caught a
real coverage gap in the fix itself, and durable insights.

Plan of record: [`docs/plans/archive/2026-09-09-issue-862-test-fs-sandbox-isolation.md`](../plans/archive/2026-09-09-issue-862-test-fs-sandbox-isolation.md)

## Summary

Two PRs, following the plan's docs-first-then-enforcement sequence:

- **PR #1148** (docs-only) rewrote `docs/contributing/style-guide.md`'s test-I/O
  policy section, `docs/contributing/contributing.md`, `rules/02-testing.md`,
  `docs/contributing/coding-standards.md`, and `.claude/rules/tests.md` to state
  the sandbox invariant the repo actually follows, tagged accurately for the
  state at the time (`[advisory]` pending PR 2, not overclaiming `[enforced]`
  for a mechanism that didn't exist yet — the exact discipline the issue was
  about). Required a `check:context-budget` ratchet-baseline update
  (`.claude/rules/tests.md` was already at 9,991/10,000 bytes).
- **PR #1149** widened `eslint.config.js`'s `no-restricted-syntax` to seven
  path-shape selectors and added `bin/check-test-fs-isolation.mjs` (new
  `pnpm check:test-fs-isolation`) for the one rule no per-node selector can
  express — a `mkdtemp()` sandbox with no matching `rm`/`rmSync` anywhere in
  the file. New `docs/adr/0100-test-fs-sandbox-isolation.md`. Wired into
  `package.json`, `lefthook.yml`, `CLAUDE.md`, `ci.yml`,
  `bin/lib/verify-steps.mjs`, `bin/lib/command-catalog.mjs`.

Every selector was validated with real ESLint against the live tree (608→623
tracked test files across two rounds) before being written, twice catching
real coverage gaps before they shipped rather than after: `symlink`/`link`'s
`(target, path)` argument order (caught during initial design), and three
selectors that only matched an identifier-form callee — missing
`fs.mkdirSync(...)`-style member calls entirely — caught by the PR's own
review round.

**Test counts**: `bin/tests/check-test-fs-isolation.test.ts` — 17 tests
(`findMissingCleanup`, `listCandidateTestFiles`, `runTestFsIsolationCheck`,
including a live-corpus assertion). Full suite unaffected:
16678+4276+471+34 tests, all passing across both PRs' final gate runs.
`pnpm check:test-fs-isolation` — 623/623 files clean on the live tree.

**Review verdicts**: PR #1148 — `docs-consistency-reviewer`, 2 findings (both
fixed: an `[enforced]` tag citing a not-yet-existing gate, and an
integration-test exemption claimed before its ESLint `ignores` existed).
PR #1149 — local `code-reviewer` + `docs-consistency-reviewer` pre-push (0
Must-fix, 7 Should-fix, all addressed), then `claude-pr-review.yml` on the
open PR: round 1 found 3 real selector-coverage Should-fix items (detailed
below) plus 2 Nits, 0 Must-fix; round 2 (after the fix) — PASS, 0 Should-fix,
1 finding suppressed under re-review convergence.

Skills used: starting-work, writing-commits, creating-prs, syncing-docs,
finishing-work, writing-work-logs.

Spoke incidents: none.

Compaction events: none.

## What went as planned

- **The plan's core empirical claim held under pressure.** The plan asserted
  every proposed ESLint rule was green on the live tree before being written
  — verified twice more during implementation (once before each PR's push)
  and it stayed true throughout; no rule ever needed loosening to avoid
  breaking an existing test.
- **The `symlink`/`link` argument-order fix, done during design validation,
  never had to be revisited.** Confirmed by both review rounds finding zero
  issues with it.
- **The context-budget ratchet-baseline mechanism worked exactly as
  documented** — `check:context-budget --update` cleanly absorbed
  `.claude/rules/tests.md`'s growth in PR #1148 with no other side effects.
- **`finishing-work`'s known `EnterWorktree` non-ownership pattern** (a
  worktree entered fresh after a mid-session gap loses tracked ownership)
  recurred exactly as documented in both worktree close-outs, and the
  `ExitWorktree(keep)` → shared-checkout fallback resolved it identically
  both times with no improvisation needed.
- **The hub/spoke path-guard boundary was exactly where the docs say it is** —
  `eslint.config.js` and `bin/*.mjs` (outside `bin/tests/`) were hub-writable;
  `bin/tests/check-test-fs-isolation.test.ts` and the three `**/tests/**`
  comment edits correctly required `test-author` dispatch. Confirmed by
  reading `guard-hub-src-writes.mjs`'s actual `isProtectedPath` regex before
  writing anything, rather than assuming from the file's directory name.

## What didn't go as planned, and why

### 1. Three of seven ESLint selectors only matched an identifier-form callee, missing the member-call form entirely

`claude-pr-review`'s first round on PR #1149 found that the `process.cwd()`,
`import.meta.dirname`, and `mkdtemp`-root-under-`tmpdir()` selectors all
anchored on `CallExpression[callee.name=...]` — which esquery only resolves
against an `Identifier` callee, not a `MemberExpression` one. So
`fs.mkdirSync(join(process.cwd(), "out"))` passed uncaught, a real regression
against the ban this rule set replaced (which banned every member-form
mutator call unconditionally). The same round found the inverse bug in the
`mkdtemp`-root selector's inner check: `[callee.name='tmpdir']` alone missed
`os.tmpdir()` (a default `import os from "node:os"` call site), so that
selector would have false-failed the next contributor who wrote `os.tmpdir()`
instead of a named `tmpdir` import — the tree was green only because the
sole existing call site (`checkpoint.test.ts`) happened to import it named.

Fixed by extracting a `sandboxFsCallEitherForm(namesPattern)` helper —
matching a call in either identifier or `fs`/`fsp`/`fsPromises` member form —
and applying it to all three selectors, plus widening the inner `tmpdir()`
check to match either `[callee.name='tmpdir']` or
`[callee.property.name='tmpdir']`. Verified live with the same
copy-into-`bin/tests/`-then-lint mutation technique used throughout: all
three previously-missed violations now fire, and the `os.tmpdir()`
false-positive is gone.

**Why it happened:** The four "arg-0 path" selectors (literal, template
literal, symlink's arg-1, member form) were each written and validated
individually against their own specific concern (path shape). The three
"anywhere in the subtree" selectors (cwd, dirname, tmpdir-root) were written
by pattern-matching the working literal-path selector's structure without
re-deriving from scratch whether that selector's `callee.name` anchor — which
happens to work for the arg-0 case only because it's paired with a separate,
explicit member-form selector alongside it — still covered both forms on its
own once copied into a different, standalone selector.

**Fix for future:** When one selector's structure is reused as a template for
a sibling selector, re-verify the reused fragment's assumptions hold in the
new context — don't assume "this pattern worked before" transfers without
re-checking what made it work. For an esquery `[callee.name=...]` check
specifically, treat "does this match a member-form call too" as a question to
answer explicitly with a live test, not to infer from the fact a nearby
selector already handles member form.

## Insights

- **Validate every ESLint selector with real ESLint against the live tree
  before writing it into `eslint.config.js`, not just by reasoning about the
  AST shape** — already promoted to `.claude/rules/harness-artifacts.md`
  ("run a new `check:*` gate live against this repo before writing its test
  suite"), and this task is a second, independent confirmation of the same
  principle applied to lint rules specifically: it caught the `symlink`
  argument-order bug during design and would have caught the member-form gap
  too, had the three cwd/dirname/tmpdir selectors been individually
  mutation-tested against a member-form call at write time instead of only
  against the identifier form they were designed around.
- **A selector reused as a structural template inherits its assumptions
  silently.** Copying a working selector's shape for a new rule doesn't copy
  the reasoning that made the original correct — the `callee.name` anchor
  worked in the literal-path selector because a paired member-form selector
  covered the other case; reused alone in three new selectors, that pairing
  wasn't there and the gap was invisible until a live mutation test (or a
  review pass) exercised the member-call form specifically.
  _(promoted → .claude/rules/harness-artifacts.md)_
- **`gh pr view --json mergeStateStatus` distinguishes a real blocker from
  free-running non-required checks** — `BLOCKED` means a required check is
  red or pending; `UNSTABLE`/`MERGEABLE` means only a non-required check
  (here, `should-fix-ack` during its dogfood period, and `Run skill evals`)
  is still settling. Confirmed live on both PRs: merging on `UNSTABLE` after
  every required check passed was correct both times, and checking this
  field first avoided burning a review round pushing an acknowledgment
  commit that `mergeStateStatus` already showed wasn't blocking anything.
- **A background `gh pr view`/`gh pr checks` polling loop needs a
  file-diff or variable-comparison guard to avoid one notification per
  poll interval** — a bare `while true; do gh ...; sleep N; done` Monitor
  fires on every tick regardless of whether anything changed; writing the
  current state to a file and diffing against the previous poll's file
  (or comparing a shell variable) before printing cut the noise to one
  event per actual state transition, which is what made watching two PRs
  through their full CI+review cycles tractable in this session.
