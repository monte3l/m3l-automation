# Work log — `eslint-concurrency` (2026-09-11)

P3.6 of the adaptive-host-budgeting wave (Stage 3, Phase 2 tuning candidate
6): host-derived `--concurrency` for the local-only `lint:library:fast`/
`lint:workspace:fast` targets, gated carefully against the real OOM history
(`issue #734`) that had previously forced CI's `lint-library`/
`lint-workspace` jobs apart and pinned every lint invocation at
`--concurrency=1`. Records the pre-implementation design-scoping questions,
two full rounds of `claude-pr-review` bot findings (a real bug and two
genuine error-handling gaps), and the resulting insights.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

- `bin/print-eslint-concurrency.mjs` (new): exported
  `resolveEslintConcurrency(target, profile)` derives `--concurrency` from
  `deriveBudget(profile, { perWorkerGiB })`, using each target's own measured
  single-worker peak (`library`: 3.1 GiB, `workspace`: 3.8 GiB — the numbers
  already documented in `.github/workflows/ci.yml`'s `lint-library` job
  comment) instead of `deriveBudget`'s 1 GiB default, since
  typescript-eslint's `projectService` duplicates the entire typed-lint TS
  program per worker. Returns `.workers` (not `.concurrentLaneWorkers`) since
  the `*:fast` targets run standalone with no sibling pre-push lane to halve
  for.
- `package.json`: `lint:library:fast`/`lint:workspace:fast` now compute
  `--concurrency=$(node bin/print-eslint-concurrency.mjs <target>)`. The
  plain `lint:library`/`lint:workspace` scripts — used by both pre-push and
  CI's split jobs — are byte-for-byte untouched, still hardcoded at
  `--concurrency=1`.
- `bin/lib/command-catalog.mjs`, `docs/contributing/host-resources.md`
  updated to describe the mechanism and its local-only scope.
- **Live-verified on the real host** (4 cores, 22.1 GiB available) before any
  test was written: both `library` and `workspace` derive to
  `--concurrency=2` (up from the hardcoded `1`), and `pnpm lint:library:fast`/
  `pnpm lint:workspace:fast` complete cleanly end-to-end with the new value.
- Tests: `bin/tests/print-eslint-concurrency.test.ts` (6 cases, including a
  crossover-profile case proving the two targets' distinct `perWorkerGiB`
  values produce different `workers` results) — `test-author` dispatched
  four times total across the implementation and the two review-fix rounds.
- `pnpm verify`: 72 passed / 10 skipped (push-only) / 0 failed, on the
  implementation push and both review-fix follow-up pushes.
- PR #1178, opened, reviewed (two `claude-pr-review` rounds), merged
  2026-09-11T01:26:21Z.

**Skills used:** starting-work, resolving-pr-comments (x2), syncing-docs,
creating-prs, finishing-work, writing-work-logs.

**Spoke incidents:** none — `tmp/session-incidents.jsonl` absent; every
`test-author` and `code-reviewer` dispatch (7 total: 1 initial test-author, 3
pre-push/post-push `code-reviewer` rounds, 3 follow-up `test-author` fixes)
completed in a single clean pass with no truncation, stall, or `SendMessage`
resume.

**Compaction events:** none during this task.

## What went as planned

- **A design-scoping round before any code was written closed a real safety
  gap.** The plan-doc row ("ESLint `--concurrency` > 1") gave no guidance on
  scope, and the naive reading — "just raise the number" — would have
  reopened issue #734's OOM class. Three targeted `AskUserQuestion` rounds
  (CI scope, per-worker memory sizing, split structure) converged on a
  local-only design with per-target measured memory sizing before any file
  was touched.
- **`bin/print-eslint-concurrency.mjs`'s core logic was correct on the first
  implementation** — live-verified against the real host profile before any
  test was written, and every case (valid target, unknown target) reproduced
  exactly in the tests afterward.
- **`test-author`'s initial dispatch was clean** — 6 tests, including a
  genuine crossover-profile case (one target CPU-bound, the other
  memory-bound on the same profile) rather than a proxy assertion, passing
  on the first pass with clean `tsc`/ESLint/prettier.
- **`pnpm verify` passed cleanly on every push** — no gate had to be
  re-run or debugged, across the implementation push and both review-fix
  pushes.
- **A `docs/adr/provenance.json` rebase conflict resolved exactly per the
  documented procedure** — two unrelated PRs merged to `main` while this
  branch was open, producing the known non-driver-covered conflict class;
  `git checkout --theirs` + `pnpm gen:adr-provenance` resolved it cleanly on
  the first attempt.

## What didn't go as planned, and why

### 1. The pre-push review missed a real bug the post-push bot caught: a percent-encoding mismatch in the entry-point guard

