# Work log — eslint-cache (2026-09-10)

This log covers P3.3 of the adaptive-host-budgeting wave: adding ESLint
`--cache --cache-strategy content` as new local-dev-only scripts
(`lint:fast`, `lint:library:fast`, `lint:workspace:fast`), distinct from the
existing `lint`/`lint:library`/`lint:workspace` which stay uncached for
CI/pre-push reproducibility. It records the two design decisions confirmed
with the user, the live measurements taken to validate the design, and a
bot-review Should-fix finding resolved after push.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

`lint:library` and `lint:workspace` are split to bound peak memory (avoiding
loading `packages/m3l-common`'s TypeScript program twice under concurrency),
with `lint:workspace` also carrying a `--max-old-space-size=8192` heap bump.
The fast variant mirrors this split exactly rather than unifying into one
invocation, so the existing memory-safety property is preserved. Each fast
variant writes to its own cache file under `node_modules/.cache/eslint/`
(`library.eslintcache`, `workspace.eslintcache`) rather than a shared
location, since the two invocations lint disjoint file sets and must be able
to clear independently.

Two design decisions were confirmed with the user via `AskUserQuestion`
before implementing (both "(Recommended)" options accepted):

1. Cache file layout — separate cache files per invocation, not one shared
   file.
2. Script shape — mirror the full `lint`/`lint:library`/`lint:workspace`
   triad (`lint:fast`, `lint:library:fast`, `lint:workspace:fast`), not a
   single opaque combined script.

**Files changed** (4): `package.json` (3 new scripts),
`bin/lib/command-catalog.mjs` (3 new catalog entries), `bin/bench-gates.mjs`
(2 new lanes — `lint:library:fast`, `lint:workspace:fast` — each with its
own distinct `cacheDir`, unlike `turbo:typecheck`/`tsc:bin` which
intentionally share one), and `bin/tests/bench-gates.test.ts` (two
`test-author` dispatches, mutation-verified both times).

**Live measurements**: cold run 3:44 → warm run 11.4s. Deliberately
introduced a lint violation into both a brand-new file and an
already-cached existing file under a warm cache and confirmed both were
caught (content-strategy invalidation works correctly). Confirmed clearing
`lint:library:fast`'s cache file left `lint:workspace:fast`'s cache file's
mtime completely untouched (isolation).

**Gates**: `pnpm verify` green (twice — before and after the Should-fix
fix). PR #1159 — bot review `PASS` on the first round with one Should-fix
finding, resolved and acknowledged before merge; `should-fix-ack: pass` on
the second round.

Skills used: starting-work, creating-prs, syncing-docs,
resolving-pr-comments, finishing-work, writing-work-logs.
Spoke incidents: none.
Compaction events: none.

## What went as planned

- **Both `AskUserQuestion` design decisions resolved to their recommended
  option** with no back-and-forth.
- **Both `test-author` dispatches returned clean, mutation-verified
  results** with zero follow-up fixes needed: the initial lane-addition
  test (61/61, 2 mutants killed) and the Should-fix drift-guard test
  (62/62, 1 mutant killed).
- **The pre-push `docs-consistency-reviewer` dispatch found nothing** —
  command catalog descriptions, `CLAUDE.md`'s cadence table (correctly left
  untouched, since `lint:fast` never runs in pre-push/CI), and every
  cross-referencing doc were already consistent.
- **The bounded post-fix re-review (`code-reviewer`, scoped to just the new
  test block) found nothing** beyond optional nits.

## What didn't go as planned, and why

### 1. The bot review caught a real lane-vs-script drift gap the initial test missed

The `claude-pr-review.yml` bot's first-round review (`PASS`, one
Should-fix) flagged that `bin/bench-gates.mjs`'s two new lane `cacheDir`
values duplicate `package.json`'s `--cache-location` paths as free-standing
string literals with nothing cross-checking them. The initial
`bench-gates.test.ts` addition asserted the two lanes' `cacheDir`s were
distinct from each other, but never checked they actually matched their
corresponding script's `--cache-location` argument — so a rename in
`package.json` alone would leave `clearLaneCacheDir` silently deleting a
path that no longer exists (`{ force: true }` swallows the resulting
ENOENT), and a `--cold` benchmark run would report warm-cache numbers with
no error at all.

Verified the claim against the live files before dispatching a fix, then
had `test-author` add a targeted regression test asserting each of the two
lanes' `cacheDir` appears literally as a substring of its corresponding
`package.json` script string — mutation-tested by mismatching one path and
confirming the new test (and only that test) failed.

**Why it happened:** the P3.2 log's own lesson ("a template's
shape-checker can silently assume no per-instance variance until the first
templated value breaks it") is the same class of gap in a different
shape — a value duplicated across two files with no test asserting they
agree. The first test-author dispatch was scoped to "the two new lanes
exist and are distinct from each other," which is necessary but not
sufficient; nothing in that scope asked "do they still match the thing they
were derived from."

**Fix for future:** when a `cacheDir`/`--cache-location`-shaped value is
copied from one file into another (a `LANES` entry mirroring a
`package.json` script's own CLI flag), the regression test for the new
value should assert it against its source of truth, not just against its
sibling values. Name this explicitly in the `test-author` dispatch prompt
next time a benchmark lane wraps an existing script's cache flag.

## Lessons learned

- **A design decision with only two files needs a test that ties them
  together, not just a test per file.** Two spokes' worth of test coverage
  (lane-list, lane-vs-lane distinctness) can both pass while the thing that
  actually matters — this file's value equals that file's value — is
  unchecked. Ask "what two things must stay in sync?" explicitly before
  scoping a test-author dispatch, not just "what does this new code do?"
- **A bot review round after push is not redundant with the pre-push spoke
  review — it caught something the pre-push `docs-consistency-reviewer`
  did not, because it was reading different content (the live diff GitHub
  sees) with a different lens (correctness, not doc-consistency).** This
  matches `resolving-pr-comments`' own stated boundary: judge a post-push
  finding on its own merits, not as a re-litigation of the pre-push pass.
- **Mirroring an existing split (`lint:library`/`lint:workspace`'s
  memory-bounding rationale) into a new variant is safer than unifying
  it.** The heap-sizing and package-isolation reasons behind the original
  split still apply to a cached variant; collapsing back to one invocation
  would have silently reintroduced the risk Stage 0 of this same wave had
  just fixed (the `lint:workspace` heap-ceiling crash,
  `docs/logs/2026-09-08-earlyoom-process-matching.md`).
