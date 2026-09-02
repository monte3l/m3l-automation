# Work log — X8 slice 1, the telemetry rollup store (2026-09-03)

This log covers slice 1 of tracker row **X8 — self-telemetry + retention**: the
ADR-0070 telemetry store foundation, built through the hub-and-spoke TDD
pipeline and landed as PR [#917](https://github.com/monte3l/m3l-automation/pull/917)
(squash `c5bce197`). It records what shipped, what matched the `starting-work`
gate's plan, the eight divergences — three of which were wrong claims in my own
contract — and the durable lessons.

## Summary

Migration **v9** creates `console_telemetry_rollup`, and
`M3LConsoleTelemetryRepository` binds onto `M3LConsoleStoreUnit` as
`telemetry`, beside `meta`/`runs`/`sessions`/`audit`. No instrumentation, no
query endpoints, no retention policy — those are slices 2–5.

**Public symbols (10):** `M3LConsoleTelemetryRepository`,
`M3LTelemetryMeasurement` (a discriminated union on `metric`),
`M3LTelemetryBucket`, `M3LTelemetryQuery`, `M3LTelemetryPruneRequest`,
`M3LTelemetryMetric`, `M3LTelemetryGranularity`,
`createConsoleTelemetryRepository`, `telemetryBucketStartMs`,
`CREATE_CONSOLE_TELEMETRY_ROLLUP_TABLE`.

**Schema decision:** rollup buckets, not raw events. ADR-0070 names age-based
**rollup** as _the_ telemetry retention policy and scopes the feature to
"SQLite-grade aggregation, not an APM platform", so bounded growth is a
property of the schema rather than a slice-5 addition. Accepted cost, recorded
as a decision: averages and a max, never percentiles, without a v10.

**Tests:** 198 → 199 across the three telemetry suites; 15,237 in the default
config, plus 2,951 (`bin`), 260 (`web`), 34 (`integration`).
`store/telemetry-repository.ts` and `store/telemetry-validation.ts` both at
**100% statements, functions and branches**.

**Gates:** `pnpm verify` 57 passed / 10 skipped / 0 failed. All 17 CI checks
green. `check:review-size` warned at 174,175 chars (over the 75,000 soft
target, under the 300,000 ceiling) — deliberately not split, justified in the
PR body.

**File budget:** the fixes pushed `telemetry-repository.ts` to 25,453 of
25,000; the paying extraction into `telemetry-validation.ts` landed it at
16,486 + 11,086.

**Review:** `claude-pr-review` verdict **PASS**, no Must-fix, three Should-fix
and four Nits. Pre-push spokes — `silent-failure-hunter`,
`type-design-analyzer`, `code-reviewer` — found seven defects between them,
all fixed before merge.

Skills used: writing-commits, creating-prs, finishing-work, writing-work-logs.
(The `starting-work` gate that authorised this slice ran in the prior session.)

Spoke incidents: 5 truncations / 0 stalls / 8 resumes. No
`tmp/session-incidents.jsonl` existed, so these are from session recollection,
not the mechanical log.

Compaction events: none.

## What went as planned

- **The schema was measured before it was written.** Every DDL constraint and
  the upsert SQL were probed against a real `node:sqlite` `:memory:` database
  before any spoke saw them — 8 legal row shapes accepted, 19 illegal ones
  rejected, plus `EXPLAIN QUERY PLAN` confirming both the prune and the
  time-ranged list hit the PK prefix. A shipped migration cannot be edited in
  place, so this front-loading was the single highest-value step.
- **RED failed for the right reason** — `Cannot find module
'../src/store/telemetry-repository.js'`, not a logic error in the tests.
- **The repository/validation split held.** `check:zones` reported 39 zones
  intact and `knip` found no unused exports, so the byte-budget extraction did
  not cut through a cohesive unit.
- **The hook layer behaved exactly as documented.** `guard-branch-isolation`
  allowed writes into the linked worktree while the session sat on `main`;
  `guard-hub-src-writes` blocked the hub and admitted `code-implementer`. Both
  were verified by piping payloads rather than assumed.
- **`worktree:new` sidestepped a stale local `main`** by branching from
  `origin/main`, exactly as the gate predicted — which turned out to matter far
  more than expected (divergence 6).

## What didn't go as planned, and why

### 1. My contract claimed a type guarantee the type did not enforce

The contract told both spokes that a discriminated union on `metric` makes
illegal dimension pairings "unrepresentable at the call site", and that claim
was copied into the module's TSDoc. `type-design-analyzer` showed it was
false: each arm merely _omitted_ the dimensions it must not carry, and
TypeScript's excess-property check only applies to fresh object literals. A
variable defeated it — `const m = { metric: "sse.stream", route: "/x" };
record(m)` compiled, and the foreign dimension was **silently discarded**,
because the `recordX` helpers hardcode `""`. The 91 tests passed throughout,
because `expectTypeOf<SseStream>().not.toExtend<{ route: string }>()` is
structurally true while saying nothing about what a caller can pass.

**Why it happened:** I reasoned about the union's _shape_ rather than about
assignability, and never compile-tested the adversarial case. The correct
pattern was in the same directory the whole time —
`audit-repository-types.ts:89` writes `readonly scriptName?: undefined` on the
non-`script` arm.

**Fix for future:** A union arm that must not carry a field needs an explicit
`?: undefined`, not an omission. And any claim that a type makes something
unrepresentable must be proven with a compile check on the _variable_ case,
not the literal case.

### 2. The mandatory-measure CHECK omitted a value-bearing metric

My DDL required a measure for `http.request` and `run.finished` but not for
`store.health`, which is equally value-bearing (its type arm requires
`valueBytes`). `code-reviewer` found it and I confirmed it against the shipped
DDL: a `store.health` row with all three measures `NULL` inserted cleanly, no
CHECK fired. The documented three-layer defense had two layers for that metric.

**Why it happened:** I made the constraint one-directional on purpose, so the
two pure counters could gain a measure later without a table recreate — and
then put `store.health` on the wrong side of that split. Worse, my own
19-case matrix tested `store.health` **with** a measure and never without one,
and a comment asserting the table had "11 CHECKs" (it has 14, counted
programmatically) made "every CHECK is tested" look true while three were
unexamined.

**Fix for future:** For a CHECK with a metric/kind allow-list, enumerate every
member of the vocabulary against the constraint and write the illegal case for
each — a count in a comment that nothing verifies is not evidence. Editing was
only possible because v9 had not shipped; the same finding one merge later
costs a v10 table recreate.

### 3. `list()` shipped with no `ORDER BY` at all

`list(query)` had no ordering clause, so which rows a `limit` retained was
unspecified. The "limit truncates the result set" test passed because it only
asserted a length, and the port's TSDoc documented the `@throws` cases while
saying nothing about order.

**Why it happened:** The contract specified filters and a limit but never named
an ordering, so neither spoke had a contract to satisfy and the gap fell
between them.

**Fix for future:** A query method that takes a `limit` must have its ordering
in the contract — an unordered `limit` is a silent correctness bug, not a
style question. Fixed as `bucket_start_ms DESC` plus the PK suffix as a total
tiebreak.

### 4. Five validation guards could be bypassed at the cast boundary

`silent-failure-hunter` found: `requireAligned` indexed the width table with no
membership check, so a cast-bypassed granularity threw a raw `TypeError` that
`classifyStoreFailure` reported as `ERR_CONSOLE_STORE_QUERY_FAILED` — blaming
the store for a caller's bad input; `prune` validated nothing, so a bad
granularity deleted zero rows and returned `0`, indistinguishable from "nothing
was old enough"; `list` accepted an unvalidated `granularity`/`metric` and
returned `[]` for a typo; `outcome` was never checked non-empty on the two
metrics where it is required; and `recordAll` dropped the partial-failure count
that `audit-repository.ts` treats as load-bearing.

**Why it happened:** The contract said "mirror `audit-repository.ts`" without
enumerating _which_ guards that implies, so the spoke mirrored the structure
and not the coverage.

**Fix for future:** When a contract says "mirror module X", list X's guards
explicitly. The threat model is an untyped caller reaching past the type system
via a cast — which `audit-repository.ts` states in its own TSDoc and is the
whole reason its guards exist.

### 5. Five writer-spoke truncations at the 40-turn ceiling

Every writer spoke on this slice hit its `maxTurns` ceiling at least once — the
RED author once, the GREEN implementer once, the fix implementer once, and the
guard-test author twice. Each cost a `SendMessage` resume; eight resumes total.
Two truncated with the work essentially complete ("ESLint clean. Run the full
checks one last time"), so the hub verified on disk and ran the remaining gates
itself rather than paying another 40-turn round.

**Why it happened:** The briefs were large — the slice-1 contract alone was
14,695 chars — and each spoke was asked to write, run tests, typecheck, lint
_and_ format-check. The gate-running tail is what consumed the turns.

**Fix for future:** Give a writer spoke the writing and one verification loop;
keep `typecheck`/`lint`/`format:check` at the hub, which can run them without
spending spoke turns. When a truncated report shows the files on disk and only
gates remaining, verify and finish at the hub instead of resuming.

### 6. An upstream history rewrite made a plain rebase destructive

Mid-session, `main` was rewritten upstream (the Claude-Session trailer
removal, PRs #909/#910/#912). Our base `83902b9d` no longer existed there — it
had become
`e0e92dcb` — so the merge-base collapsed to a commit from #406 and
`git rev-list --left-right` reported **353 ahead / 360 behind** for a
two-commit branch. `git rebase origin/main` would have replayed 353 commits,
351 of them duplicates of rewritten upstream history.

Separately, the shared checkout's local `main` was 350 commits of obsolete
pre-rewrite history; `git pull` refused with "Need to specify how to reconcile
divergent branches". All 350 local-only commits were verified to have upstream
subject twins before a `--hard` reset.

**Why it happened:** A history rewrite invalidates every base SHA and every
remote-tracking ref in every existing checkout and worktree, and nothing warns
you — the symptom is an absurd ahead/behind count.

**Fix for future:** An implausible ahead/behind count on a small branch means
the base was rewritten, not that the branch diverged. Rebase with
`git rebase --onto origin/main <old-base>` to replay only your own commits, and
verify a stale local `main` has no unique commits (subject-twin check) before
resetting it.

### 7. An in-place migration edit tripped SCHEMA_DRIFT on a persisted local index

After widening the v9 CHECK, six tests in `tests/main.test.ts` — a file this
branch never touched — failed with `ERR_CONSOLE_STORE_SCHEMA_DRIFT`. The
worktree's `data/console/console.sqlite` still recorded v9 at the pre-edit
digest. The drift guard was working exactly as designed; the stale index was
the problem. Moving it aside (leaving the `audit/` JSONL trail intact, per
ADR-0069's "sqlite only indexes authoritative JSONL") restored 51/51.

**Why it happened:** Editing an already-applied migration changes its digest,
and `tests/main.test.ts` opens a store against the **real** default
`data/console/` directory rather than a temp dir — the only store test that
does.

**Fix for future:** After any in-place edit to an unshipped migration, drop the
local `data/console/console.sqlite` before running the suite. The
`tests/main.test.ts` dependence on the real data directory is a genuine
test-isolation defect and is filed as a follow-up.

### 8. A backgrounded `pnpm verify` misreported its exit code

A full `pnpm verify` exceeds the 10-minute tool ceiling, so it must be detached
(`setsid nohup … & disown`). Worse, the harness reported **exit 0** for a
backgrounded run whose log recorded `REAL_EXIT=1`; had that been trusted,
slice 1 would have been reported verified while ESLint had died and **56 of 67
steps never ran** (`verify` stops at the first failure without `--continue`).
ESLint itself needs `NODE_OPTIONS=--max-old-space-size=6144` on this host or it
dies at the ~2 GB default with "Ineffective mark-compacts near heap limit".

**Why it happened:** Backgrounded exit codes are unreliable, and `verify`'s
fail-fast means a single early failure hides the entire remaining battery.

**Fix for future:** Always write `REAL_EXIT=$?` into the log and read that, never
the harness's status. Detach any run that can exceed ten minutes.

## Lessons learned

- **Prove a type guarantee, don't reason about it.** A union arm that omits a
  foreign field only rejects fresh object literals; a variable assigns fine.
  Write `?: undefined` on every arm that must not carry a field, and
  compile-test the variable case before claiming anything is unrepresentable.

- **Re-derive your own authored claims, not just other people's.** Three of
  this slice's eight divergences were wrong statements in my own contract — the
  type guarantee, the "11 CHECKs" count (actually 14), and a measure
  requirement that skipped a value-bearing metric. The repo's rule to
  re-derive an authored claim applies hardest to the claim you wrote an hour
  ago and now treat as settled.

- **Enumerate the vocabulary when testing an allow-list CHECK.** For a
  constraint keyed on a closed set, write the illegal case for _every_ member.
  An "N constraints, all tested" claim is only as good as a programmatic count
  of N.

- **A `limit` without a documented order is a correctness bug.** Specify
  ordering in the contract for any query method that truncates, or the spokes
  will each assume the other owns it and neither will.

- **"Mirror module X" is not a contract.** Name X's guards, its partial-failure
  semantics, and its threat model explicitly, or you get X's structure without
  X's coverage.

- **Keep gate-running at the hub, not in the writer spoke.** Every writer spoke
  here truncated at 40 turns, and the gate tail is what consumed them. Two
  finished-but-truncated spokes were cheaper to complete at the hub than to
  resume.

- **An implausible ahead/behind count means a rewritten base.** 353 ahead on a
  two-commit branch is not divergence; it is a history rewrite. Use
  `rebase --onto origin/main <old-base>` and subject-twin-verify a stale local
  `main` before resetting it.
  _(promoted → .claude/skills/resolving-merge-conflicts/SKILL.md)_

- **Never trust a backgrounded command's reported exit code.** Write
  `REAL_EXIT=$?` into the log. A harness-reported exit 0 concealed a real
  exit 1 with 56 of 67 verify steps unrun.

- **Mechanical gates do not catch under-constrained constraints.** 57 verify
  steps and 15,237 tests passed over a dead CHECK, five bypassable guards, an
  unordered `limit`, and an overstated type claim. Every one was found by a
  reviewer reasoning about behaviour — which is the argument for running the
  review spokes _before_ pushing, while the findings are still cheap.

- **Measure the file before the edit that grows it.** The fixes took
  `telemetry-repository.ts` 453 chars over the ceiling, and the spoke's first
  instinct was to trim TSDoc — buying 90 chars by spending the file's most
  valuable content. The extraction bought 8,500.
