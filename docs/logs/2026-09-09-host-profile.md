# Work log — `host-profile` (2026-09-09)

This log covers slice P1 of the adaptive-host-budgeting wave: adding
`bin/lib/host-profile.mjs` (host detection + budget derivation) and
`bin/bench-gates.mjs` (a gate-timing measurement harness), with no consumer
switched over yet. It records what shipped, two review rounds against the
`claude-pr-review.yml` bot, an unrelated dependency-audit collision resolved
mid-flight by a concurrent PR, and the durable lessons.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

Merged PR #1136 (`feat: add adaptive host-profile detection and bench-gates
harness`), squash commit `ab534378`, slice P1 of the 4-slice
adaptive-host-budgeting wave (P0 done, P2/P3 remain).

Files changed: `bin/lib/host-profile.mjs` (new), `bin/bench-gates.mjs` (new),
`bin/tests/host-profile.test.ts` (new, grew from 61 to 68 across two
dispatch rounds), `bin/tests/bench-gates.test.ts` (new, 51 tests),
`bin/lib/command-catalog.mjs`, `package.json` (new `bench:gates` script),
`docs/plans/2026-09-08-adaptive-host-budgeting.md` (P1 row flipped to Done).

`detectHostProfile()` collects OS/arch/physical-vs-logical cores/SMT, memory,
swap, zram, PSI pressure, and live session count behind an injectable `io`
seam; the Linux collector is live-verified against this host, Darwin is
implemented but documented as unproven (no Mac available). `deriveBudget()`
is a pure function: prefer physical/performance cores over logical, budget =
`min(cpu-bound, memory-bound)`, and CI treats itself as a single session.
`bench-gates.mjs` times 11 named lanes via `/usr/bin/time`, reporting
wall-clock, CPU efficiency, peak RSS, and PSI deltas; `--print-budget` prints
the profile+budget with no run.

Two `claude-pr-review.yml` rounds: round 1 FAIL (1 Must-fix — a `/usr/bin/time`
parse failure silently degraded a measurement to wall-clock-only with no
warning; 3 Should-fix — an SMT-host `logicalCores` bug, `parsePressureFile`
under-validating its typedef's required fields, a bare `main()` call), all
four fixed plus one folded-in Nit (lane de-dup); round 2 PASS with `verify`
and `should-fix-ack` both green. A pre-push fan-out (`code-reviewer` +
`silent-failure-hunter` + `docs-consistency-reviewer`) before the first push
independently caught 3 more real issues (lane failures only warning instead
of failing the run, failed samples polluting the reported medians, a missing
`child.on("error", ...)` handler) — all fixed before the first push.

Gates: `pnpm verify` passed in full before the final push (typecheck, lint,
format, checks, build-exports, test — all green); `pnpm knip`,
`check:command-catalog`, `check:no-docker` clean. 119 new tests total (68 +
51), both files mutation-tested across three dispatched `test-author` rounds.

**Unrelated mid-flight collision, resolved externally**: the first push's CI
run failed `Dependency checks` (`pnpm audit --audit-level=high`) on
pre-existing `js-yaml`/`nodemailer` transitive-dependency advisories —
confirmed unrelated via an identical lockfile diff against `main`. Before
this could be escalated, PR #1138 (`fix(deps): move nodemailer and js-yaml
off open advisories`) landed on `main` and was merged into this branch by
the user, resolving the audit gate entirely; a `git pull --rebase` picked it
up cleanly with no conflicts.

Skills used: starting-work, syncing-docs (invoked twice, from both the
initial push prep and the resolving-pr-comments pass), resolving-pr-comments,
finishing-work, writing-work-logs.

Spoke incidents: 0 truncations (no `tmp/session-incidents.jsonl` present in
this checkout) / 0 stalls / 2 resumes (both `test-author` dispatches for the
initial 61-test and 51-test suites hit their 40-turn limit mid-mutation-test
and were resumed via `SendMessage` — both had already left the source
byte-identical before stopping, and both completed cleanly on resume).

Compaction events: 1 session restart/resume mid-task (evidenced by a new
session id and CLAUDE.md/context being re-read) — state was fully recovered
by re-inspecting git/PR/worktree state directly rather than trusting
recollection, per this repo's own re-verify-before-acting convention; no
figure or decision was lost. The restart's only visible side effect was
transient: two consecutive `run_in_background` gate-sequence commands exited
immediately with empty output right after the restart, resolved by switching
to a `nohup ... & disown` detached launch polled via a `Monitor` until-loop
(see divergence #1).

## What went as planned

- **The Linux host-profile collector matched real host output on the first
  live run** — `--print-budget` against this 4-core/23 GiB ARM64 host
  reported physically correct facts (4 physical cores, no SMT, zram present,
  `sessions: 1`) with no iteration needed.
- **The `check:no-docker` false positive was diagnosed and fixed inside two
  attempts** — the first fix (splitting the `docker` token in the regex
  literal) missed a second occurrence in a nearby comment; the gate's own
  local run (`pnpm check:no-docker`) caught it immediately before push.
- **Both `test-author` mutation-testing rounds left the source byte-identical**
  after every mutate/revert cycle, confirmed via `git diff --stat`.
- **The bounded re-review after the review-comment fix round came back PASS
  with zero new findings** — all five bot findings verified correct and
  complete by an independent `code-reviewer` pass.
- **The rebase past the concurrent dependency-security PR was a clean
  fast-forward-style rebase with zero conflicts**, despite touching
  `pnpm-lock.yaml` and `package.json` on both sides — ADR-0024's generated-file
  merge driver and the otherwise-disjoint diff regions meant nothing needed
  manual reconciliation.

## What didn't go as planned, and why

### 1. `run_in_background` commands silently died with empty output right after an apparent session restart

Two consecutive full gate-sequence commands (`pnpm lint && ... && pnpm
verify`), each launched via `run_in_background: true`, immediately reported
`[exited with code 1]` with zero captured output — not a real failure, no
partial log, nothing. This happened right after a system-reminder indicated
CLAUDE.md and session context had been re-read (a restart or resume), and
matches a previously-logged failure mode: a harness-level kill on
backgrounded work that can fire independent of the actual command's own
resource usage. A trivial `echo` command run the same way completed
normally, ruling out a broader background-execution outage.

**Why it happened:** Consistent with the documented pattern
(`docs/logs/2026-09-07-lefthook-shim-fail-open.md`) — the kill targets the
session's tracked background-job set as a whole around a restart/resume
boundary, not the specific command's weight.

**Fix for future:** Detach immediately rather than retrying the same
`run_in_background` call — `nohup <cmd> > <log> 2>&1 & disown`, then poll
completion via a `Monitor` until-loop watching the raw PID (`kill -0 $PID`)
rather than the harness's own background-job tracking. This worked on the
first retry and should be reached for immediately after any restart-adjacent
empty-output failure, not after a second failed retry of the tracked form.

### 2. An unrelated, pre-existing `pnpm audit` failure blocked the first push's required `verify` check

The first CI run failed a required-by-transitivity check: `verify` (a
required branch-protection context) depends on `deps` (`pnpm audit
--audit-level=high`), which failed on `js-yaml`/`nodemailer` advisories that
have nothing to do with this branch — confirmed via an identical
`pnpm-lock.yaml` diff against `main`. The `deps` job itself only ran because
this PR touched `package.json` (adding the `bench:gates` script), which
`bin/ci-changed-paths.mjs` classifies as a dependency-shaped change; the same
audit would have failed on `main` too, it simply hadn't been triggered there
recently. Before this needed escalating to the user, PR #1138 landed on
`main` fixing exactly those two packages, and the user merged `main` into
this branch, resolving it.

**Why it happened:** `pnpm audit`'s result depends on the live advisory
database at request time, not a pinned snapshot — a previously-passing
lockfile can start failing purely from a new advisory being published, with
zero code change on either side. Touching `package.json` for an unrelated
reason (a new script line) was enough to trigger a gate that a docs-only
push to `main` around the same time had not.

**Fix for future:** When a CI failure's job is one this PR's own diff can be
shown not to affect (a fresh lockfile diff against `main` is the fast
check), don't assume it's this PR's job to fix — verify whether a dependency
bump is already in flight (check open/recently-merged PRs touching the same
advisories) before deciding whether to wait, bundle a fix, or escalate.

## Lessons learned

- **A required check can be required only transitively, via a `needs:`
  aggregator job — read the workflow file, not just branch protection's
  literal context-name list.** `pnpm audit`'s own job (`Dependency checks`)
  is NOT itself in `required_status_checks.contexts`, but the required
  `verify` job's `needs:` list includes it, so its failure blocks merge all
  the same. `gh api repos/.../branches/main/protection` alone would have
  under-stated the actual blocking surface.
- **A harness-level kill on backgrounded work near a session
  restart/resume boundary can recur across the very next retry of the
  identical command, not just occasionally.** Don't retry the tracked
  `run_in_background` form a second time after one restart-adjacent empty
  failure — go straight to the detached `nohup ... & disown` + `Monitor`
  pattern. _(This generalizes an existing entry rather than a new one — see
  `docs/logs/2026-09-07-lefthook-shim-fail-open.md`; not re-promoted here.)_
- **`git ci-changed-paths` classification can trigger a gate on an
  incidental file touch, not just a deliberate one.** Adding one
  `package.json` script line was enough to run the full `pnpm audit`
  gate on a PR that changed no dependency at all — worth remembering when a
  small, unrelated-looking edit suddenly pulls in a heavier CI lane.
- **Bundling multiple review-fan-out passes (pre-push spokes, then the bot's
  own two rounds) each caught genuinely different, non-overlapping issues.**
  The pre-push `silent-failure-hunter` found 3 issues the bot's own review
  round later found a 4th, overlapping-in-kind but distinct-in-detail issue
  for (the parse-failure swallow) — confirming these are complementary
  passes reading different artifacts, not redundant ones, exactly as
  `resolving-pr-comments`' own boundary rules already state.

Sweep-cadence check: `grep -l "promoted →" docs/logs/*.md | wc -l` shows the
most recent promotion stamp lands in
`docs/logs/2026-09-08-earlyoom-process-matching.md`; only 1 log
(`2026-09-09-dependabot-trivy-alerts.md`) plus this one has landed since —
under the 5-log threshold, so no `/promoting-work-log-lessons` sweep
recommended yet.