The pre-push `code-reviewer` pass (scoped to the same two files, run before
opening the PR) returned a clean verdict with only one Should-fix (missing
JSDoc typing, fixed immediately). After push, `claude-pr-review.yml`'s bot
found a genuine Must-fix in the same code: the entry-point guard used
`process.argv[1] === new URL(import.meta.url).pathname`, but `URL.pathname`
is percent-encoded while `process.argv[1]` is a decoded filesystem path — on
any checkout whose absolute path contains a space or non-ASCII character,
the comparison silently fails, the script prints nothing, and
`package.json`'s command substitution interpolates an empty
`--concurrency=` into the surrounding `eslint` invocation. Every other entry
point in this repo (`bin/verify-all.mjs`, `bin/bench-gates.mjs`, several
`check:*` scripts) already uses `fileURLToPath(import.meta.url)` for exactly
this reason. Fixed via `/resolving-pr-comments`.

**Why it happened:** the pre-push review verified the script's _logic_
(target validation, correct `perWorkerGiB`/`workers` field selection) but did
not independently check the entry-point guard idiom against this repo's own
established convention — a silent no-op bug in boilerplate that looks
correct at a glance (`new URL(...).pathname` reads as a reasonable path
comparison) is easy to pass over unless a reviewer specifically checks new
guard code against existing sibling scripts.

**Fix for future:** when a new `bin/**` entry point script adds a
`process.argv[1] === ...` self-invocation guard, diff it against an existing
sibling script's guard line rather than trusting that it "looks equivalent" —
`fileURLToPath(import.meta.url)` is the only correct form in this repo, and a
`URL.pathname`-based variant is a silent, encoding-dependent bug, not a
stylistic alternative.

### 2. A second review round found the fix's own error-handling conflated two different failure classes

Fixing finding #1 also touched the `catch` block's failure-handling: since
`package.json`'s command substitution discards this script's own exit
status regardless, the first fix made the `catch` fall back to writing a
safe `"1"` to stdout for _any_ error, including an unknown-`target`
validation failure. A follow-up bounded re-review (`code-reviewer`, scoped to
just the two changed files) caught that this silently degraded a real
caller/config bug (an unknown target — a typo in whichever script invokes
this) into a working `--concurrency=1` run with only a stderr line, easy to
miss, where the pre-fix behavior at least hard-failed loudly on the
malformed flag. Fixed by moving the target-validity check _before_ the
`try`/`catch`, so an unknown target still calls `process.exit(1)`, and
reserving the stdout-`"1"` fallback for genuine `detectHostProfile()`
environmental failures inside the `try`.

**Why it happened:** the first fix addressed the literal Should-fix wording
("emit a safe fallback on failure") without separating the two distinct
failure classes underneath it — an environmental read failure (transient,
safe to degrade) and a validation bug (a caller error, should stay loud).
A single `catch` handling both looked like one coherent fix but actually
weakened a legitimate existing signal.

**Fix for future:** when a `catch` block wraps more than one operation that
can fail for structurally different reasons (a caller-input validation vs. a
live-environment read), check whether each failure class actually deserves
the same recovery behavior before applying one fix uniformly — a fix that
resolves the literal wording of a finding can still reintroduce a narrower
version of the same "silent failure" problem the finding was about.

## Insights

- **A pre-push review clearing on logic can still miss a boilerplate idiom
  bug.** `code-reviewer`'s pre-push pass correctly verified `deriveBudget`
  usage, target validation, and field selection, but didn't check a new
  entry-point guard's exact syntax against this repo's established
  `fileURLToPath` convention — a post-push bot reading the identical diff
  caught it. When adding any new `bin/**` self-invocation guard, diff it
  literally against a working sibling rather than trusting it "looks
  equivalent." _(promoted → .claude/agents/code-reviewer.md)_
- **Fixing a finding's literal wording can reintroduce a narrower version of
  the same problem.** The first fix for "the catch swallows the exit status"
  correctly added a safe fallback, but applied it uniformly across two
  failure classes that deserved different treatment (an environmental
  failure vs. a caller/config validation bug) — only a targeted re-review
  scoped to the actual diff caught this. A fix's job is to resolve the
  underlying concern, not just satisfy the finding's surface wording.
- **A memory-safety design decision with real prior-incident history
  benefits from explicit scoping questions before implementation, not just
  before writing code that touches the risky path.** This task's
  `AskUserQuestion` round (CI scope / per-worker sizing / split structure)
  happened specifically because issue #734's OOM history was known going in
  — the same discipline that resolved P3.5's terse plan-doc row applies even
  more directly when the naive reading of a task ("bump the concurrency
  number") would reopen a previously-fixed incident class.
- **`docs/adr/provenance.json` rebase conflicts during an active wave are
  routine, not exceptional** — two unrelated PRs landed on `main` during
  this PR's review cycle, producing the known non-driver-covered conflict.
  `git checkout --theirs` + `pnpm gen:adr-provenance` (never trusting the
  hand-picked side as final) resolved it in under a minute, confirming the
  documented procedure holds under real concurrent-wave conditions.

The natural rule-file target for the first insight,
`.claude/rules/harness-artifacts.md`, was checked and found at its
context-budget ceiling (9982/10000 bytes per `node bin/check-context-budget.mjs`,
unchanged since the P3.5 log noted the same constraint) — same as
`.claude/rules/subagent-dispatch.md` (9971/10000). Promoted into
`.claude/agents/code-reviewer.md` instead (not context-budget-gated, ample
headroom), matching the pattern P3.5's log set for the same constraint.
